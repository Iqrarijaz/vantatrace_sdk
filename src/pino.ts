import { dynamicRequire } from './nodeRequire';

export interface PinoInstrumentationTarget {
  debug: boolean;
  isCapturing: () => boolean;
  captureException: (error: Error, context: { severity: 'critical'; metadata: { source: string } }) => void;
}

/** Safe conditional patching of Pino to capture logged Error instances as exceptions. Silently no-ops if `pino` isn't installed. */
export function tryPatchPino(target: PinoInstrumentationTarget): void {
  try {
    const pino = dynamicRequire('pino');
    if (pino && pino.prototype && pino.prototype.write) {
      const originalWrite = pino.prototype.write;

      pino.prototype.write = function (obj: any, msg: string, num: number) {
        // Only CHECK the flag — captureException manages it internally.
        if (!target.isCapturing()) {
          let err: any = null;
          if (obj && obj instanceof Error) {
            err = obj;
          } else if (obj && obj.err && obj.err instanceof Error) {
            err = obj.err;
          } else if (obj && obj.error && obj.error instanceof Error) {
            err = obj.error;
          }
          if (err) {
            try {
              target.captureException(err, {
                severity: 'critical',
                metadata: { source: 'Pino Logger Interception' }
              });
            } catch (e) {
              // Fail-silent
            }
          }
        }
        return originalWrite.call(this, obj, msg, num);
      };

      if (target.debug) {
        console.log('[VantaTrace Debug] Successfully auto-patched Pino logging.');
      }
    }
  } catch (e) {
    // Pino is not present. Ignored.
  }
}
