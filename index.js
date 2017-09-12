const initTracer = require('jaeger-client').initTracer;
const request = require('request');
const opentracing = require('opentracing');
const http = require('http');
const https = require('https');
const shimmer = require('shimmer');

module.exports = function(app) {
    var serviceName = JSON.parse(require('fs').readFileSync("package.json")).name;

    var config = {
      'serviceName': serviceName
    };
    var options = {
      'tags': {
        'version': '1.1.2'
      }
    };
    console.log("Initing tracer ", serviceName);
    var tracer = initTracer(config, options);


    var createNamespace = require('cls-hooked').createNamespace;
    var getNamespace =  require('cls-hooked').getNamespace;
    var tracer_context = createNamespace('tracer context');

    app.locals.traceSpan = (name, callback) => {
        tracer_context.run(() => {
            tracer_context.set('tracer', tracer);
            var span = tracer.startSpan(name);
            span.setTag(opentracing.Tags.SAMPLING_PRIORITY, 1);
            tracer_context.set('span', span);

            callback(span);
        });
    }

    app.use((req, res, next) => {
        tracer_context.run(() => {
            tracer_context.set('tracer', tracer);

            // Extract upstream Span context from the request if present
            var span_ctx = tracer.extract(opentracing.FORMAT_HTTP_HEADERS, req.headers);
            var opts = span_ctx ? {childOf: span_ctx} : {}

            var span = tracer.startSpan(`${req.method} ${req.path}`, opts);
            span.setTag('method', req.method);
            span.setTag('path', req.path);
            span.setTag('query', req.query);
            if (req.body) {
                span.setTag('body', req.body);
            }
            console.log("Started express span");
            tracer_context.set('span', span)

            span.setTag(opentracing.Tags.SAMPLING_PRIORITY, 1);

            span.log({"path": req.path});

            res.on('finish', function(){
                console.log("Requst finished, finishing span");
                span.finish()
            });

            next();
        });
    })


    // Patch outbound calls
    shimmer.wrap(http, 'request', function (original) {
        return function (options, callback) {
            var tctx = getNamespace("tracer context");

            var tracer = tctx.get('tracer');
            if (!tracer) {
                //console.log("No tracer found");
                return original(options, callback);
            }
            const span = tracer.startSpan(`${options.method} ${options.href}${options.path}`, { childOf: tracer_context.get('span') });
            span.setTag('http_opts', {host: options.host, path: options.path});

            // Send span context with the outgoing request
            tracer.inject(span, opentracing.FORMAT_HTTP_HEADERS, options.headers);

            var req = original(options, (res) => {
                res.on('end', () => {
                    span.log({'event': 'body_received'});
                    span.finish()
                });
                if (callback) {
                    callback(res);
                }
            });
            req.on('error', (err) => {
                console.log("error event");
                span.setTag(opentracing.Tags.ERROR, true);
                span.log({'event': 'error', 'error.object': err, 'message': err.message});
                span.finish();
            });
            return req;
        }
    });

}


