import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  registerGlobalInstance,
  getGlobalInstance,
  captureExceptionGlobal,
  _resetForTests
} from './registry';

beforeEach(() => {
  _resetForTests();
});

test('registerGlobalInstance stores the first instance', () => {
  const fakeInstance = { captureException: () => {} } as any;
  registerGlobalInstance(fakeInstance, false);
  assert.equal(getGlobalInstance(), fakeInstance);
});

test('registerGlobalInstance keeps the first instance on a second registration', () => {
  const first = { captureException: () => {} } as any;
  const second = { captureException: () => {} } as any;
  registerGlobalInstance(first, false);
  registerGlobalInstance(second, false);
  assert.equal(getGlobalInstance(), first);
});

test('captureExceptionGlobal forwards error and context to the registered instance', () => {
  let capturedError: any = null;
  let capturedContext: any = null;
  const fakeInstance = {
    captureException: (error: any, context: any) => {
      capturedError = error;
      capturedContext = context;
    }
  } as any;
  registerGlobalInstance(fakeInstance, false);

  const err = new Error('boom');
  captureExceptionGlobal(err, { userId: 'u1' });

  assert.equal(capturedError, err);
  assert.deepEqual(capturedContext, { userId: 'u1' });
});

test('captureExceptionGlobal no-ops when no instance is registered', () => {
  assert.doesNotThrow(() => captureExceptionGlobal(new Error('boom')));
});
