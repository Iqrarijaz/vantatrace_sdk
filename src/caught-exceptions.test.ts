import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'async_hooks';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { startCaughtExceptionWatcher, CaughtExceptionInfo } from './caught-exceptions';

type Recorded = { error: any; info: CaughtExceptionInfo };

// The default selfDir is this module's own directory, which would also filter
// exceptions thrown from this test file — point it somewhere inert instead.
const TEST_SELF_DIR = '/vantatrace-nonexistent-self-dir';

function withWatcher(
  options: Partial<Parameters<typeof startCaughtExceptionWatcher>[1]>,
  fn: (recorded: Recorded[]) => void
): void {
  const recorded: Recorded[] = [];
  const stop = startCaughtExceptionWatcher(
    (error, info) => recorded.push({ error, info }),
    {
      includeNodeModules: false,
      maxPerMinute: 1000,
      debug: false,
      selfDir: TEST_SELF_DIR,
      ...options
    }
  );
  assert.ok(stop, 'watcher should start (inspector available in test runtime)');
  try {
    fn(recorded);
  } finally {
    stop!();
  }
}

test('captures a V8-generated ReferenceError swallowed by a local try/catch', () => {
  withWatcher({}, (recorded) => {
    let thrown: any = null;
    try {
      // @ts-expect-error intentional undefined reference
      a;
    } catch (e) {
      thrown = e; // swallowed — never reported manually
    }

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].error, thrown, 'the REAL error object is delivered, not a copy');
    assert.equal(recorded[0].error.name, 'ReferenceError');
    assert.equal(recorded[0].info.uncaught, false);
  });
});

test('delivery is synchronous at the throw site and preserves AsyncLocalStorage context', () => {
  const als = new AsyncLocalStorage<{ requestId: string }>();
  let storeAtCapture: any = 'not-called';

  const stop = startCaughtExceptionWatcher(
    () => {
      storeAtCapture = als.getStore();
    },
    { includeNodeModules: false, maxPerMinute: 1000, debug: false, selfDir: TEST_SELF_DIR }
  );
  assert.ok(stop);
  try {
    als.run({ requestId: 'req-42' }, () => {
      try {
        throw new Error('handled locally');
      } catch (_e) { /* swallowed */ }
    });
    assert.deepEqual(storeAtCapture, { requestId: 'req-42' });
  } finally {
    stop!();
  }
});

test('captures exceptions caught around await in async functions', async () => {
  const recorded: Recorded[] = [];
  const stop = startCaughtExceptionWatcher(
    (error, info) => recorded.push({ error, info }),
    { includeNodeModules: false, maxPerMinute: 1000, debug: false, selfDir: TEST_SELF_DIR }
  );
  assert.ok(stop);
  try {
    const boom = async () => {
      throw new TypeError('async boom');
    };
    try {
      await boom();
    } catch (_e) { /* swallowed */ }

    assert.ok(recorded.some(r => r.error instanceof TypeError && r.error.message === 'async boom'));
  } finally {
    stop!();
  }
});

test('captures thrown primitives (throw "string")', () => {
  withWatcher({}, (recorded) => {
    try {
      // eslint-disable-next-line no-throw-literal
      throw 'plain string failure';
    } catch (_e) { /* swallowed */ }

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].error, 'plain string failure');
  });
});

test('skips exceptions thrown from inside node_modules by default', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vantatrace-test-'));
  const libDir = path.join(tmpDir, 'node_modules', 'fake-lib');
  fs.mkdirSync(libDir, { recursive: true });
  const libFile = path.join(libDir, 'index.js');
  fs.writeFileSync(libFile, 'module.exports = function libThrow() { throw new Error("internal lib control flow"); };\n');

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const libThrow = require(libFile);

    withWatcher({}, (recorded) => {
      try {
        libThrow();
      } catch (_e) { /* swallowed */ }
      assert.equal(recorded.length, 0, 'node_modules throw origin must be filtered');
    });

    withWatcher({ includeNodeModules: true }, (recorded) => {
      try {
        libThrow();
      } catch (_e) { /* swallowed */ }
      assert.equal(recorded.length, 1, 'includeNodeModules: true captures it');
      assert.equal(recorded[0].error.message, 'internal lib control flow');
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('rate limit caps recorded exceptions per window', () => {
  withWatcher({ maxPerMinute: 3 }, (recorded) => {
    for (let i = 0; i < 10; i++) {
      try {
        throw new Error(`burst ${i}`);
      } catch (_e) { /* swallowed */ }
    }
    assert.equal(recorded.length, 3);
  });
});

test('a throwing onCaught callback never breaks the host application', () => {
  const stop = startCaughtExceptionWatcher(
    () => {
      throw new Error('SDK consumer callback bug');
    },
    { includeNodeModules: false, maxPerMinute: 1000, debug: false, selfDir: TEST_SELF_DIR }
  );
  assert.ok(stop);
  try {
    let reached = false;
    try {
      throw new Error('app error');
    } catch (_e) {
      reached = true;
    }
    assert.equal(reached, true, 'app catch block still runs normally');
  } finally {
    stop!();
  }
});

test('stop() fully disables capture', () => {
  const recorded: Recorded[] = [];
  const stop = startCaughtExceptionWatcher(
    (error, info) => recorded.push({ error, info }),
    { includeNodeModules: false, maxPerMinute: 1000, debug: false, selfDir: TEST_SELF_DIR }
  );
  assert.ok(stop);
  stop!();
  stop!(); // idempotent

  try {
    throw new Error('after stop');
  } catch (_e) { /* swallowed */ }
  assert.equal(recorded.length, 0);
});
