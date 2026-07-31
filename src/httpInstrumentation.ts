import { dynamicRequire } from './nodeRequire';
import { requestStorage } from './store';
import { Breadcrumb, SpanType } from './types';

export interface HttpInstrumentationTarget {
  apiUrl: string;
  addBreadcrumb: (breadcrumb: Omit<Breadcrumb, 'timestamp'>) => void;
  startSpan: (type: SpanType, name: string) => { end: () => void };
}

/**
 * Safe monkey-patching of outbound HTTP and HTTPS requests to log network
 * breadcrumbs, time spans, and propagate the active request's W3C trace
 * context downstream.
 */
export function patchHttp(target: HttpInstrumentationTarget): void {
  try {
    // Deliberately dynamicRequire(), not a static `import * as http from
    // 'http'` — this needs the actual shared module.exports singleton to
    // monkey-patch (so the patch applies process-wide, to any outbound
    // call anywhere in the host app, not just calls made through this
    // reference). A static namespace import goes through TypeScript's/
    // esbuild's __importStar interop helper, which copies properties onto
    // a new synthetic object under esModuleInterop — mutating .request on
    // that copy would silently patch nothing real.
    const http = dynamicRequire('http');
    const https = dynamicRequire('https');

    const patchRequest = (module: any, isHttps: boolean) => {
      if (!module || !module.request) return;
      const originalRequest = module.request;

      module.request = function (options: any, ...args: any[]) {
        let urlStr = '';
        let host = '';
        let isSelf = false;
        try {
          if (typeof options === 'string') {
            urlStr = options;
            const parsed = new URL(options);
            host = parsed.host;
          } else if (options && typeof options === 'object') {
            host = options.hostname || options.host || 'localhost';
            const protocol = options.protocol || (isHttps ? 'https:' : 'http:');
            const path = options.path || '/';
            urlStr = `${protocol}//${host}${path}`;
          }

          // Exclude self-telemetry calls
          const selfUrl = new URL(target.apiUrl);
          isSelf = !!(host && selfUrl.host && host.toLowerCase() === selfUrl.host.toLowerCase());

          if (!isSelf && urlStr) {
            const method = (options && options.method) || 'GET';
            target.addBreadcrumb({
              category: 'http',
              message: `${method} ${urlStr}`,
              level: 'info',
              type: 'http',
              data: { method, url: urlStr }
            });
          }
        } catch (_) {}

        if (isSelf) {
          return originalRequest.apply(this, [options, ...args]);
        }

        // Propagate the active request's W3C trace context downstream, so a
        // VantaTrace- (or any W3C-compliant) instrumented service on the
        // other end continues this trace instead of starting a new one.
        // Only handled for the object-options calling form — a plain URL
        // string can't carry headers without restructuring the call
        // signature, which isn't worth the risk on a widely-used monkey-patch
        // for a less common calling convention. Never overwrites a
        // traceparent header the caller already set themselves.
        let requestOptions = options;
        try {
          const activeStore = requestStorage.getStore() as any;
          if (activeStore?.traceparent && options && typeof options === 'object' && !options.headers?.traceparent) {
            requestOptions = { ...options, headers: { ...options.headers, traceparent: activeStore.traceparent } };
          }
        } catch (_) {}

        const method = (options && options.method) || 'GET';
        const span = urlStr ? target.startSpan('http', `${method} ${host || urlStr}`) : null;
        const req = originalRequest.apply(this, [requestOptions, ...args]);

        if (span && req && typeof req.once === 'function') {
          req.once('response', () => span.end());
          req.once('error', () => span.end());
          req.once('close', () => span.end());
        }

        return req;
      };
    };

    patchRequest(http, false);
    patchRequest(https, true);
  } catch (_) {}
}
