/**
 * Runtime capture of exceptions that are handled inside try/catch blocks.
 *
 * JavaScript exposes no language-level event for exceptions that user code
 * catches: try/catch is resolved entirely inside the V8 VM, and the
 * process-level hooks ('uncaughtException', 'unhandledRejection') only fire
 * for errors that escape every handler. The one runtime mechanism that can
 * observe a caught throw is the V8 inspector protocol: with
 * `Debugger.setPauseOnExceptions('all')`, V8 delivers a synchronous
 * `Debugger.paused` event at every throw site — including engine-generated
 * errors such as `ReferenceError`/`TypeError` — before the catch block runs.
 *
 * An in-process `node:inspector` session receives that event on the same
 * thread, so the AsyncLocalStorage request context active at the throw site
 * is still active inside our handler, and `Runtime.callFunctionOn` lets us
 * hand the *actual* Error object (not a serialized copy) back to the SDK.
 * This is the same mechanism Sentry's `LocalVariables` integration uses to
 * read stack-frame variables at throw time.
 *
 * Cost model (measured on Node 22): near-zero while no exception is thrown;
 * roughly 0.3–0.5ms per thrown exception while enabled. That is negligible
 * for code where exceptions are exceptional, but expensive for code that uses
 * throw/catch as control flow — which is why this capability is opt-in.
 */

import { fileURLToPath } from 'url';
import { dynamicRequire } from './nodeRequire';

export interface CaughtExceptionInfo {
  /** V8's prediction of whether the throw will escape every handler on the stack. */
  uncaught: boolean;
  /** Source file of the closest application-level stack frame at the throw site. */
  frameUrl: string;
}

export interface CaughtExceptionWatcherOptions {
  /** Capture throws originating inside node_modules. Default false. */
  includeNodeModules: boolean;
  /** Ceiling on recorded exceptions per minute. */
  maxPerMinute: number;
  debug: boolean;
  /**
   * Directory whose files are never treated as a throw origin (the SDK's own
   * sources — self-defense against feedback loops). Defaults to this module's
   * directory; tests override it.
   */
  selfDir?: string;
}

const HOOK_NAME = '__vantatrace_on_caught_exception__';

// Evaluated by V8 *on the exception object* (`this`) via Runtime.callFunctionOn,
// bridging the inspector's RemoteObject back to a real in-process reference.
const HOOK_FN = `function (uncaught, frameUrl) {
  try { globalThis.${HOOK_NAME}(this, uncaught, frameUrl); } catch (_) {}
}`;

function normalizePath(p: string): string {
  let out = (p || '').replace(/\\/g, '/');
  // Script URLs from the inspector come in file:// form; compare as plain paths.
  if (out.startsWith('file://')) {
    try {
      out = normalizePath(fileURLToPath(out));
    } catch (_e) {
      out = out.slice('file://'.length);
    }
  }
  return out;
}

/**
 * Start watching for caught exceptions via an in-process V8 inspector session.
 *
 * @param onCaught invoked synchronously at the throw site with the real thrown
 *                 value. AsyncLocalStorage context from the throw site is
 *                 active during the call.
 * @returns a stop function, or null when the inspector is unavailable in this
 *          runtime (the SDK degrades gracefully to its other capture layers).
 */
export function startCaughtExceptionWatcher(
  onCaught: (error: any, info: CaughtExceptionInfo) => void,
  options: CaughtExceptionWatcherOptions
): (() => void) | null {
  let inspector: typeof import('inspector');
  try {
    inspector = dynamicRequire('inspector');
  } catch (_e) {
    if (options.debug) {
      console.warn('[VantaTrace] node:inspector is unavailable in this runtime; caught-exception capture disabled.');
    }
    return null;
  }

  const session = new inspector.Session();
  try {
    session.connect();
  } catch (e: any) {
    if (options.debug) {
      console.warn(`[VantaTrace] Failed to connect inspector session (${e?.message}); caught-exception capture disabled.`);
    }
    return null;
  }

  const selfDir = normalizePath(options.selfDir !== undefined ? options.selfDir : __dirname);

  // Node reports empty `url` fields on pause call frames; script URLs must be
  // resolved through Debugger.scriptParsed events (replayed for all existing
  // scripts when Debugger.enable is posted). One small entry per loaded script.
  const scriptUrls = new Map<string, string>();
  session.on('Debugger.scriptParsed', (msg: any) => {
    const p = msg && msg.params;
    if (p && p.scriptId) scriptUrls.set(p.scriptId, p.url || '');
  });

  /**
   * Resolve the throw site to the closest application-level frame, skipping
   * `node:` internals so that e.g. an ENOENT thrown inside node:fs is
   * attributed to the app code that called readFileSync. An empty result means
   * no usable file URL — treated as application code.
   */
  const firstAppFrameUrl = (callFrames: any[]): string => {
    if (!Array.isArray(callFrames)) return '';
    for (const frame of callFrames) {
      const url: string =
        (frame && frame.url) ||
        (frame && frame.location && scriptUrls.get(frame.location.scriptId)) ||
        '';
      if (!url) continue;
      if (url.startsWith('node:')) continue;
      return url;
    }
    return '';
  };

  const safeOnCaught = (error: any, info: CaughtExceptionInfo) => {
    try {
      onCaught(error, info);
    } catch (_e) {
      // SDK self-defense: never let capture plumbing break the host app.
    }
  };

  Object.defineProperty(globalThis, HOOK_NAME, {
    value: (error: any, uncaught: any, frameUrl: any) =>
      safeOnCaught(error, { uncaught: !!uncaught, frameUrl: String(frameUrl || '') }),
    enumerable: false,
    configurable: true,
    writable: false
  });

  const isIgnoredUrl = (url: string): boolean => {
    const normalized = normalizePath(url);
    if (!normalized) return false;
    if (selfDir && normalized.startsWith(selfDir)) return true;
    if (!options.includeNodeModules && normalized.includes('/node_modules/')) return true;
    return false;
  };

  // Sliding one-minute rate-limit window.
  let windowStart = Date.now();
  let recordedInWindow = 0;
  let droppedInWindow = 0;
  // Reentrancy guard: a pause delivered while we are still handling a pause
  // (should not happen — pause handling is synchronous — but never trust it).
  let handlingPause = false;

  const handlePaused = (msg: any) => {
    let resumed = false;
    const resume = () => {
      if (resumed) return;
      resumed = true;
      try {
        session.post('Debugger.resume');
      } catch (_e) { /* session torn down mid-pause */ }
    };

    try {
      const params = msg && msg.params;
      if (!params || (params.reason !== 'exception' && params.reason !== 'promiseRejection')) return;
      if (handlingPause) return;
      handlingPause = true;
      try {
        const now = Date.now();
        if (now - windowStart >= 60_000) {
          if (droppedInWindow > 0 && options.debug) {
            console.warn(`[VantaTrace] caught-exception capture rate limit: dropped ${droppedInWindow} exception(s) in the last window.`);
          }
          windowStart = now;
          recordedInWindow = 0;
          droppedInWindow = 0;
        }
        if (recordedInWindow >= options.maxPerMinute) {
          droppedInWindow++;
          return;
        }

        const data = params.data;
        if (!data) return;
        const frameUrl = firstAppFrameUrl(params.callFrames);
        if (isIgnoredUrl(frameUrl)) return;

        const info: CaughtExceptionInfo = { uncaught: !!data.uncaught, frameUrl };
        recordedInWindow++;

        if (data.objectId) {
          // In-process sessions dispatch this synchronously while paused, and
          // `silent: true` mutes any exception the evaluation itself raises so
          // it cannot re-trigger this pause handler.
          session.post(
            'Runtime.callFunctionOn',
            {
              objectId: data.objectId,
              functionDeclaration: HOOK_FN,
              arguments: [{ value: info.uncaught }, { value: info.frameUrl }],
              silent: true
            },
            () => { /* result unused; errors intentionally ignored */ }
          );
        } else if ('value' in data || data.description) {
          // Thrown primitive (`throw 'string'`, `throw 42`) — no objectId exists.
          safeOnCaught('value' in data ? data.value : data.description, info);
        }
      } finally {
        handlingPause = false;
      }
    } catch (_e) {
      // Never let watcher failures escape into the paused VM.
    } finally {
      resume();
    }
  };

  session.on('Debugger.paused', handlePaused);

  const postOrWarn = (method: string, params?: any) => {
    session.post(method, params, (err: Error | null) => {
      if (err && options.debug) {
        console.warn(`[VantaTrace] inspector ${method} failed: ${err.message}`);
      }
    });
  };

  postOrWarn('Debugger.enable');
  postOrWarn('Debugger.setPauseOnExceptions', { state: 'all' });

  if (options.debug) {
    console.log('[VantaTrace] Caught-exception capture enabled (V8 inspector pause-on-exceptions).');
  }

  let stopped = false;
  return function stop(): void {
    if (stopped) return;
    stopped = true;
    try {
      session.post('Debugger.setPauseOnExceptions', { state: 'none' });
      session.post('Debugger.disable');
    } catch (_e) { /* already disconnected */ }
    try {
      session.disconnect();
    } catch (_e) { /* already disconnected */ }
    try {
      delete (globalThis as any)[HOOK_NAME];
    } catch (_e) { /* non-configurable — leave the no-op hook in place */ }
  };
}
