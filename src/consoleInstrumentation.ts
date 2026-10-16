import { Breadcrumb } from './types';

export interface ConsoleInstrumentationTarget {
  isCapturing: () => boolean;
  captureException: (error: Error, context: { severity: 'critical'; metadata: { source: string } }) => void;
  addBreadcrumb: (breadcrumb: Omit<Breadcrumb, 'timestamp'>) => void;
}

const stringifyArgs = (args: any[]): string =>
  args.map((arg) => (typeof arg === 'object' ? JSON.stringify(arg) : String(arg))).join(' ');

/**
 * Monkey-patches console.error/log/warn/info to record breadcrumbs (or, for
 * console.error called with an actual Error, capture an exception). Guarded
 * by a local reentrance flag rather than an instance field since it's only
 * ever read/written from within this patch.
 */
export function patchConsole(target: ConsoleInstrumentationTarget): void {
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;
  const originalConsoleWarn = console.warn;
  const originalConsoleInfo = console.info;
  let guard = false;

  console.error = function (...args: any[]) {
    if (!target.isCapturing()) {
      const error = args.find((arg) => arg instanceof Error);
      if (error) {
        try {
          target.captureException(error, {
            severity: 'critical',
            metadata: { source: 'Console Error Interception' }
          });
        } catch (err) {
          // Fail-silent
        }
      } else {
        try {
          target.addBreadcrumb({
            category: 'console',
            message: stringifyArgs(args),
            level: 'error',
            type: 'log'
          });
        } catch (_) {}
      }
    }
    originalConsoleError.apply(console, args);
  };

  console.log = function (...args: any[]) {
    if (!guard) {
      guard = true;
      try {
        target.addBreadcrumb({
          category: 'console',
          message: stringifyArgs(args),
          level: 'info',
          type: 'log'
        });
      } catch (_) {}
      guard = false;
    }
    originalConsoleLog.apply(console, args);
  };

  console.warn = function (...args: any[]) {
    if (!guard) {
      guard = true;
      try {
        target.addBreadcrumb({
          category: 'console',
          message: stringifyArgs(args),
          level: 'warning',
          type: 'log'
        });
      } catch (_) {}
      guard = false;
    }
    originalConsoleWarn.apply(console, args);
  };

  console.info = function (...args: any[]) {
    if (!guard) {
      guard = true;
      try {
        target.addBreadcrumb({
          category: 'console',
          message: stringifyArgs(args),
          level: 'info',
          type: 'log'
        });
      } catch (_) {}
      guard = false;
    }
    originalConsoleInfo.apply(console, args);
  };
}
