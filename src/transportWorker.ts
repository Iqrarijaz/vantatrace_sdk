import { parentPort } from 'worker_threads';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import * as dns from 'dns';
import * as zlib from 'zlib';
import * as crypto from 'crypto';

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
const httpKeepAliveAgent = new http.Agent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 1000 });
const httpsKeepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 32, keepAliveMsecs: 1000 });

const dnsCache = new Map<string, { address: string; family: number; expires: number }>();
const DNS_TTL = 30000;

function cachedDnsLookup(hostname: string, options: any, callback: any) {
  if (typeof options === 'function') { callback = options; options = {}; }
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

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 200;
const MAX_DELAY_MS = 5000;

function calculateBackoffDelay(attempt: number): number {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt)));
  const jitter = Math.random() * exponential;
  return Math.min(MAX_DELAY_MS, exponential + jitter);
}

// Backpressure tracking for the worker
let pendingRequestsCount = 0;
const queue: { apiUrl: string; apiKey: string; debug: boolean; batch: any[] }[] = [];

function notifyBackpressure() {
  if (parentPort) {
    parentPort.postMessage({ type: 'backpressure', pendingRequestsCount });
  }
}

function processNext() {
  if (queue.length === 0) return;
  if (pendingRequestsCount >= 50) return; // Wait until some requests finish

  const item = queue.shift();
  if (!item) return;

  pendingRequestsCount++;
  notifyBackpressure();

  sendBatch(item.apiUrl, item.apiKey, item.batch, item.debug)
    .finally(() => {
      pendingRequestsCount--;
      notifyBackpressure();
      processNext();
    });
}

function sendBatch(apiUrl: string, apiKey: string, batch: any[], debug: boolean, retriesRemaining = MAX_RETRIES, attempt = 0): Promise<void> {
  return new Promise<void>((resolve) => {
    const logDebug = (msg: string) => {
      if (debug && parentPort) {
        parentPort.postMessage({ type: 'debug', message: msg });
      }
    };

    const parsedUrl = new URL(apiUrl);
    let postData: string;
    try {
      // In a dedicated worker thread, a single synchronous JSON.stringify is fine
      // because there is no application event loop to block.
      postData = JSON.stringify(batch);
    } catch (err: any) {
      logDebug(`Batch serialization failed: ${err.message}`);
      return resolve();
    }

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
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            logDebug(`Batch of ${batch.length} events sent successfully${isCompressed ? ' (gzipped)' : ''}`);
            resolve();
          } else {
            logDebug(`Failed to send batch of events. Status: ${res.statusCode}`);
            if (res.statusCode === 403 || res.headers['x-vantatrace-disabled'] === 'true') {
              if (parentPort) parentPort.postMessage({ type: 'keyDisabled', apiKey });
              return resolve();
            }
            try {
              const parsed = JSON.parse(responseBody);
              if (parsed.disabled === true) {
                if (parentPort) parentPort.postMessage({ type: 'keyDisabled', apiKey });
                return resolve();
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
          setTimeout(() => {
            sendBatch(apiUrl, apiKey, batch, debug, retriesRemaining - 1, attempt + 1).then(resolve);
          }, delay);
        } else {
          if (parentPort) parentPort.postMessage({ type: 'dropped', reason: 'sendFailureExhausted', count: batch.length });
          logDebug(`Retries exhausted — dropping batch of ${batch.length} event(s).`);
          resolve();
        }
      };

      req.on('error', (err) => {
        logDebug(`Batch request error: ${err.message}`);
        handleRetry();
      });

      req.on('timeout', () => {
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
  });
}

if (parentPort) {
  parentPort.on('message', (msg) => {
    if (msg.type === 'batch') {
      queue.push({
        apiUrl: msg.apiUrl,
        apiKey: msg.apiKey,
        debug: msg.debug,
        batch: msg.batch
      });
      processNext();
    } else if (msg.type === 'flush') {
      parentPort?.postMessage({ type: 'flushed' });
    }
  });
}
