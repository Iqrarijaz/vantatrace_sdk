import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import * as dns from 'dns';
import * as zlib from 'zlib';
import * as crypto from 'crypto';
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

// Keep-alive agents to enable connection pooling and reuse TCP/TLS sockets
const httpKeepAliveAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 32,
  keepAliveMsecs: 1000
});

const httpsKeepAliveAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 32,
  keepAliveMsecs: 1000
});

// Simple in-memory DNS Cache (hostname -> { address, family, expires })
const dnsCache = new Map<string, { address: string; family: number; expires: number }>();
const DNS_TTL = 30000; // Cache DNS queries for 30 seconds

/**
 * Custom cached DNS lookup resolver.
 * Prevents DNS lookup requests from blocking Node's libuv thread pool.
 */
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
    if (err) {
      return callback(err);
    }

    dnsCache.set(hostname, {
      address,
      family,
      expires: Date.now() + DNS_TTL
    });

    callback(null, address, family);
  });
}

// Queue system grouped by apiUrl and apiKey to batch payloads before sending
const queues = new Map<string, {
  apiUrl: string;
  apiKey: string;
  debug: boolean;
  entries: ErrorPayload[];
  timer: NodeJS.Timeout | null;
}>();

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

/**
 * Transport-level drop counters — every path that silently discards an event
 * (previously visible only via `debug: true` console lines, i.e. never in
 * production) increments one of these, so a consuming app can surface "N
 * events dropped" without needing debug logging enabled.
 */
export interface TransportDropStats {
  backpressureSoft: number;
  backpressureHard: number;
  apiKeyDisabled: number;
  sendFailureExhausted: number;
}

const transportDrops: TransportDropStats = {
  backpressureSoft: 0,
  backpressureHard: 0,
  apiKeyDisabled: 0,
  sendFailureExhausted: 0
};

export function getTransportDropStats(): TransportDropStats {
  return { ...transportDrops };
}

export function resetTransportDropStats(): void {
  transportDrops.backpressureSoft = 0;
  transportDrops.backpressureHard = 0;
  transportDrops.apiKeyDisabled = 0;
  transportDrops.sendFailureExhausted = 0;
}

// Retry policy for a failed batch send.
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 5000;

/**
 * Exponential backoff with jitter for a given retry attempt (0-indexed) —
 * a pure function of `attempt`, not stateful "decorrelated jitter" (which
 * tracks the previous delay across calls): `min(cap, base * 2^attempt)`,
 * plus an additive random jitter proportional to that term. This is the
 * simpler "equal/full jitter" family — it still staggers concurrent
 * retrying clients enough to avoid a synchronized retry stampede against
 * the ingestion endpoint, without needing delay state threaded through the
 * recursive retry calls.
 */
export function calculateBackoffDelay(attempt: number): number {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt)));
  const jitter = Math.random() * exponential;
  return Math.min(MAX_DELAY_MS, exponential + jitter);
}

/**
 * Queue an error payload and schedule flushing.
 * If the payload is marked critical (e.g. uncaught exceptions), it will flush immediately.
 */
export function sendPayload(
  apiUrl: string,
  apiKey: string,
  payload: ErrorPayload,
  debug: boolean = false
): void {
  if (isKeyDisabled(apiKey)) {
    transportDrops.apiKeyDisabled++;
    if (debug) {
      console.log(`[VantaTrace] Event skipped: API Key is temporarily disabled.`);
    }
    return;
  }

  // 1. Enforce hard backpressure ceiling
  if (pendingRequestsCount >= ABSOLUTE_MAX_PENDING_REQUESTS) {
    transportDrops.backpressureHard++;
    if (debug) {
      console.warn(`[VantaTrace] Hard backpressure ceiling reached (${pendingRequestsCount} active batches). Dropping event.`);
    }
    return;
  }

  // 2. Enforce soft backpressure ceiling
  if (pendingRequestsCount >= MAX_PENDING_REQUESTS && payload.severity !== 'critical') {
    transportDrops.backpressureSoft++;
    if (debug) {
      console.warn(`[VantaTrace] Soft backpressure ceiling reached (${pendingRequestsCount} active batches). Dropping non-critical event.`);
    }
    return;
  }

  const queueKey = `${apiUrl}::${apiKey}`;
  let queue = queues.get(queueKey);
  if (!queue) {
    queue = {
      apiUrl,
      apiKey,
      debug,
      entries: [],
      timer: null
    };
    queues.set(queueKey, queue);
  }

  queue.entries.push(payload);

  const flush = () => {
    if (queue.timer) {
      clearTimeout(queue.timer);
      queue.timer = null;
    }
    const batch = queue.entries.splice(0, queue.entries.length);
    if (batch.length === 0) return;
    
    sendBatch(queue.apiUrl, queue.apiKey, batch, queue.debug);
  };

  // Flush immediately if severity is critical, or when queue reaches 50 events
  if (payload.severity === 'critical' || queue.entries.length >= 50) {
    flush();
  } else if (!queue.timer) {
    // Standard delay of 500ms to batch low-severity errors
    queue.timer = setTimeout(flush, 500);
  }
}

/**
 * Flush all pending queued error batches immediately across all API key buckets.
 */
export function flushAllQueues(): void {
  for (const queue of queues.values()) {
    if (queue.timer) {
      clearTimeout(queue.timer);
      queue.timer = null;
    }
    const batch = queue.entries.splice(0, queue.entries.length);
    if (batch.length > 0) {
      sendBatch(queue.apiUrl, queue.apiKey, batch, queue.debug);
    }
  }
}

// A full batch (up to 50 events, each carrying system stats, sanitized
// request data, up to 50 breadcrumbs, up to 100 spans) can serialize to
// several hundred KB to ~1MB — a single JSON.stringify() call over that
// much nested data measurably blocks the event loop (empirically ~4-12ms
// for 1MB), right when an incident is generating exactly this much volume
// and every other in-flight request needs the event loop free. Below this
// threshold the direct single-call path is faster and simpler; there's no
// point paying chunking overhead for the common small-batch case.
const SERIALIZE_CHUNK_SIZE = 10;

/**
 * Serializes a batch to a JSON array string. For batches large enough to
 * matter, splits the work into chunks and yields to the event loop
 * (`setImmediate`) between them, trading one long blocking call for many
 * short ones that interleave with other pending I/O — not offloaded to a
 * worker thread, since transferring the batch there would itself require a
 * structured-clone serialization of comparable cost on this same main
 * thread before handoff, before the worker's own work even begins.
 */
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
    // Runs across multiple setImmediate ticks, so a throw here (e.g. a
    // circular reference in one payload) happens outside any enclosing
    // try/catch the caller might have — must be handled locally and
    // surfaced as a rejection, not left to crash the process as an
    // uncaught exception in a timer callback.
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

/**
 * Make the HTTP/HTTPS request using connection pooling to send a batch of events.
 */
function sendBatch(
  apiUrl: string,
  apiKey: string,
  batch: ErrorPayload[],
  debug: boolean = false,
  retriesRemaining: number = MAX_RETRIES,
  attempt: number = 0
): void {
  const logDebug = (msg: string) => {
    if (debug) {
      console.log(`[VantaTrace] ${msg}`);
    }
  };

  // Safe tracking wrappers to prevent double-decrement issues across multiple hooks
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

  // Yield control back to the event loop check phase (non-blocking deferral)
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
          timeout: 2000, // 2-second timeout for batches
          agent: parsedUrl.protocol === 'https:' ? httpsKeepAliveAgent : httpKeepAliveAgent,
          lookup: cachedDnsLookup // Use custom cached DNS lookup resolver
        };

        const client = parsedUrl.protocol === 'https:' ? https : http;

        const req = client.request(options, (res) => {
          let responseBody = '';
          res.on('data', (chunk) => {
            responseBody += chunk;
          });
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

        // Guards against handleRetry() firing twice for the same request —
        // req.destroy() on timeout can also emit a subsequent 'error' event
        // depending on Node version/platform, which would otherwise schedule
        // a duplicate retry (sending the batch twice) rather than just being
        // a harmless extra bookkeeping call.
        let retryHandled = false;
        const handleRetry = () => {
          if (retryHandled) return;
          retryHandled = true;

          if (retriesRemaining > 0) {
            const delay = calculateBackoffDelay(attempt);
            logDebug(`Retry sending batch in ${Math.round(delay)}ms, attempts remaining: ${retriesRemaining}`);
            const retryTimer = setTimeout(() => {
              sendBatch(apiUrl, apiKey, batch, debug, retriesRemaining - 1, attempt + 1);
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

      // Perform compression asynchronously only if size is > 10 KB (10240 bytes)
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
