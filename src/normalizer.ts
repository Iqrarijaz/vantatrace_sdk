import * as crypto from 'crypto';

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

export function normalizeError(err: any): {
  name: string;
  message: string;
  stack: string;
  fingerprint: string;
  code?: string;
  statusCode?: number;
  extra?: Record<string, any>;
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

    const extraKeys = Object.keys(err).filter(k => !['name', 'message', 'stack', 'code', 'status', 'statusCode'].includes(k));
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
    message = err.message || JSON.stringify(err);
    stack = err.stack || new Error(message).stack || '';

    if ('code' in err) code = String(err.code);
    if ('status' in err) statusCode = Number(err.status);
    if ('statusCode' in err) statusCode = Number(err.statusCode);

    const extraKeys = Object.keys(err).filter(k => !['name', 'message', 'stack', 'code', 'status', 'statusCode'].includes(k));
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

  return { name, message, stack, fingerprint, code, statusCode, extra };
}
