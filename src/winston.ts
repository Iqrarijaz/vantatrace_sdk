/**
 * Dynamic Winston Transport Builder
 * Safely resolves and extends winston-transport at runtime
 */
export function createWinstonTransport(sdk: any): any {
  try {
    const Transport = require('winston-transport');
    
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

        // Intercept Winston errors
        const error = info instanceof Error ? info : (info.error || info.err);
        if (error instanceof Error) {
          try {
            this.sdk.captureException(error, {
              severity: info.level === 'error' ? 'critical' : info.level === 'warn' ? 'warning' : 'info',
              metadata: {
                message: info.message,
                winstonInfo: info
              }
            });
          } catch (err) {
            // Fail silent
          }
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
