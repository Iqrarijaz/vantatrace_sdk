import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { ErrorPayload } from './types';

export function sendPayload(
  apiUrl: string,
  apiKey: string,
  payload: ErrorPayload,
  debug: boolean = false,
  retriesRemaining: number = 1
): void {
  const logDebug = (msg: string) => {
    if (debug) {
      console.log(`[VantaTrace] ${msg}`);
    }
  };

  // Run asynchronously to ensure we don't block the caller
  process.nextTick(() => {
    try {
      const parsedUrl = new URL(apiUrl);
      const postData = JSON.stringify(payload);
      
      const options: http.RequestOptions | https.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
          'x-api-key': apiKey
        },
        timeout: 300 // 300ms max timeout
      };

      const client = parsedUrl.protocol === 'https:' ? https : http;

      const req = client.request(options, (res) => {
        // Consume response data to prevent resource leaks
        res.on('data', () => {});
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            logDebug('Event sent successfully');
          } else {
            logDebug(`Failed to send event. Status: ${res.statusCode}`);
            handleRetry();
          }
        });
      });

      const handleRetry = () => {
        if (retriesRemaining > 0) {
          logDebug(`Retry attempt ${2 - retriesRemaining}`);
          sendPayload(apiUrl, apiKey, payload, debug, retriesRemaining - 1);
        }
      };

      req.on('error', (err) => {
        logDebug(`Request error: ${err.message}`);
        handleRetry();
      });

      req.on('timeout', () => {
        logDebug('Timeout reached, aborting request');
        req.destroy();
      });

      req.write(postData);
      req.end();
    } catch (err: any) {
      logDebug(`Transport execution failed: ${err.message}`);
    }
  });
}
