import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureExceptionGlobal } from './runtime';
import { registerGlobalInstance, _resetForTests } from './registry';

test('runtime module re-exports a working captureExceptionGlobal', () => {
  _resetForTests();
  let called = false;
  const fakeInstance = {
    captureException: () => {
      called = true;
    }
  } as any;
  registerGlobalInstance(fakeInstance, false);

  captureExceptionGlobal(new Error('boom'));

  assert.equal(called, true);
});
