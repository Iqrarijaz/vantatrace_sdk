import { SpanType } from './types';

export type SpanStarter = (type: SpanType, name: string) => { end: () => void };

/**
 * Wraps a method on a prototype so every call is timed as a span, covering
 * both promise-returning and callback-style invocations (the two calling
 * conventions used by pg/mysql2/ioredis). Fail-silent and idempotent — safe
 * to call against a prototype more than once (guarded by __vantaPatched).
 */
function wrapQueryMethod(
  proto: any,
  methodName: string,
  spanType: SpanType,
  nameOf: (args: any[]) => string,
  startSpan: SpanStarter
): void {
  if (!proto || typeof proto[methodName] !== 'function' || proto[`__vantaPatched_${methodName}`]) return;
  const original = proto[methodName];

  proto[methodName] = function (...args: any[]) {
    const span = startSpan(spanType, nameOf(args));

    const lastArg = args[args.length - 1];
    if (typeof lastArg === 'function') {
      args[args.length - 1] = function (...cbArgs: any[]) {
        span.end();
        return lastArg.apply(this, cbArgs);
      };
      return original.apply(this, args);
    }

    const result = original.apply(this, args);
    if (result && typeof result.then === 'function') {
      result.then(() => span.end(), () => span.end());
      return result;
    }

    span.end();
    return result;
  };

  proto[`__vantaPatched_${methodName}`] = true;
}

const truncate = (text: any, max = 120): string => {
  const str = typeof text === 'string' ? text : String(text ?? '');
  return str.length > max ? `${str.slice(0, max)}...` : str;
};

/** Best-effort auto-instrumentation of `pg` (node-postgres) queries as DB spans. Silently no-ops if `pg` isn't installed. */
export function tryPatchPg(startSpan: SpanStarter, debug: boolean): void {
  try {
    const pg = require('pg');
    const nameOf = (args: any[]) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      return text ? `pg.query: ${truncate(text)}` : 'pg.query';
    };
    if (pg?.Client?.prototype) wrapQueryMethod(pg.Client.prototype, 'query', 'db', nameOf, startSpan);
    if (pg?.Pool?.prototype) wrapQueryMethod(pg.Pool.prototype, 'query', 'db', nameOf, startSpan);
    if (debug) console.log('[VantaTrace Debug] Successfully auto-patched pg for span tracking.');
  } catch (_) {
    // pg not installed — no-op
  }
}

/** Best-effort auto-instrumentation of `mysql2` queries as DB spans. Silently no-ops if `mysql2` isn't installed. */
export function tryPatchMysql2(startSpan: SpanStarter, debug: boolean): void {
  try {
    const mysql2 = require('mysql2');
    const nameOf = (args: any[]) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.sql;
      return text ? `mysql2.query: ${truncate(text)}` : 'mysql2.query';
    };
    if (mysql2?.Connection?.prototype) {
      wrapQueryMethod(mysql2.Connection.prototype, 'query', 'db', nameOf, startSpan);
      wrapQueryMethod(mysql2.Connection.prototype, 'execute', 'db', nameOf, startSpan);
    }
    if (mysql2?.Pool?.prototype) {
      wrapQueryMethod(mysql2.Pool.prototype, 'query', 'db', nameOf, startSpan);
      wrapQueryMethod(mysql2.Pool.prototype, 'execute', 'db', nameOf, startSpan);
    }
    if (debug) console.log('[VantaTrace Debug] Successfully auto-patched mysql2 for span tracking.');
  } catch (_) {
    // mysql2 not installed — no-op
  }
}

/** Best-effort auto-instrumentation of `ioredis` commands as Redis spans. Silently no-ops if `ioredis` isn't installed. */
export function tryPatchIoredis(startSpan: SpanStarter, debug: boolean): void {
  try {
    const RedisModule = require('ioredis');
    const Redis = RedisModule?.default || RedisModule;
    const nameOf = (args: any[]) => {
      const commandName = args[0]?.name;
      return commandName ? `redis.${commandName}` : 'redis.command';
    };
    if (Redis?.prototype) wrapQueryMethod(Redis.prototype, 'sendCommand', 'redis', nameOf, startSpan);
    if (debug) console.log('[VantaTrace Debug] Successfully auto-patched ioredis for span tracking.');
  } catch (_) {
    // ioredis not installed — no-op
  }
}
