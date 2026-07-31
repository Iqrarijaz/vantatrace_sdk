import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Module from 'module';
import { tryPatchPino, PinoInstrumentationTarget } from './pino';

const pinoPath = require.resolve('pino');

/**
 * Substitutes the module Node's require cache hands back for 'pino' with a
 * fake shaped however the test needs, so tryPatchPino()'s internal
 * `dynamicRequire('pino')` (a plain `require('pino')` under tsx) resolves to
 * it instead of the real installed package — restores whatever was cached
 * before (or removes the entry entirely) afterward.
 */
function withMockedPinoModule(fakeExports: any, run: () => void): void {
  const hadOriginal = Object.prototype.hasOwnProperty.call(require.cache, pinoPath);
  const original = require.cache[pinoPath];
  require.cache[pinoPath] = { id: pinoPath, filename: pinoPath, loaded: true, exports: fakeExports } as any;
  try {
    run();
  } finally {
    if (hadOriginal) {
      require.cache[pinoPath] = original;
    } else {
      delete require.cache[pinoPath];
    }
  }
}

function fakePinoModule(originalWrite: (this: any, obj: any, msg: string, num: number) => any = () => 'original-result') {
  return { prototype: { write: originalWrite } };
}

function fakeTarget(overrides: Partial<PinoInstrumentationTarget> = {}): {
  target: PinoInstrumentationTarget;
  captureCalls: any[];
} {
  const captureCalls: any[] = [];
  const target: PinoInstrumentationTarget = {
    debug: false,
    isCapturing: () => false,
    captureException: (error, context) => { captureCalls.push({ error, context }); },
    ...overrides
  };
  return { target, captureCalls };
}

test('a directly-logged Error instance is captured as an exception, and the real write still runs', () => {
  const module = fakePinoModule((_obj, _msg, _num) => 'original-result');
  const { target, captureCalls } = fakeTarget();

  withMockedPinoModule(module, () => {
    tryPatchPino(target);

    const err = new Error('boom');
    const result = module.prototype.write.call({}, err, 'msg', 30);

    assert.equal(captureCalls.length, 1);
    assert.equal(captureCalls[0].error, err);
    assert.equal(captureCalls[0].context.severity, 'critical');
    assert.equal(captureCalls[0].context.metadata.source, 'Pino Logger Interception');
    assert.equal(result, 'original-result', 'the original write must still run and its return value must pass through');
  });
});

test('an Error nested under obj.err is captured', () => {
  const module = fakePinoModule();
  const { target, captureCalls } = fakeTarget();

  withMockedPinoModule(module, () => {
    tryPatchPino(target);
    const err = new Error('nested under err');
    module.prototype.write.call({}, { err }, 'msg', 30);

    assert.equal(captureCalls.length, 1);
    assert.equal(captureCalls[0].error, err);
  });
});

test('an Error nested under obj.error is captured', () => {
  const module = fakePinoModule();
  const { target, captureCalls } = fakeTarget();

  withMockedPinoModule(module, () => {
    tryPatchPino(target);
    const err = new Error('nested under error');
    module.prototype.write.call({}, { error: err }, 'msg', 30);

    assert.equal(captureCalls.length, 1);
    assert.equal(captureCalls[0].error, err);
  });
});

test('a log object with no Error anywhere is not captured, and the real write still runs', () => {
  const module = fakePinoModule(() => 'passthrough');
  const { target, captureCalls } = fakeTarget();

  withMockedPinoModule(module, () => {
    tryPatchPino(target);
    const result = module.prototype.write.call({}, { message: 'just narration' }, 'msg', 30);

    assert.equal(captureCalls.length, 0);
    assert.equal(result, 'passthrough');
  });
});

test('does nothing when a capture is already in progress, but still forwards to the real write', () => {
  const module = fakePinoModule(() => 'passthrough');
  const { target, captureCalls } = fakeTarget({ isCapturing: () => true });

  withMockedPinoModule(module, () => {
    tryPatchPino(target);
    const result = module.prototype.write.call({}, new Error('reentrant'), 'msg', 30);

    assert.equal(captureCalls.length, 0);
    assert.equal(result, 'passthrough');
  });
});

test('a throwing captureException is swallowed (fail-silent) and the real write still runs', () => {
  const module = fakePinoModule(() => 'passthrough');
  const { target } = fakeTarget({
    captureException: () => { throw new Error('captureException exploded'); }
  });

  withMockedPinoModule(module, () => {
    tryPatchPino(target);
    assert.doesNotThrow(() => {
      const result = module.prototype.write.call({}, new Error('boom'), 'msg', 30);
      assert.equal(result, 'passthrough');
    });
  });
});

test('debug: true logs a one-time confirmation once the patch is applied', () => {
  const module = fakePinoModule();
  const { target } = fakeTarget({ debug: true });
  const originalLog = console.log;
  const logs: any[] = [];
  console.log = (...args: any[]) => { logs.push(args.join(' ')); };

  try {
    withMockedPinoModule(module, () => {
      tryPatchPino(target);
    });
  } finally {
    console.log = originalLog;
  }

  assert.ok(logs.some((line) => line.includes('Successfully auto-patched Pino logging')));
});

test('silently no-ops (does not throw) when pino cannot be resolved, e.g. genuinely not installed', () => {
  const originalResolveFilename = (Module as any)._resolveFilename;
  (Module as any)._resolveFilename = function (request: string, ...args: any[]) {
    if (request === 'pino') {
      throw new Error("Cannot find module 'pino'");
    }
    return originalResolveFilename.apply(this, [request, ...args]);
  };

  const { target, captureCalls } = fakeTarget();
  try {
    assert.doesNotThrow(() => tryPatchPino(target));
    assert.equal(captureCalls.length, 0);
  } finally {
    (Module as any)._resolveFilename = originalResolveFilename;
  }
});

test('KNOWN LIMITATION: against the real installed pino (v10), the patch is a silent no-op because pino.prototype.write no longer exists', () => {
  // Modern pino (v7+) doesn't build logger instances off `pino.prototype`
  // the way this integration assumes — `pino.prototype.write` is undefined,
  // so tryPatchPino's own guard (`pino && pino.prototype && pino.prototype.write`)
  // never passes and nothing gets patched. This test intentionally uses the
  // real installed module (no mock) to document that current behavior; it
  // is not exercising working functionality.
  const realPino = require('pino');
  assert.equal(
    realPino?.prototype?.write,
    undefined,
    'if this starts failing, pino.prototype.write exists again upstream and tryPatchPino may need revisiting'
  );

  const { target, captureCalls } = fakeTarget({ debug: true });
  const originalLog = console.log;
  const logs: any[] = [];
  console.log = (...args: any[]) => { logs.push(args.join(' ')); };
  try {
    tryPatchPino(target);
  } finally {
    console.log = originalLog;
  }

  assert.equal(captureCalls.length, 0);
  assert.ok(!logs.some((line) => line.includes('Successfully auto-patched Pino logging')));
});
