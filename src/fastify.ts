import { VantaTrace } from './index';

/**
 * Fastify plugin for VantaTrace.
 *
 * Usage:
 * const vantatrace = new VantaTrace({ ... });
 * fastify.register(vantaTracePlugin(vantatrace));
 */
export function vantaTracePlugin(instance: VantaTrace) {
  return function (fastify: any, options: any, done: any) {
    fastify.addHook('onRequest', (request: any, reply: any, next: any) => {
      // Map Fastify Request to Express-like Request for the handler
      const expressReq = {
        headers: request.headers,
        method: request.method,
        url: request.url,
        body: request.body,
        query: request.query,
        ip: request.ip,
        socket: request.socket
      };
      
      const middleware = instance.requestHandler();
      middleware(expressReq, reply.raw, next);
    });

    fastify.addHook('onError', (request: any, reply: any, error: Error, next: any) => {
      instance.captureException(error);
      next();
    });

    done();
  };
}
