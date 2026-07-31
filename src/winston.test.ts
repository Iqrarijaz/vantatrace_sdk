import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, format, transports } from 'winston';
import { VantaTrace } from './index';
import { _resetForTests } from './registry';

type CapturedException = { error: any; context: any };
type CapturedBreadcrumb = { breadcrumb: any };

function spyOnCapture(instance: VantaTrace): CapturedException[] {
  const calls: CapturedException[] = [];
  const original = instance.captureException.bind(instance);
  instance.captureException = (error: any, context?: any) => {
    calls.push({ error, context });
    return original(error, context);
  };
  return calls;
}

function spyOnBreadcrumbs(instance: VantaTrace): CapturedBreadcrumb[] {
  const calls: CapturedBreadcrumb[] = [];
  const original = instance.addBreadcrumb.bind(instance);
  instance.addBreadcrumb = (breadcrumb: any) => {
    calls.push({ breadcrumb });
    return original(breadcrumb);
  };
  return calls;
}

/** Builds a real Winston logger with the SDK's dynamic transport attached, mirroring _tryPatchWinston(). */
function loggerWithVantaTrace(instance: VantaTrace) {
  const { createWinstonTransport } = require('./winston');
  const vantaTransport = createWinstonTransport(instance);
  return createLogger({
    level: 'debug',
    format: format.combine(format.timestamp(), format.json()),
    transports: [vantaTransport, new transports.Console({ silent: true })]
  });
}

test('a real Error logged via logger.error({ err }) is captured as an exception', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const calls = spyOnCapture(instance);
  const logger = loggerWithVantaTrace(instance);

  const err = new Error('ESB call failed');
  logger.error({ event: 'Error thrown', functionName: 'confirmOrder', err });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].error, err);
  assert.equal(calls[0].context.severity, 'critical');
});

test('a destructured { message, stack } object (not a real Error) is NOT captured as an exception', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const exceptionCalls = spyOnCapture(instance);
  const breadcrumbCalls = spyOnBreadcrumbs(instance);
  const logger = loggerWithVantaTrace(instance);

  const err = new Error('ESB call failed');
  logger.error({ event: 'Error thrown', functionName: 'confirmOrder', err: { message: err.message, stack: err.stack } });

  assert.equal(exceptionCalls.length, 0, 'no real Error instance present — nothing to capture as an exception');
  assert.equal(breadcrumbCalls.length, 1, 'falls back to a breadcrumb instead of being silently dropped');
  assert.equal(breadcrumbCalls[0].breadcrumb.level, 'error');
});

test('logger.info narration becomes a breadcrumb, not an exception', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const exceptionCalls = spyOnCapture(instance);
  const breadcrumbCalls = spyOnBreadcrumbs(instance);
  const logger = loggerWithVantaTrace(instance);

  logger.info({ event: 'ESB Request Object', functionName: 'tapShop.reversal', data: { amount: 500 } });

  assert.equal(exceptionCalls.length, 0);
  assert.equal(breadcrumbCalls.length, 1);
  assert.equal(breadcrumbCalls[0].breadcrumb.category, 'winston');
  assert.equal(breadcrumbCalls[0].breadcrumb.level, 'info');
  assert.equal(breadcrumbCalls[0].breadcrumb.message, 'ESB Request Object');
  assert.equal(breadcrumbCalls[0].breadcrumb.data.functionName, 'tapShop.reversal');
});

test('logger.debug narration also becomes a breadcrumb', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const breadcrumbCalls = spyOnBreadcrumbs(instance);
  const logger = loggerWithVantaTrace(instance);

  logger.debug({ event: 'ESB Request Object', functionName: 'tapShop.reversal', data: { amount: 500 } });

  assert.equal(breadcrumbCalls.length, 1);
  assert.equal(breadcrumbCalls[0].breadcrumb.level, 'info', "debug maps to the SDK's 'info' breadcrumb level");
});

test('logger.warn narration becomes a warning-level breadcrumb', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false });
  const breadcrumbCalls = spyOnBreadcrumbs(instance);
  const logger = loggerWithVantaTrace(instance);

  logger.warn({ event: 'Retrying request', attempt: 2 });

  assert.equal(breadcrumbCalls.length, 1);
  assert.equal(breadcrumbCalls[0].breadcrumb.level, 'warning');
});

test('project-specific maskingKeys redact sensitive fields in breadcrumb data', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false, maskingKeys: ['CNIC', 'ConsumerName'] });
  const breadcrumbCalls = spyOnBreadcrumbs(instance);
  const logger = loggerWithVantaTrace(instance);

  logger.info({ event: 'ESB Request Object', ConsumerName: 'Jane Doe', CNIC: '12345-1234567-1', orderId: 'ORD-1' });

  const data = breadcrumbCalls[0].breadcrumb.data;
  assert.equal(data.ConsumerName, '[REDACTED]');
  assert.equal(data.CNIC, '[REDACTED]');
  assert.equal(data.orderId, 'ORD-1');
});

test('maskingKeys also redact fields in the winstonInfo metadata attached to a real captured exception', () => {
  _resetForTests();
  const instance = new VantaTrace({ apiKey: '', debug: false, maskingKeys: ['mpin'] });
  const exceptionCalls = spyOnCapture(instance);
  const logger = loggerWithVantaTrace(instance);

  const err = new Error('payment failed');
  logger.error({ event: 'Error thrown', err, mpin: '1234', orderId: 'ORD-1' });

  assert.equal(exceptionCalls.length, 1);
  assert.equal(exceptionCalls[0].context.metadata.winstonInfo.mpin, '[REDACTED]');
  assert.equal(exceptionCalls[0].context.metadata.winstonInfo.orderId, 'ORD-1');
});
