import { AsyncLocalStorage } from 'async_hooks';
import { VantaTraceContext } from './types';

/**
 * The single shared AsyncLocalStorage instance carrying per-request context
 * (breadcrumbs, spans, trace IDs, sanitized request data, ...). Lives in its
 * own module rather than as a class static so the various instrumentation
 * modules (console/HTTP/logger patching, the request-context builder, the
 * auto-capture finalizer) can all read/write it without needing a reference
 * to the VantaTrace instance itself — the same reason those modules already
 * take narrow callback interfaces instead of `this`.
 */
export const requestStorage = new AsyncLocalStorage<VantaTraceContext>();
