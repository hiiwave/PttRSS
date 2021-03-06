'use strict';

let debug = require('debug')('rss:ptt:index');
let express = require('express');
let NodeCache = require('node-cache');
let Promise = require('bluebird');
let RSS = require('rss');
let router = express.Router();
let cache = new NodeCache({ stdTTL: 60 * 5, checkperiod: 0 });
let articleCache = new NodeCache({ stdTTL: 60 * 60, checkperiod: 0 });
let getArticlesFromLink = require('ptt').getArticlesFromLink;
let getArticleFromLink = require('ptt').getArticleFromLink;

function matchTitle(article, keywords) {
  for (var index = 0; index < keywords.length; index++) {
    if (article.title.toLowerCase().indexOf(
        keywords[index].toLowerCase()) !== -1) {
      debug('title: %s matched keyword: %s', article.title, keywords[index]);
      return true;
    }
  }

  debug('title: %s not matched any keywords: %s', article.title, keywords);
  return false;
}

function filterArticles(articles, keywords, exclude=false) {
  return articles.filter((article) => exclude ^ matchTitle(article, keywords));
}

function generateRSS(data, fetchContent) {
  fetchContent = (fetchContent === true);
  let articles = data.articles;
  let feed = new RSS({
    title: data.board,
    description: 'PTT: ' + data.board,
    link: 'https://www.ptt.cc',
    site_url: data.siteUrl,
    generator: 'PttRSS',
    pubDate: new Date(),
  });

  // filter by title keywords
  if (data.titleKeywords && data.titleKeywords.length > 0) {
    articles = filterArticles(data.articles, data.titleKeywords);
  }

  if (data.exTitleKeywords && data.exTitleKeywords.length > 0) {
    debug(data.exTitleKeywords);
    articles = filterArticles(data.articles, data.exTitleKeywords, true);
  }

  // filter by push counts
  articles = articles.filter(article => article.push > data.push);

  if (fetchContent === false) {
    return new Promise((resolve, reject) => {
      articles.forEach((articleMeta) => {
        feed.item(articleMeta);
      });
      resolve(feed);
    });
  }

  return Promise.map(articles, (articleMeta) => {
    let article = articleCache.get(articleMeta.url);
    if (article) {
      debug('cached article: %s', article.title);
      feed.item(article);
      return;
    }

    return getArticleFromLink(articleMeta.url)
      .then(article => {
        article = Object.assign(articleMeta, article);
        feed.item(article);
        debug('set cache article: %s', article.title, article.url);
        articleCache.set(article.url, article);
        return;
      })
      .delay(100);

  }, { concurrency: 3 }).then(() => Promise.resolve(feed));
}

router
  .get('/:board\.xml', (req, res, next) => {
    if (!req.params.board) return next(Error('Invaild Parameters'));

    const board = req.params.board.toLowerCase();
    const siteUrl = 'https://www.ptt.cc/bbs/' + board + '/index.html';
    const push = req.query.push || -99;
    const minArticleCount = req.query.minArticleCount || 50;
    const cachedKey = req.originalUrl;
    const fetchContent = req.query.fetchContent === 'true';
    let titleKeywords = req.query.title || [];
    if (!Array.isArray(titleKeywords)) {
      titleKeywords = [titleKeywords];
    }

    let exTitleKeywords = req.query.extitle || [];
    if (!Array.isArray(exTitleKeywords)) {
      exTitleKeywords = [exTitleKeywords];
    }

    // Get from cache first
    const obj = cache.get(cachedKey);
    if (obj) {
      return generateRSS({
        siteUrl: siteUrl,
        board: board,
        articles: obj.articles,
        titleKeywords,
        exTitleKeywords,
        push: push,
      }, fetchContent)
      .then((feed) => {
        debug('cached board: %s', board, cachedKey);
        res.set('Content-Type', 'text/xml');
        return res.send(feed.xml());
      })
      .catch((err) => next(err));
    }

    let response = function response(articles) {
      debug('set cache board: %s', board, cachedKey);
      cache.set(
        cachedKey,
        { articles: articles }
      );

      return generateRSS({
        siteUrl,
        board,
        articles,
        titleKeywords,
        exTitleKeywords,
        push,
      }, fetchContent);
    };

    let articles = [];
    let getArticles = function (data) {
      if (!data.articles) throw Error('Fetch failed');

      articles = articles.concat(data.articles);
      if (articles.length < minArticleCount) {
        debug('get more articles, current count: %s', articles.length);
        return getArticlesFromLink(data.nextPageUrl)
          .then(data => getArticles(data));
      }

      return Promise.resolve(articles);
    };

    // Start crawling board index
    getArticlesFromLink(siteUrl)
      .then(data => getArticles(data))
      .then(articles => response(articles))
      .then(feed => {
        res.set('Content-Type', 'text/xml');
        res.send(feed.xml());
        return;
      })
      .catch(err => next(err));
  });

module.exports = {
  router,
};
