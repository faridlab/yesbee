var Q = require('q'),
    url = require('url'),
    logger = require('../logger'),
    http = require('http'),
    Exchange = require('../exchange');

var Server = function(hostname, port, protocol) {
    var that = this;

    this.routes = {};
    this.protocol = protocol || 'http';
    this.hostname = hostname;
    this.port = port;

    if (!this.port) {
        this.port = (this.protocol == 'http') ? 80 : 443;
    }

    this.server = http.createServer(function() {
        that.serve.apply(that, arguments);
    });
};

Server.prototype = {
    listen: function() {
        var deferred = Q.defer(),
            that = this;
        this.server.listen(this.port, this.hostname, function() {
            logger.i('$http', 'http server listening on ' + that.hostname + ':' + that.port);
            deferred.resolve();
        });

        return deferred.promise;
    },

    route: function(pathname, handler) {
        pathname = this.normalizePath(pathname);
        this.routes[pathname] = handler;
        logger.i('$http', 'add route ' + pathname + ' on ' + this.hostname + ':' + this.port);
    },

    normalizePath: function(pathname) {
        return pathname.replace(/\/+$/, '');
    },

    serve: function(req, res) {
        var parsed = url.parse(req.url);
        var pathname = this.normalizePath(parsed.pathname);
        var handler = this.routes[pathname],
            handlerIndex = pathname;
        if (!handler) {
            for(var i in this.routes) {
                if (pathname.substr(0, i.length) === i) {
                    handler = this.routes[i];
                    handlerIndex = i;
                    break;
                }
            }
        }

        if (!handler) {
            res.writeHead(404);
            res.end(pathname + ' NOT FOUND\n');
        } else {
            req.headers['x-http-version'] = req.httpVersion;
            req.headers['x-http-handler'] = handlerIndex;
            req.headers['x-request-method'] = req.method;
            req.headers['x-request-url'] = req.url;
            req.headers['x-query-string'] = parsed.query;
            req.headers['x-translated-path'] = pathname;
            req.headers['x-translated-uri'] = pathname.substr(handlerIndex.length);

            var exchange = new Exchange();
            exchange.header(req.headers);

            handler.consume(exchange).then(function(exchange) {
                res.end(exchange.body + '\n');
            }, function(exchange) {
                res.writeHead(500);
                res.end(JSON.stringify({error:exchange.error.message}));
            });

        }
    }
};



var $http = {
    servers: {},
    attach: function(component) {
        var serverUrl = component.uri.substr(component.componentType.length + 1);

        var parsed = url.parse(serverUrl);
        this.get(parsed).route(parsed.pathname, component);
    },

    get: function(parsed) {
        var s = this.servers[parsed.host];
        if (!s) {
            s = this.servers[parsed.host] = new Server(parsed.hostname, parsed.port, parsed.protocol);
            s.listen();
        }

        return s;
    }
};

module.exports = {
    options: {
        exchangePattern: 'inOut',
        timeout: 30000,
    },

    start: function() {
        var deferred = Q.defer();

        this.scopes = {};

        $http.attach(this);

        // setTimeout(function() {
            deferred.resolve();
        // }, 100);

        return deferred.promise;
    },

    consume: function(exchange) {
        var deferred = Q.defer();

        this.send(this.uri + '::in', exchange);

        if (this.options.exchangePattern == 'inOnly') {
            exchange.body = exchange.headers['x-request-method'] + ' ' + exchange.headers['x-translated-path'];
            deferred.resolve(exchange);
        } else {
            var that = this;

            var timeout = setTimeout(function() {

                var scope = that.scopes[exchange.id];
                if (that.scopes[exchange.id]) {
                    delete that.scopes[exchange.id];
                }

                exchange.error = new Error('Timeout executing flow');

                deferred.reject(exchange);

            }, this.options.timeout);

            this.scopes[exchange.id] = {
                timeout: timeout,
                exchange: exchange,
                deferred: deferred
            };

        }

        return deferred.promise;
    },

    callback: function(exchange) {
        var scope = this.scopes[exchange.id];

        if (scope) {

            clearTimeout(scope.timeout);

            if (exchange.error) {
                scope.deferred.reject(exchange);
            } else {
                scope.deferred.resolve(exchange);
            }

            delete this.scopes[exchange.id];
        }


    }
};