import { test } from 'node:test';
import assert from 'node:assert/strict';
import { patchConsole, ConsoleInstrumentationTarget } from './consoleInstrumentation';

/**
 * Patches console.error/log/warn/info for the duration of `run`, recording
 * everything the real (pre-patch) console functions were called with, and
 * always restoring the originals afterward — this mutates the global
 * console object, so a leaked patch would corrupt every other test file.
 */
function withPatchedConsole(
  target: ConsoleInstrumentationTarget,
  run: (forwarded: { fn: string; args: any[] }[]) => void
): void {
  const originals = { error: console.error, log: console.log, warn: console.warn, info: console.info };
  const forwarded: { fn: string; args: any[] }[] = [];
  console.error = (...args: any[]) => { forwarded.push({ fn: 'error', args }); };
  console.log = (...args: any[]) => { forwarded.push({ fn: 'log', args }); };
  console.warn = (...args: any[]) => { forwarded.push({ fn: 'warn', args }); };
  console.info = (...args: any[]) => { forwarded.push({ fn: 'info', args }); };

  patchConsole(target);
  try {
    run(forwarded);
  } finally {
    console.error = originals.error;
    console.log = originals.log;
    console.warn = originals.warn;
    console.info = originals.info;
  }
}

function fakeTarget(overrides: Partial<ConsoleInstrumentationTarget> = {}): {
  target: ConsoleInstrumentationTarget;
  captureCalls: any[];
  breadcrumbCalls: any[];
} {
  const captureCalls: any[] = [];
  const breadcrumbCalls: any[] = [];
  const target: ConsoleInstrumentationTarget = {
    isCapturing: () => false,
    captureException: (error, context) => { captureCalls.push({ error, context }); },
    addBreadcrumb: (breadcrumb) => { breadcrumbCalls.push(breadcrumb); },
    ...overrides
  };
  return { target, captureCalls, breadcrumbCalls };
}

test('console.error with an Error argument captures it as an exception, not a breadcrumb', () => {
  const { target, captureCalls, breadcrumbCalls } = fakeTarget();
  withPatchedConsole(target, (forwarded) => {
    const err = new Error('boom');
    console.error('something failed:', err);

    assert.equal(captureCalls.length, 1);
    assert.equal(captureCalls[0].error, err);
    assert.equal(captureCalls[0].context.severity, 'critical');
    assert.equal(captureCalls[0].context.metadata.source, 'Console Error Interception');
    assert.equal(breadcrumbCalls.length, 0);
    assert.equal(forwarded.length, 1, 'the real console.error must still run');
    assert.equal(forwarded[0].fn, 'error');
  });
});

test('console.error without an Error argument records a breadcrumb instead of capturing', () => {
  const { target, captureCalls, breadcrumbCalls } = fakeTarget();
  withPatchedConsole(target, (forwarded) => {
    console.error('plain string error', { code: 500 });

    assert.equal(captureCalls.length, 0);
    assert.equal(breadcrumbCalls.length, 1);
    assert.equal(breadcrumbCalls[0].category, 'console');
    assert.equal(breadcrumbCalls[0].level, 'error');
    assert.equal(breadcrumbCalls[0].message, 'plain string error {"code":500}');
    assert.equal(forwarded.length, 1);
  });
});

test('console.error does nothing when a capture is already in progress, but still forwards to the real console.error', () => {
  const { target, captureCalls, breadcrumbCalls } = fakeTarget({ isCapturing: () => true });
  withPatchedConsole(target, (forwarded) => {
    console.error(new Error('reentrant boom'));

    assert.equal(captureCalls.length, 0);
    assert.equal(breadcrumbCalls.length, 0);
    assert.equal(forwarded.length, 1, 'must still forward even while capturing is suppressed');
  });
});

test('console.log records an info-level breadcrumb and still forwards to the real console.log, regardless of isCapturing', () => {
  const { target, breadcrumbCalls } = fakeTarget({ isCapturing: () => true });
  withPatchedConsole(target, (forwarded) => {
    console.log('narration', 42);

    assert.equal(breadcrumbCalls.length, 1);
    assert.equal(breadcrumbCalls[0].category, 'console');
    assert.equal(breadcrumbCalls[0].level, 'info');
    assert.equal(breadcrumbCalls[0].message, 'narration 42');
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0].fn, 'log');
  });
});

test('console.warn records a warning-level breadcrumb', () => {
  const { target, breadcrumbCalls } = fakeTarget();
  withPatchedConsole(target, (forwarded) => {
    console.warn('careful now');

    assert.equal(breadcrumbCalls.length, 1);
    assert.equal(breadcrumbCalls[0].level, 'warning');
    assert.equal(breadcrumbCalls[0].message, 'careful now');
    assert.equal(forwarded[0].fn, 'warn');
  });
});

test('console.info records an info-level breadcrumb', () => {
  const { target, breadcrumbCalls } = fakeTarget();
  withPatchedConsole(target, (forwarded) => {
    console.info('fyi');

    assert.equal(breadcrumbCalls.length, 1);
    assert.equal(breadcrumbCalls[0].level, 'info');
    assert.equal(breadcrumbCalls[0].message, 'fyi');
    assert.equal(forwarded[0].fn, 'info');
  });
});

test('a throwing addBreadcrumb does not leave the console.log reentrance guard stuck', () => {
  let call = 0;
  const breadcrumbCalls: any[] = [];
  const target = fakeTarget({
    addBreadcrumb: (breadcrumb) => {
      call++;
      if (call === 1) throw new Error('addBreadcrumb exploded');
      breadcrumbCalls.push(breadcrumb);
    }
  }).target;

  withPatchedConsole(target, (forwarded) => {
    console.log('first call throws internally');
    console.log('second call must still work');

    assert.equal(breadcrumbCalls.length, 1, 'the guard must reset even after addBreadcrumb throws');
    assert.equal(breadcrumbCalls[0].message, 'second call must still work');
    assert.equal(forwarded.length, 2, 'both calls must still forward to the real console.log');
  });
});

test('a throwing captureException on console.error is swallowed (fail-silent) and still forwards', () => {
  const target = fakeTarget({
    captureException: () => { throw new Error('captureException exploded'); }
  }).target;

  withPatchedConsole(target, (forwarded) => {
    assert.doesNotThrow(() => console.error(new Error('boom')));
    assert.equal(forwarded.length, 1);
  });
});
