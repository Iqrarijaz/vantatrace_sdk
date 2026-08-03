import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import * as dns from 'dns';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
import * as path from 'path';
import { ErrorPayload } from './types';

// Pre-computed SHA-256 hash cache to avoid re-hashing on every send
const apiKeyHashCache = new Map<string, string>();
function getApiKeyHash(apiKey: string): string {
  let hash = apiKeyHashCache.get(apiKey);
  if (!hash) {
    hash = crypto.createHash('sha256').update(apiKey).digest('hex');
    apiKeyHashCache.set(apiKey, hash);
  }
  return hash;
}

// Keep-alive agents
const httpKeepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 1000 });
const httpsKeepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 1000 });
const dnsCache = new Map<string, { address: string; family: number; expires: number }>();
const DNS_TTL = 30000;

function cachedDnsLookup(hostname: string, options: any, callback: any) {
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }
  const now = Date.now();
  const cached = dnsCache.get(hostname);
  if (cached && cached.expires > now) {
    return callback(null, cached.address, cached.family);
  }
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err);
    dnsCache.set(hostname, { address, family, expires: Date.now() + DNS_TTL });
    callback(null, address, family);
  });
}

const disabledKeys = new Map<string, number>();
const DISABLED_KEY_TTL_MS = 5 * 60 * 1000; // Re-check disabled status after 5 minutes

function isKeyDisabled(apiKey: string): boolean {
  const expiry = disabledKeys.get(apiKey);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    disabledKeys.delete(apiKey);
    return false;
  }
  return true;
}

function markKeyDisabled(apiKey: string): void {
  disabledKeys.set(apiKey, Date.now() + DISABLED_KEY_TTL_MS);
}

// Concurrent connection tracking for backpressure management
let pendingRequestsCount = 0;
const MAX_PENDING_REQUESTS = 50; // Soft ceiling: start dropping low-severity errors
const ABSOLUTE_MAX_PENDING_REQUESTS = 100; // Hard ceiling: drop all errors to prevent OOM
const MAX_QUEUE_SIZE = 500; // Max payloads buffered in memory per API key bucket

export interface TransportDropStats {
  backpressureSoft: number;
  backpressureHard: number;
  apiKeyDisabled: number;
  sendFailureExhausted: number;
  queueOverflow: number;
}

const transportDrops: TransportDropStats = {
  backpressureSoft: 0,
  backpressureHard: 0,
  apiKeyDisabled: 0,
  sendFailureExhausted: 0,
  queueOverflow: 0
};

export function getTransportDropStats(): TransportDropStats {
  return { ...transportDrops };
}

export function resetTransportDropStats(): void {
  transportDrops.backpressureSoft = 0;
  transportDrops.backpressureHard = 0;
  transportDrops.apiKeyDisabled = 0;
  transportDrops.sendFailureExhausted = 0;
  transportDrops.queueOverflow = 0;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 5000;

export function calculateBackoffDelay(attempt: number): number {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt)));
  const jitter = Math.random() * exponential;
  return Math.min(MAX_DELAY_MS, exponential + jitter);
}

// Worker Thread setup
let worker: import('worker_threads').Worker | null = null;
let useWorker = false;
try {
  const { Worker } = require('worker_threads');
  if (Worker) useWorker = true;
} catch (e) {
  useWorker = false;
}

function getWorker(): import('worker_threads').Worker | null {
  if (!useWorker) return null;
  if (!worker) {
    const { Worker } = require('worker_threads');
    // Ensure we resolve the .js extension because we're running in compiled dist/
    let workerPath = path.join(__dirname, 'transportWorker.js');
    try {
      worker = new Worker(workerPath);
      worker!.on('message', (msg: any) => {
        if (msg.type === 'backpressure') {
          pendingRequestsCount = msg.pendingRequestsCount;
        } else if (msg.type === 'keyDisabled') {
          markKeyDisabled(msg.apiKey);
        } else if (msg.type === 'dropped' && msg.reason === 'sendFailureExhausted') {
          transportDrops.sendFailureExhausted += (msg.count || 0);
        } else if (msg.type === 'debug') {
          console.log(`[VantaTrace Worker] ${msg.message}`);
        }
      });
      worker!.on('error', (err: any) => {
        console.error(`[VantaTrace] Worker thread crashed: ${err.message}`);
        useWorker = false; // Fallback to in-process
        worker = null;
      });
    } catch (err) {
      useWorker = false;
      worker = null;
    }
  }
  return worker;
}

const queues = new Map<string, {
  apiUrl: string;
  apiKey: string;
  debug: boolean;
  entries: ErrorPayload[];
  timer: NodeJS.Timeout | null;
}>();

export function sendPayload(
  apiUrl: string,
  apiKey: string,
  payload: ErrorPayload,
  debug: boolean = false
): void {
  if (isKeyDisabled(apiKey)) {
    transportDrops.apiKeyDisabled++;
    if (debug) console.log(`[VantaTrace] Event skipped: API Key is temporarily disabled.`);
    return;
  }

  if (pendingRequestsCount >= ABSOLUTE_MAX_PENDING_REQUESTS) {
    transportDrops.backpressureHard++;
    if (debug) console.warn(`[VantaTrace] Hard backpressure ceiling reached (${pendingRequestsCount} active batches). Dropping event.`);
    return;
  }

  if (pendingRequestsCount >= MAX_PENDING_REQUESTS && payload.severity !== 'critical') {
    transportDrops.backpressureSoft++;
    if (debug) console.warn(`[VantaTrace] Soft backpressure ceiling reached (${pendingRequestsCount} active batches). Dropping non-critical event.`);
    return;
  }

  const queueKey = `${apiUrl}::${apiKey}`;
  let queue = queues.get(queueKey);
  if (!queue) {
    queue = { apiUrl, apiKey, debug, entries: [], timer: null };
    queues.set(queueKey, queue);
  }

  // Cap queue size to prevent OOM
  if (queue.entries.length >= MAX_QUEUE_SIZE) {
    transportDrops.queueOverflow++;
    if (debug) console.warn(`[VantaTrace] Queue overflow (${MAX_QUEUE_SIZE} events). Dropping event.`);
    return;
  }

  queue.entries.push(payload);

  const flush = () => {
    if (queue!.timer) {
      clearTimeout(queue!.timer);
      queue!.timer = null;
    }
    
    // Chunk flushes into sub-batches of 50
    while (queue!.entries.length > 0) {
      const batch = queue!.entries.splice(0, 50);
      if (batch.length > 0) {
        dispatchBatch(queue!.apiUrl, queue!.apiKey, batch, queue!.debug);
      }
    }
  };

  if (payload.severity === 'critical' || queue.entries.length >= 50) {
    flush();
  } else if (!queue.timer) {
    queue.timer = setTimeout(flush, 500);
    queue.timer.unref?.();
  }
}

export function flushAllQueues(): void {
  for (const queue of queues.values()) {
    if (queue.timer) {
      clearTimeout(queue.timer);
      queue.timer = null;
    }
    while (queue.entries.length > 0) {
      const batch = queue.entries.splice(0, 50);
      if (batch.length > 0) {
        dispatchBatch(queue.apiUrl, queue.apiKey, batch, queue.debug);
      }
    }
  }
}

const SERIALIZE_CHUNK_SIZE = 10;
export function serializeBatch(batch: ErrorPayload[]): Promise<string> {
  if (batch.length <= SERIALIZE_CHUNK_SIZE) {
    try {
      return Promise.resolve(JSON.stringify(batch));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  return new Promise((resolve, reject) => {
    const parts: string[] = [];
    let i = 0;
    const step = () => {
      try {
        const chunk = batch.slice(i, i + SERIALIZE_CHUNK_SIZE);
        parts.push(chunk.map((payload) => JSON.stringify(payload)).join(','));
        i += SERIALIZE_CHUNK_SIZE;
        if (i < batch.length) {
          setImmediate(step);
        } else {
          resolve(`[${parts.join(',')}]`);
        }
      } catch (err) {
        reject(err);
      }
    };
    step();
  });
}

function dispatchBatch(apiUrl: string, apiKey: string, batch: ErrorPayload[], debug: boolean) {
  const w = getWorker();
  if (w) {
    w.postMessage({ type: 'batch', apiUrl, apiKey, debug, batch });
  } else {
    sendBatchInProcess(apiUrl, apiKey, batch, debug);
  }
}

function sendBatchInProcess(
  apiUrl: string,
  apiKey: string,
  batch: ErrorPayload[],
  debug: boolean = false,
  retriesRemaining: number = MAX_RETRIES,
  attempt: number = 0
): void {
  const logDebug = (msg: string) => {
    if (debug) console.log(`[VantaTrace] ${msg}`);
  };

  let requestTracked = false;
  const trackRequestStart = () => {
    if (!requestTracked) {
      pendingRequestsCount++;
      requestTracked = true;
    }
  };
  const trackRequestEnd = () => {
    if (requestTracked) {
      pendingRequestsCount--;
      requestTracked = false;
    }
  };

  setImmediate(() => {
    trackRequestStart();
    const parsedUrl = new URL(apiUrl);

    serializeBatch(batch).then((postData) => {
      try {
        const rawBuffer = Buffer.from(postData, 'utf-8');

        const executeRequest = (bodyData: Buffer, isCompressed: boolean) => {
          const options: http.RequestOptions | https.RequestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': bodyData.length,
              'x-api-key': apiKey,
              'x-api-key-hash': getApiKeyHash(apiKey),
              ...(isCompressed ? { 'Content-Encoding': 'gzip' } : {})
            },
            timeout: 2000,
            agent: parsedUrl.protocol === 'https:' ? httpsKeepAliveAgent : httpKeepAliveAgent,
            lookup: cachedDnsLookup
          };

          const client = parsedUrl.protocol === 'https:' ? https : http;
          const req = client.request(options, (res) => {
            let responseBody = '';
            res.on('data', (chunk) => { responseBody += chunk; });
            res.on('end', () => {
              trackRequestEnd();
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                logDebug(`Batch of ${batch.length} events sent successfully${isCompressed ? ' (gzipped)' : ''}`);
              } else {
                logDebug(`Failed to send batch of events. Status: ${res.statusCode}`);
                if (res.statusCode === 403 || res.headers['x-vantatrace-disabled'] === 'true') {
                  logDebug(`API key ${apiKey} is disabled. Skipping subsequent calls.`);
                  markKeyDisabled(apiKey);
                  return;
                }
                try {
                  const parsed = JSON.parse(responseBody);
                  if (parsed.disabled === true) {
                    logDebug(`API key ${apiKey} is disabled. Skipping subsequent calls.`);
                    markKeyDisabled(apiKey);
                    return;
                  }
                } catch (_) {}
                handleRetry();
              }
            });
          });

          let retryHandled = false;
          const handleRetry = () => {
            if (retryHandled) return;
            retryHandled = true;
            if (retriesRemaining > 0) {
              const delay = calculateBackoffDelay(attempt);
              logDebug(`Retry sending batch in ${Math.round(delay)}ms, attempts remaining: ${retriesRemaining}`);
              const retryTimer = setTimeout(() => {
                sendBatchInProcess(apiUrl, apiKey, batch, debug, retriesRemaining - 1, attempt + 1);
              }, delay);
              retryTimer.unref?.();
            } else {
              transportDrops.sendFailureExhausted += batch.length;
              logDebug(`Retries exhausted — dropping batch of ${batch.length} event(s).`);
            }
          };

          req.on('error', (err) => {
            trackRequestEnd();
            logDebug(`Batch request error: ${err.message}`);
            handleRetry();
          });

          req.on('timeout', () => {
            trackRequestEnd();
            logDebug('Batch request timeout reached, aborting request');
            req.destroy();
            handleRetry();
          });

          req.write(bodyData);
          req.end();
        };

        if (rawBuffer.length > 10240) {
          zlib.gzip(rawBuffer, { level: 5 }, (err, compressed) => {
            if (err) {
              logDebug(`Compression failed, falling back to plaintext: ${err.message}`);
              executeRequest(rawBuffer, false);
            } else {
              executeRequest(compressed, true);
            }
          });
        } else {
          executeRequest(rawBuffer, false);
        }
      } catch (err: any) {
        trackRequestEnd();
        logDebug(`Transport batch execution failed: ${err.message}`);
      }
    }).catch((err: any) => {
      trackRequestEnd();
      logDebug(`Batch serialization failed: ${err?.message || err}`);
    });
  });
}
