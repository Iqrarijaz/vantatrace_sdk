import { requestStorage } from './store';
import { VantaTraceContext } from './types';

export interface AutoCaptureFinisherTarget {
  http5xxEnabled: boolean;
  http4xxEnabled: boolean;
  http4xxExclude: Set<number>;
  /** Whether the V8 inspector caught-exception watcher is currently running, for the hint text. */
  hasCaughtWatcher: boolean;
  captureException: (error: any, context: VantaTraceContext) => void;
}

/**
 * Response finalizer for auto-capture. When a request ends with a failure
 * status (5xx, or an eligible 4xx) and no exception was reported for it,
 * this reports the real caught exception (when the inspector watcher
 * recorded one) or a synthetic HttpServerError/HttpClientError so the
 * failure is visible on the dashboard even when application code handled
 * it gracefully (e.g. `res.status(400).json(...)` with no throw).
 */
export function finishAutoCapture(target: AutoCaptureFinisherTarget, store: any, req: any, res: any): void {
  try {
    const status = res?.statusCode;
    if (!status || status < 400) return;
    if (store._vantaErrorCaptured) return;

    const isServerError = status >= 500;

    // Excluded 4xx codes (401/404 by default — routine token expiry and
    // not-found/bot traffic, not defects) are skipped entirely, including
    // when a real caught exception exists for them: the exclusion means
    // "don't track this status category", not just "don't synthesize".
    if (!isServerError && target.http4xxExclude.has(status)) return;

    const severity: 'critical' | 'warning' = isServerError ? 'critical' : 'warning';

    // Re-enter the request's async context: 'finish' may be emitted from the
    // socket's context, and captureException reads ALS for enrichment.
    const capture = (error: any, context: VantaTraceContext) => {
      requestStorage.run(store, () => target.captureException(error, context));
    };

    // The body actually sent back to the client — often the single most
    // concrete clue about what a swallowed catch block did, even when no
    // exception object was ever reported. Capped by the transport's own
    // payload size handling downstream; nothing extra to do here.
    const responseBody = store._vantaResponseBody;

    const caughtErrors: any[] = store._vantaCaughtErrors || [];
    if (caughtErrors.length > 0) {
      // The first caught exception is the root cause; later ones are usually
      // cascade failures. Summarize the rest instead of sending N events.
      const [primary, ...rest] = caughtErrors;
      capture(primary, {
        severity,
        metadata: {
          captureStrategy: 'caughtException',
          handled: true,
          httpStatusCode: status,
          ...(responseBody !== undefined ? { responseBody } : {}),
          ...(rest.length > 0
            ? { additionalCaughtErrors: rest.map((e) => `${e?.name || 'Error'}: ${e?.message || String(e)}`) }
            : {})
        }
      });
      return;
    }

    const categoryEnabled = isServerError ? target.http5xxEnabled : target.http4xxEnabled;
    if (!categoryEnabled) return;

    const method = req?.method || store.method || 'UNKNOWN';
    const route = store.route || req?.originalUrl || req?.url || 'unknown route';
    // Only nudge toward the caught-exception capture layers when they aren't
    // already active — no point telling someone to turn on a watcher that's
    // already running (it simply didn't observe a throw for this request,
    // e.g. because it originated inside node_modules).
    const hint = target.hasCaughtWatcher
      ? ''
      : ' Enable autoCapture.caughtExceptions (or use @vantatrace/sdk/babel-plugin) to capture the real error object automatically.';
    const synthetic = new Error(
      `${method} ${route} responded with HTTP ${status} but no exception was reported ` +
      `(handled internally — e.g. an explicit res.status(${status}) response, or swallowed by a try/catch).${hint}`
    );
    synthetic.name = isServerError ? 'HttpServerError' : 'HttpClientError';
    capture(synthetic, {
      severity,
      metadata: {
        captureStrategy: isServerError ? 'http5xx' : 'http4xx',
        handled: true,
        httpStatusCode: status,
        ...(responseBody !== undefined ? { responseBody } : {})
      }
    });
  } catch (_e) {
    // Never interfere with the response lifecycle.
  }
}
