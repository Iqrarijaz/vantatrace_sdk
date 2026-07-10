import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VantaTrace } from './index';
import { getGlobalInstance, captureExceptionGlobal, _resetForTests } from './registry';

test('constructing VantaTrace registers it as the global singleton', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  assert.equal(getGlobalInstance(), instance);
});

test('captureExceptionGlobal reaches captureException on the constructed instance', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });

  let seenError: any = null;
  const originalCapture = instance.captureException.bind(instance);
  instance.captureException = (error: any, context?: any) => {
    seenError = error;
    return originalCapture(error, context);
  };

  const err = new Error('integration boom');
  captureExceptionGlobal(err);

  assert.equal(seenError, err);
});
