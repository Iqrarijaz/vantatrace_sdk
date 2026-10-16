import * as crypto from 'crypto';
import { NormalizedCause } from './types';

export function getFingerprint(name: string, message: string, stack: string): string {
  const hash = crypto.createHash('md5');
  // Group by name, message, and the first 3 lines of the stack trace to ignore line number variations deep in libraries
  const cleanStack = (stack || '')
    .split('\n')
    .slice(0, 4)
    .map(line => line.trim())
    .join('\n');
  hash.update(`${name}:${message}:${cleanStack}`);
  return hash.digest('hex');
}

/**
 * Walk the native `Error.cause` chain (ES2022+) and return a normalized array.
 * Capped at MAX_CAUSE_DEPTH to prevent infinite loops from circular references.
 */
const MAX_CAUSE_DEPTH = 5;

function extractCauseChain(err: any): NormalizedCause[] | undefined {
  if (!err || typeof err !== 'object' || !err.cause) return undefined;

  const chain: NormalizedCause[] = [];
  const seen = new WeakSet();
  let current = err.cause;

  while (current && chain.length < MAX_CAUSE_DEPTH) {
    // Guard against circular cause references
    if (typeof current === 'object' && seen.has(current)) break;
    if (typeof current === 'object') seen.add(current);

    if (current instanceof Error) {
      chain.push({
        name: current.name || 'Error',
        message: current.message || 'Unknown error',
        stack: current.stack || '',
        code: 'code' in current ? String((current as any).code) : undefined,
        statusCode: 'statusCode' in current ? Number((current as any).statusCode) :
                     'status' in current ? Number((current as any).status) : undefined
      });
      current = (current as any).cause;
    } else if (typeof current === 'object' && current.message) {
      chain.push({
        name: current.name || 'Error',
        message: String(current.message),
        stack: current.stack || '',
        code: current.code ? String(current.code) : undefined,
        statusCode: current.statusCode ? Number(current.statusCode) : undefined
      });
      current = current.cause;
    } else {
      // Primitive cause (string, number, etc.) — record it and stop
      chain.push({
        name: 'Error',
        message: String(current),
        stack: ''
      });
      break;
    }
  }

  return chain.length > 0 ? chain : undefined;
}

function safeStringify(val: any, maxLength = 2048): string {
  try {
    const seen = new WeakSet();
    const str = JSON.stringify(val, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[CIRCULAR]';
        seen.add(value);
      }
      return value;
    });
    return str.length > maxLength ? `${str.slice(0, maxLength)}...[TRUNCATED]` : str;
  } catch (_e) {
    return String(val);
  }
}

export function normalizeError(err: any): {
  name: string;
  message: string;
  stack: string;
  fingerprint: string;
  code?: string;
  statusCode?: number;
  extra?: Record<string, any>;
  cause?: NormalizedCause[];
} {
  let name = 'Error';
  let message = 'Unknown error';
  let stack = '';
  let code: string | undefined = undefined;
  let statusCode: number | undefined = undefined;
  let extra: Record<string, any> | undefined = undefined;

  if (err instanceof Error) {
    name = err.name || 'Error';
    message = err.message || 'Unknown error';
    stack = err.stack || '';
    
    if ('code' in err) code = String((err as any).code);
    if ('status' in err) statusCode = Number((err as any).status);
    if ('statusCode' in err) statusCode = Number((err as any).statusCode);

    const extraKeys = Object.keys(err).filter(k => !['name', 'message', 'stack', 'code', 'status', 'statusCode', 'cause'].includes(k));
    if (extraKeys.length > 0) {
      extra = {};
      for (const key of extraKeys) {
        extra[key] = (err as any)[key];
      }
    }
  } else if (typeof err === 'string') {
    message = err;
    stack = new Error(err).stack || '';
  } else if (err && typeof err === 'object') {
    name = err.name || err.constructor?.name || 'Error';
    message = err.message || safeStringify(err);
    stack = err.stack || new Error(message).stack || '';

    if ('code' in err) code = String(err.code);
    if ('status' in err) statusCode = Number(err.status);
    if ('statusCode' in err) statusCode = Number(err.statusCode);

    const extraKeys = Object.keys(err).filter(k => !['name', 'message', 'stack', 'code', 'status', 'statusCode', 'cause'].includes(k));
    if (extraKeys.length > 0) {
      extra = {};
      for (const key of extraKeys) {
        extra[key] = err[key];
      }
    }
  } else {
    message = String(err);
    stack = new Error(message).stack || '';
  }

  const fingerprint = getFingerprint(name, message, stack);
  const cause = extractCauseChain(err);

  return { name, message, stack, fingerprint, code, statusCode, extra, cause };
}
