'use strict';

var path = require('path'),
    util = require('util'),
    EventEmitter = require('events').EventEmitter,
    request = require('request'),
    _ = require('lodash'),
    cheerio = require('cheerio'),
    fs = require('fs'),
    crypto = require('crypto'),
    Pool = require('generic-pool').Pool,
    charsetParser = require('charset-parser'),
    Bottleneck = require('bottleneck'),
    seenreq = require('seenreq');

var version = '0.7.12';
var logger = null;
// Fallback on iconv-lite if we didn't succeed compiling iconv
// https://github.com/sylvinus/node-crawler/pull/29
var iconv, iconvLite;
try {
    iconv = require('iconv').Iconv;
} catch (e) {}

if (!iconv) {
    iconvLite = require('iconv-lite');
}

function md5 (str) {
    var crypto_md5 = crypto.createHash('md5');
    crypto_md5.update(str, 'utf8');
    return crypto_md5.digest('hex');
}

function checkJQueryNaming (options) {
    if ('jquery' in options) {
        options.jQuery = options.jquery;
        delete options.jquery;
    }
    return options;
}

function readJQueryUrl (url, cb) {
    if (url.match(/^(file:\/\/|\w+:|\/)/)) {
        fs.readFile(url.replace(/^file:\/\//, ''), 'utf-8', function(err, jq) {
            cb(err, jq);
        });
    } else {
        cb(null, url);
    }
}

function Crawler (options) {
    var self = this;
    self.init(options);
}
// augment the prototype for node events using util.inherits
util.inherits(Crawler, EventEmitter);

Crawler.prototype.init = function init (options) {
    var self = this;

    var defaultOptions = {
        forceUTF8:              false,
        gzip:                   true,
        incomingEncoding:       null, //TODO remove or optimize
        jQuery:                 true,
        maxConnections:         10,
        bottleneckConcurrent:   10000,
        method:                 'GET',
        onDrain:                false,
        priority:               5,
        priorityRange:          10,
        rateLimits:             0,
        referer:                false,
        retries:                3,
        retryTimeout:           10000,
        timeout:                15000,
        skipDuplicates:         false,
        ua:                     'WebCrawler/' + version,
        rotateUA:               false,
        download:               false //file path or false
    };

    //return defaultOptions with overridden properties from options.
    self.options = _.extend(defaultOptions, options);

    // you can use jquery or jQuery
    self.options = checkJQueryNaming(self.options);

    if (self.options.rateLimits !== 0 && self.options.maxConnections == 1) {
        //self.options.limiter = "default";
    } else {
        //self.limiters = null;//self.options.maxConnections = 1;
    }

    // Don't make these options persist to individual queries
    self.globalOnlyOptions = ['maxConnections', 'priorityRange', 'onDrain'];

    //Setup a worker pool w/ https://github.com/coopernurse/node-pool
    self.pool = new Pool({
        name         :  'crawler',
        max          :  self.options.maxConnections,
        min          :  self.options.minConnections,
        log          :  self.options.debug && self.options.logger && function () { self.options.logger.log(arguments[1], arguments[0]); },
        priorityRange:  self.options.priorityRange,
        create       :  function(cb) {
            cb(new Object());
        },
        destroy      : function() {}
    });

    self.limiters = new Bottleneck.Cluster(self.options.bottleneckConcurrent, self.options.rateLimits);
    self.plannedQueueCallsCount = 0;
    self.queueItemSize = 0;
    self.seen = new seenreq();
    self.debug = self.options.debug || false;
    self.mapEntity = Object.create(null);
    self.entityList = ["jar"];
    logger = self.options.logger || console;

    self.on('pool:release', function (options) {
        self._release(options);
    });

    self.on('request', function (options) {
        if (_.isFunction(self.options.preRequest)) {
            self.options.preRequest(options);
        }
    });

    self.on('pool:drain', function () {
        if (self.options.onDrain) {
            self.options.onDrain.call(self, self.pool);
        }
    });
};

Crawler.prototype._release = function _release (options) {
    var self = this;

    self.queueItemSize--;
    if (options._poolReference) {
        if (self.debug) {
            logger.info("Releasing resource, limiter:%s", options.limiter || "default");
        }
        self.pool.release(options._poolReference);
    }

    // Pool stats are behaving weird - have to implement our own counter
    if (self.queueItemSize + self.plannedQueueCallsCount === 0) {
        self.emit('pool:drain');
    }
};

Crawler.prototype._inject = function _inject (response, options, cb) {
    var $;
    var self = this;

    if (options.jQuery === true || options.jQuery === 'cheerio' || options.jQuery.name === 'cheerio') {
        var defaultCheerioOptions = {
            normalizeWhitespace: false,
            xmlMode: false,
            decodeEntities: false
        };
        var cheerioOptions = options.jQuery.options || defaultCheerioOptions;
        $ = cheerio.load(response.body, cheerioOptions);
        cb(null, $);
    } else if (options.jQuery.jsdom) {
        var jsdom = options.jQuery.jsdom;
        var scriptLocation = path.resolve(__dirname, '../vendor/jquery-2.1.1.min.js');

        //Use promises
        readJQueryUrl(scriptLocation, function(err, jquery) {
            try {
                jsdom.env({
                    url: options.uri,
                    html: response.body,
                    src: [jquery],
                    done: function (errors, window) {
                        $ = window.jQuery;
                        cb(errors, $);

                        try {
                            window.close();
                            window = null;
                        } catch (err) {
                            logger.error(err);
                        }

                    }
                });
            } catch (e) {
                options.callback(e);
                self.emit('pool:release', options);
            }
        });
    } else { // jQuery is set to false are not set
        cb(null);
    }
};

Crawler.prototype.queue = function queue (options) {
    var self = this;

    // Did you get a single object or string? Make it compatible.
    options = _.isArray(options) ? options : [options];

    options = _.flattenDeep(options);

    for(var i = 0; i < options.length; ++i) {
        if(_.isNull(options[i]) || _.isUndefined(options[i]) || (!_.isString(options[i]) && !_.isPlainObject(options[i]))) {
            if(self.debug) {
                logger.warn("Illegal queue option: ", JSON.stringify(options[i]));
            }
            continue;
        }
        self._pushToQueue(
            _.isString(options[i]) ? {uri: options[i]} : options[i]
        );
    }
};

Crawler.prototype._pushToQueue = function _pushToQueue (options) {
    var self = this;
    self.queueItemSize++;

    // you can use jquery or jQuery
    options = checkJQueryNaming(options);

    _.defaults(options, self.options);

    // Remove all the global options from our options
    // TODO we are doing this for every _pushToQueue, find a way to avoid this
    _.each(self.globalOnlyOptions, function (globalOnlyOption) {
        delete options[globalOnlyOption];
    });

    // If duplicate skipping is enabled, avoid queueing entirely for URLs we already crawled
    if (options.skipDuplicates && self.seen.exists(options)) {
        return self.emit('pool:release', options);
    }

    if (options.url && !options.uri) {
        options.uri = options.url;
    }

    // acquire connection - callback function is called
    // once a resource becomes available
    var acquired = function (error, poolReference) {
        options._poolReference = poolReference;

        // this is an operation error
        if (error) {
            logger.error(error);
            options.callback(error);// need release
            return self.emit('pool:release', options);
        }

        if (self.debug) {
            logger.info("Acquired resource, limiter:%s, uri:%s", options.limiter || "default", options.uri);
            logger.info("pool queue size:%s, waiting size:%s, bottleneck '%s' queue size:%s", self.queueSize, self.waitingCount, options.limiter||"default", self.limiters.key(options.limiter||"default")._queues.length);
        }

        //Static HTML was given, skip request
        if (options.html) {
            self._onContent(options, {body: options.html});
        } else if (typeof options.uri === 'function') {
            options.uri(function (uri) {
                options.uri = uri;
                self._makeCrawlerRequest(options);
            });
        } else {
            self._makeCrawlerRequest(options);
        }
    };

    var limitedAcquire = function (priority, cb) {
        if (self.debug) {
            logger.info("Called by bottleneck, limiter:%s, uri:%s", options.limiter || "default", options.uri);
        }
        return self.pool.acquire(cb, priority);
    };

    self.limiters.key(options.limiter || "default").submit(limitedAcquire, options.priority, acquired);
};

Crawler.prototype._makeCrawlerRequest = function _makeCrawlerRequest (options) {
    var self = this;
    self._buildHttpRequest(options);
};

Crawler.prototype._deleteEntity = function _deleteEntity(options){
    var self = this;
    this.entityList.forEach(function(name){
        if(typeof options[name] == "object"){
            self.mapEntity[name] = options[name];
            delete options[name];
        }
    })
};

Crawler.prototype._attachEntity = function _attachEntity(options){
    var self = this;
    return this.entityList.reduce(function(target,name){
        if(typeof self.mapEntity[name] == "object")
            target[name] = self.mapEntity[name];

        return target;
    }, options);
};

Crawler.prototype._buildHttpRequest = function _buildHTTPRequest (options) {
    var self = this;

    if (self.debug) {
        logger.info(options.method + ' ' + options.uri);
        if(options.proxy) logger.info("Use proxy: %s", options.proxy);
    }

    // Cloning keeps the opts parameter clean:
    // - some versions of "request" apply the second parameter as a
    // property called "callback" to the first parameter
    // - keeps the query object fresh in case of a retry
    // Doing parse/stringify instead of _.clone will do a deep clone and remove functions

    self._deleteEntity(options);
    var ropts = JSON.parse(JSON.stringify(options));
    self._attachEntity(ropts);

    if (!ropts.headers) {
        ropts.headers = {};
    }
    if (ropts.forceUTF8) {
        ropts.encoding = null;
        if (ropts.json) { // when forced utf8 json maybe decoded error
            ropts.json = false;
        }
    }

    if (ropts.ua) {
        if (ropts.rotateUA && _.isArray(ropts.ua)) {
            ropts.headers['User-Agent'] = ropts.ua[0];
            // If "rotateUA" is true, rotate User-Agent
            options.ua.push(options.ua.shift());
        } else {
            ropts.headers['User-Agent'] = ropts.ua;
        }
        if (self.debug) {
            logger.info(ropts.headers['User-Agent']);
        }
    }
    if (ropts.referer) {
        ropts.headers.Referer = ropts.referer;
    }
    if (ropts.proxies && ropts.proxies.length) {
        ropts.proxy = ropts.proxies[0];
    }
    if (ropts.cookie) {
        var jar = request.jar();
        jar.setCookie(ropts.cookie, ropts.uri);
        ropts.jar = jar;
    }
    if (ropts.gzip) { // fix a request bug (see request issue #2197)
        ropts.headers['Accept-Encoding'] = 'gzip';
    }

    this.emit("request", ropts);

    var requestArgs = ['uri','url','qs','method','headers','body','form','json','multipart','followRedirect',
        'followAllRedirects', 'maxRedirects','encoding','pool','timeout','proxy','auth','oauth','strictSSL',
        'jar','aws','gzip','time','tunnel','proxyHeaderWhiteList','proxyHeaderExclusiveList','localAddress','forever'];

    var req = request(_.pick.apply(this, [ropts].concat(requestArgs)), function (error, response) {
        if (error) {
            if (self.debug) {
                logger.error('Error [' + error + '] when fetching ' + options.uri + (options.retries ? ' (' + options.retries + ' retries left)' : ''));
            }
            if (options.retries) {
                self.plannedQueueCallsCount++;
                setTimeout(function() {
                    options.retries--;
                    self.plannedQueueCallsCount--;
                    // If there is a "proxies" option, rotate it so that we don't keep hitting the same one
                    // if (options.proxies) {
                    //     options.proxies.push(options.proxies.shift());
                    // }
                    self.queue(options);
                }, options.retryTimeout);
            } else if (options.callback) {
                options.callback(error, {options: options});
            }
            return self.emit('pool:release', options);
        }
        if (options.download) {
            if (options.callback) {
                response.options = options;
                options.callback(error, response);
            }
            self.emit('pool:release', options);
        } else {
            response.uri = response.request.href;
            self._onContent(options, response);
        }
    });
    if (options.download) {
        var filePath;
        if (typeof options.download == 'string') {
            filePath = options.download;
        } else {
            filePath = md5(ropts.uri);
        }
        var writer = fs.createWriteStream(filePath);
        req.on('error', function () {
            writer.end();
        });
        req.pipe(writer);
    }
};

Crawler.prototype._onContent = function _onContent (options, response) {
    var self = this;

    if (!response.body) {
        response.body = '';
    }

    if (self.debug) {
        logger.info('Got '+(options.uri||'html')+' ('+response.body.length+' bytes)...');
    }

    try {
        self._doEncoding(options, response);
    } catch(e) {
        logger.error(e);
        if (options.callback) {
            options.callback(e);
        }
        return self.emit('pool:release', options);
    }

    if (!options.callback) {
        return self.emit('pool:release', options);
    }

    response.options = options;

    // This could definitely be improved by *also* matching content-type headers
    var isHTML = _.isString(response.body) && response.body.match(/^\s*</);

    if (isHTML && options.jQuery && options.method !== 'HEAD') {
        self._inject(response, options, function (errors, $) {
            self._onInject(errors, options, response, $);
        });
    } else {
        options.callback(null, response);
        self.emit('pool:release', options);
    }
};

Crawler.prototype._doEncoding = function (options, response) {
    var self = this;

    if (options.encoding === null) {
        return;
    }

    if (options.forceUTF8) {
        var iconvObj;
        var charset = options.incomingEncoding || self._parseCharset(response);

        if (self.debug) {
            logger.info('Charset ' + charset);
        }

        if (charset !== 'utf-8' && charset !== 'ascii') {
            if (iconv) {
                iconvObj = new iconv(charset, 'UTF-8//TRANSLIT//IGNORE');
                response.body = iconvObj.convert(response.body).toString();
            } else{
                response.body = iconvLite.decode(response.body, charset);
            }
        }
    }

    //if charset = 'utf-8', call toString() ;
    if (!options.json) response.body = response.body.toString();
};

Crawler.prototype._onInject = function _onInject (errors, options, response, $) {
    var self = this;

    options.callback(errors, response, $);
    self.emit('pool:release', options);
};

Crawler.prototype._parseCharset = function (res) {
    var ct = res.headers ? (res.headers['content-type'] || res.headers['Content-Type'] || '') : '';
    var body = res.body ? (res.body instanceof Buffer ? res.body.toString() : (typeof res.body == 'string' ? res.body : '')) : '';
    var charset = charsetParser(ct, body, 'utf-8');

    return charset;
};

Object.defineProperty(Crawler.prototype, 'queueSize', {
    get: function () {
        return this.pool.getPoolSize();
    }
});

Object.defineProperty(Crawler.prototype, 'waitingCount', {
    get: function () {
        return this.pool.waitingClientsCount();
    }
});

Object.defineProperty(Crawler.prototype, 'availableCount', {
    get: function () {
        return this.pool.availableObjectsCount();
    }
});

module.exports = Crawler;
module.exports.VERSION = version;