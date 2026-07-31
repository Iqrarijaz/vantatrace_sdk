import { dynamicRequire } from './nodeRequire';

/**
 * Dynamic Winston Transport Builder
 * Safely resolves and extends winston-transport at runtime
 */
export function createWinstonTransport(sdk: any): any {
  try {
    const Transport = dynamicRequire('winston-transport');

    class VantaTraceWinstonTransport extends Transport {
      private sdk: any;

      constructor(opts: any) {
        super(opts);
        this.sdk = opts.sdk;
      }

      log(info: any, callback: () => void) {
        setImmediate(() => {
          this.emit('logged', info);
        });

        try {
          // Winston's dominant real-world calling convention — a single
          // metadata object with no explicit `message` key, e.g.
          // `logger.error({ event, functionName, err })` — gets nested whole
          // under `info.message` rather than spread onto `info` directly.
          // Reading only top-level fields would miss `err`/`event`/etc.
          // entirely for that (very common) pattern, so unwrap it here.
          const nested = info.message && typeof info.message === 'object' && !(info.message instanceof Error);
          const meta = nested ? info.message : info;

          // Intercept the real error object — not a destructured
          // { message, stack } copy of it, which some apps log defensively
          // and which this deliberately does NOT treat as capturable (there's
          // no stack/type information to recover from a plain object).
          const error = info instanceof Error
            ? info
            : info.message instanceof Error
              ? info.message
              : (meta.error || meta.err);

          if (error instanceof Error) {
            this.sdk.captureException(error, {
              severity: info.level === 'error' ? 'critical' : info.level === 'warn' ? 'warning' : 'info',
              metadata: {
                message: nested ? undefined : info.message,
                winstonInfo: this.sdk.maskData(meta)
              }
            });
          } else {
            // No real Error found — most Winston logging in an app is
            // info/debug narration ("ESB request built", "calling gateway X"),
            // not error reporting. Recording it as a breadcrumb turns that
            // pre-existing logging into request-trace context on the next
            // captured error, with zero code changes at any call site.
            const level: 'info' | 'warning' | 'error' =
              info.level === 'error' ? 'error' : info.level === 'warn' ? 'warning' : 'info';
            const message = (typeof info.message === 'string' && info.message) || meta.event || 'log';
            const source = nested ? meta : info;
            const { level: _level, message: _message, timestamp: _timestamp, ...data } = source;

            this.sdk.addBreadcrumb({
              category: 'winston',
              message: String(message),
              level,
              type: 'log',
              data: this.sdk.maskData(data)
            });
          }
        } catch (err) {
          // Fail silent
        }
        callback();
      }
    }

    return new VantaTraceWinstonTransport({ sdk });
  } catch (e) {
    if (sdk.debug) {
      console.warn('[VantaTrace Debug] Failed to dynamically construct Winston Transport (winston-transport package missing).');
    }
    return null;
  }
}
