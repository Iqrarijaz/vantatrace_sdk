import type { VantaTrace } from './index';
import type { VantaTraceContext } from './types';

let globalInstance: VantaTrace | null = null;
let warnedMissingInstance = false;

/**
 * Registers the global singleton used by auto-instrumented catch blocks.
 * First instance wins; a later call logs a warning instead of replacing it.
 */
export function registerGlobalInstance(instance: VantaTrace, debug: boolean): void {
  if (globalInstance) {
    console.warn(
      '[VantaTrace] WARNING: multiple instances constructed; the first instance remains ' +
        'the global singleton used by auto-instrumented catch blocks.'
    );
    return;
  }
  globalInstance = instance;
  if (debug) {
    console.log('[VantaTrace] Registered global singleton instance for auto-instrumented catch blocks.');
  }
}

export function getGlobalInstance(): VantaTrace | null {
  return globalInstance;
}

/** Entry point injected into user code by the Babel/SWC plugins. */
export function captureExceptionGlobal(error: any, context?: VantaTraceContext): void {
  if (!globalInstance) {
    if (!warnedMissingInstance) {
      warnedMissingInstance = true;
      console.warn(
        '[VantaTrace] WARNING: captured an exception before the SDK was initialized. ' +
          'Call `new VantaTrace(options)` in your application entrypoint.'
      );
    }
    return;
  }
  globalInstance.captureException(error, context);
}

/** Test-only: resets module-level singleton state between test runs. */
export function _resetForTests(): void {
  globalInstance = null;
  warnedMissingInstance = false;
}
