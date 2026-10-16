import { SpanType } from './types';
import { dynamicRequire } from './nodeRequire';

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

/**
 * Strips string/numeric/hex literals and inline comments from a SQL query
 * before it's used as a span name — a non-parameterized query (or a driver
 * that logs the fully-interpolated text) embeds real parameter values
 * directly, which for a fintech-shaped schema means CNICs, phone numbers,
 * PINs, and account numbers landing verbatim in captured telemetry.
 *
 * This is a fast regex-based scrub, not a SQL parser — it's a span label,
 * not something re-executed, so occasionally over-redacting a harmless
 * identifier (e.g. a double-quoted Postgres column name) is an acceptable
 * tradeoff for never under-redacting a real value. Order matters: string
 * literals are stripped first so comment-marker-shaped substrings *inside*
 * a string (e.g. `'foo--bar'`) can't be misread as a real comment once the
 * string content is gone.
 */
export function sanitizeSqlQuery(sql: string): string {
  if (typeof sql !== 'string' || !sql) return sql;

  let result = sql;

  // Single- and double-quoted string literals (handles '' as an escaped quote).
  result = result.replace(/'(?:[^'\\]|\\.|'')*'/g, '?');
  result = result.replace(/"(?:[^"\\]|\\.|"")*"/g, '?');

  // Now that string content is gone, remaining comment markers are real.
  result = result.replace(/\/\*[\s\S]*?\*\//g, ' '); // block comments
  result = result.replace(/--[^\n]*/g, ' '); // ANSI line comments
  result = result.replace(/(?:^|\s)#[^\n]*/g, ' '); // MySQL # line comments

  // Hex literals, then standalone numeric literals (word-boundary-bound, so
  // digits embedded in identifiers like `table_v2` are left untouched).
  result = result.replace(/\b0x[0-9a-fA-F]+\b/g, '?');
  result = result.replace(/-?\b\d+(\.\d+)?\b/g, '?');

  return result.replace(/\s+/g, ' ').trim();
}

/** Best-effort auto-instrumentation of `pg` (node-postgres) queries as DB spans. Silently no-ops if `pg` isn't installed. */
export function tryPatchPg(startSpan: SpanStarter, debug: boolean): void {
  try {
    const pg = dynamicRequire('pg');
    const nameOf = (args: any[]) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
      return text ? `pg.query: ${truncate(sanitizeSqlQuery(text))}` : 'pg.query';
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
    const mysql2 = dynamicRequire('mysql2');
    const nameOf = (args: any[]) => {
      const text = typeof args[0] === 'string' ? args[0] : args[0]?.sql;
      return text ? `mysql2.query: ${truncate(sanitizeSqlQuery(text))}` : 'mysql2.query';
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
    const RedisModule = dynamicRequire('ioredis');
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
