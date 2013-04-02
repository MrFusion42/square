'use strict';

/**!
 * [square]
 * @copyright (c) 2012 observe.it (observe.it) <opensource@observe.it>
 * MIT Licensed
 */
var canihaz = require('canihaz')('square')
  , async = require('async')
  , _ = require('lodash')
  , url = require('url')
  , request = require('request')
  , fs = require('fs');

/**
 * Semver compatible regexp.
 *
 * @type {RegExp}
 * @api private
 */
var semver = [
    "\\s*[v=]*\\s*([0-9]+)"             // major
  , "\\.([0-9]+)"                       // minor
  , "\\.([0-9]+)"                       // patch
  , "(-[0-9]+-?)?"                      // build
  ,  "([a-zA-Z-][a-zA-Z0-9-\\.:]*)?"    // tag
];

semver = new RegExp(semver.join(''), 'gim');

/**
 * Because not all versions are semver compatible
 * we need a silly fall back:
 *
 * @type {RegExp}
 * @api private
 */
var sillyver = [
    "\\s*[v=]*\\s*(\\d)"                // major
  , "\\.([\\d][-\\s]?)"                 // minor
  , "(?:([a-zA-Z-][a-zA-Z0-9-.:]*)?)?"  // silly
];

sillyver = new RegExp(sillyver.join(''), 'gim');

/**
 * Regexp to test for Github hash sources
 *
 * @type {RegExp}
 * @api private
 */
var githubRE = /github.com\/([\w\.\-]+)\/([\w\.\-]+)\/blob(\/[\w\.\-]+)\/(.*)/;

/**
 * Constructor for updating third party modules.
 *
 * Options:
 * - strict: regexp, regexp for search for semver based version numbers
 * - loose: regexp, fall back for strict regexp, for oddly versioned code
 * - lines: number, amount of LOC to scan for version numbers
 *
 * @constructor
 * @param {object} square instance
 * @api public
 */

function Update(square) {
  this.strict = semver;
  this.loose = sillyver;
  this.lines = 10;
  this.square = square;

  // setup the configuration based on the plugin configuration
  /*var configuration = _.extend(
      settings
    , this.package.configuration.plugins.update || {}
  );*/
}

Update.prototype.disregard = function disregard() {
  this.emit('disregard');
};

/**
 * The actual processing of third party modules.
 *
 * @api public
 */
Update.prototype.execute = function execute(fn) {
  var bundles = this.square.package.bundle
    , files = Object.keys(bundles)
    , self = this;

  // edge case: if package isn't loaded from file, there is nothing to write.
  if (!this.square.package.path) return;

  async.forEach(files, function testing (key, cb) {
    var bundle = bundles[key]
      , provider;

    // Not a third party file.
    if (!bundle.latest) return cb();

    // Find the correct update handler.
    if (~bundle.latest.indexOf('#')) provider = self.selector;
    if (githubRE.test(bundle.latest)) provider = self.github;
    if (!provider) provider = self.req;

    provider(bundle.latest, function test (err, version, content) {
      if (err) return cb(err);
      if (!version) return cb(new Error('unable to find and parse the version for ' + key));
      if (version === bundle.version) return cb();

      self.square.logger.notice(
          '%s is out of date, latest version is %s'
        , key
        , version.green
      );

      /**
       * Handle file upgrades.
       *
       * @param {Mixed} err
       * @param {String} content
       * @api private
       */
      function done(err, content) {
        if (err) return cb(err);

        var code = JSON.parse(self.square.package.source)
          , current = bundle.version
          , source;

        code.bundle[key].version = version;
        bundle.version = version;
        bundle.content = content;

        // now that we have updated the shizzle, we can write a new file
        // also update the old source with the new version
        source = JSON.stringify(code, null, 2);
        self.square.package.source = source;

        try {
          fs.writeFileSync(self.square.package.location, source);
          fs.writeFileSync(bundle.meta.location, content);
        } catch (e) { err = e; }

        self.square.logger.notice(
            'sucessfully updated %s from version %s to %s'
          , key
          , current.grey
          , version.green
        );

        cb(err);
      }

      if (content) return done(undefined, content);

      // find the correct location where we can download the actual source
      // code for this bundle
      var data = bundle.download || provider === self.github
        ? self.raw(bundle.latest)
        : bundle.latest;

      self.download(data, done);
    });
  }, function finished(err, data) {
      if (err && err.forEach) {
        err.forEach(function failed (err) {
          self.logger.error(err);
        });
      }
  });
};

/**
 * Transforms a regular git url, to a raw file location.
 *
 * @param {String} uri
 * @returns {String}
 * @api private
 */
Update.prototype.raw = function raw(uri) {
  var user, repo, branch, file
    , chunks = githubRE.exec(uri);

  user = chunks[1];
  repo = chunks[2];
  branch = chunks[3].substr(1); // remove the first /
  file = chunks[4];

  return 'https://raw.github.com/' + user + '/' + repo + '/' + branch + '/'+ file;
};

/**
 * Download the data.
 *
 * @param {String} uri
 * @param {Function} fn
 * @api private
 */
Update.prototype.download = function download(uri, fn) {
  request.get(uri, function requested(err, res, body) {
    if (err) return fn(err);
    if (res.statusCode !== 200) return fn(new Error('Invalid status code'));

    fn(null, body.toString('utf8'));
  });
};

/**
 * Find the version number on a page based on a CSS3 selector
 *
 * @param {Object} uri
 * @param {Function} fn
 * @api private
 */
Update.prototype.selector = function selector(uri, fn) {
  var parts = uri.split('#')
    , url = parts.shift()
    , css = parts.join('#'); // restore '##id' selectors

  canihaz.cheerio(function (err, cheerio) {
    if (err) return fn(err);

    console.log(cheerio.load(uri)(css).text());
    // call fn
  });
};

/**
 * See if the string matches a version number.
 *
 * @param {String} content
 * @returns {Mixed}
 * @api private
 */
Update.prototype.version = function version(content) {
  var result;

  // a "feature" of calling exec on a regexp with a global flag is that it
  // renders it useless for new calls as it will do checks based on the new
  // matches. We can bypass this behavior by recompiling regexps
  [
      new RegExp(this.strict.source)
    , new RegExp(this.loose.source)
  ].some(function some (regexp) {
    var match = regexp.exec(content);

    if (match && match.length) {
      result = [
          match[1] ? match[1].trim() : 0
        , match[2] ? match[2].trim() : 0
        , match[3] ? match[3].trim() : 0
      ].join('.');
    }

    return !!result;
  });

  return result;
};

/**
 * Find the version number based on a SHA1 commit
 *
 * @param {Object} uri
 * @param {Function} fn
 * @api private
 */
Update.prototype.github = function github(uri, fn) {
  var user, repo, branch, file
    , chunks = githubRE.exec(uri);

  user = chunks[1];
  repo = chunks[2];
  branch = chunks[3].substr(1); // remove the first /
  file = chunks[4];

  canihaz.github(function lazyload (err, Github) {
    if (err) return fn(err);

    var api = new Github({ version: "3.0.0" })
      , request = { user: user, repo: repo, path: file, sha: branch };

    api.repos.getCommits(request, function getcommit (err, list) {
      if (err) return fn(err);
      if (!list.length) return fn(new Error('No commits in this repo: ' + uri));

      var commit = list.shift();
      fn(null, commit.sha);
    });
  });
};

/**
 * Find the version number somewhere in the first x lines
 *
 * @param {Object} uri
 * @param {Function} fn
 * @api private
 */

Update.prototype.req = function req(uri, fn) {
  var lines = this.lines
    , version = this.version;

  this.download(uri, function downloading(err, content) {
    if (err) return fn(err);
    if (!content) return fn(new Error('No content received from ' + uri));

    lines = content.split(/(\r\n)|\r|\n/).splice(0, lines);
    lines.some(function someline (line) {
      version = version(line);

      return !!version;
    });

    fn(null, version, content);
  });
};

/**
 * Expose the module
 */
module.exports = Update;