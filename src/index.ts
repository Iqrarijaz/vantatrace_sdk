import { VantaTraceOptions, VantaTraceContext, ErrorPayload } from './types';
import { normalizeError } from './normalizer';
import { getSystemContext } from './context';
import { sendPayload } from './transport';

export class VantaTrace {
  private apiKey: string;
  private serviceName: string;
  private environment: string;
  private debug: boolean;
  private apiUrl: string;

  constructor(options: VantaTraceOptions) {
    this.apiKey = options.apiKey || '';
    this.serviceName = options.serviceName || 'unknown-service';

    let envInput = options.environment || process.env.NODE_ENV || 'development';
    if (this.apiKey.includes('live')) {
      envInput = 'live';
    } else if (this.apiKey.includes('test')) {
      envInput = 'test';
    }

    this.environment = (envInput === 'production' || envInput === 'prod' || envInput === 'live') ? 'live' : 'test';
    this.debug = !!options.debug;

    // Default to localhost:6000/api/events (Standard Ingestion Endpoint)
    this.apiUrl = options.apiUrl || 'https://api.vantatrace.com/api/events';

    if (!options.apiKey && this.debug) {
      console.warn('[VantaTrace] WARNING: API key is missing. SDK will run in dry-run mode.');
    }

    if (this.debug) {
      console.log(`[VantaTrace] Initialized SDK for service "${this.serviceName}" on environment "${this.environment}".`);
    }
  }

  /**
   * Primary method to capture exceptions and send them to VantaTrace
   */
  public captureException(error: any, context?: VantaTraceContext): void {
    try {
      if (!this.apiKey) {
        if (this.debug) {
          console.log('[VantaTrace] Dry-run: captured exception:', error, 'Context:', context);
        }
        return;
      }

      const normalized = normalizeError(error);
      const systemContext = getSystemContext();

      const payload: ErrorPayload = {
        apiKey: this.apiKey,
        serviceName: this.serviceName,
        environment: this.environment,
        timestamp: new Date().toISOString(),
        error: normalized,
        context: context || {},
        system: systemContext,
        severity: context?.severity
      };

      if (this.debug) {
        console.log(`[VantaTrace] Sending error event: ${normalized.name} - ${normalized.message} (Severity: ${payload.severity || 'default'})`);
      }

      sendPayload(this.apiUrl, this.apiKey, payload, this.debug);
    } catch (e: any) {
      if (this.debug) {
        console.error(`[VantaTrace] Failed to capture exception internally: ${e.message}`);
      }
    }
  }

  /**
   * Helper method to capture critical errors
   */
  public captureCritical(error: any, context?: Omit<VantaTraceContext, 'severity'>): void {
    this.captureException(error, { ...context, severity: 'critical' });
  }

  /**
   * Helper method to capture warning errors
   */
  public captureWarning(error: any, context?: Omit<VantaTraceContext, 'severity'>): void {
    this.captureException(error, { ...context, severity: 'warning' });
  }

  /**
   * Helper method to capture info messages/errors
   */
  public captureInfo(error: any, context?: Omit<VantaTraceContext, 'severity'>): void {
    this.captureException(error, { ...context, severity: 'info' });
  }

  /**
   * Express error handling middleware
   */
  public expressMiddleware() {
    return (err: any, req: any, res: any, next: any) => {
      let userId = undefined;
      if (req.user && typeof req.user === 'object') {
        userId = req.user.id || req.user._id || req.user.userId;
      } else if (req.userId) {
        userId = req.userId;
      }

      // Sanitize request body if password exists
      let sanitizedBody = undefined;
      if (req.body && typeof req.body === 'object') {
        sanitizedBody = { ...req.body };
        if ('password' in sanitizedBody) sanitizedBody.password = '[REDACTED]';
        if ('token' in sanitizedBody) sanitizedBody.token = '[REDACTED]';
      }

      // Extract client IP
      const ip = req.ip || (req.headers['x-forwarded-for'] as string) || req.socket?.remoteAddress;

      // Extract and sanitize headers
      const sanitizedHeaders: Record<string, any> = {};
      const sensitiveHeaderKeys = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization'];
      if (req.headers && typeof req.headers === 'object') {
        for (const [key, value] of Object.entries(req.headers)) {
          if (sensitiveHeaderKeys.includes(key.toLowerCase())) {
            sanitizedHeaders[key] = '[REDACTED]';
          } else {
            sanitizedHeaders[key] = value;
          }
        }
      }

      this.captureException(err, {
        userId: userId ? String(userId) : undefined,
        route: req.route?.path || req.path || req.url,
        method: req.method,
        ip: ip ? String(ip) : undefined,
        headers: sanitizedHeaders,
        metadata: {
          query: req.query,
          body: sanitizedBody
        }
      });
      next(err);
    };
  }

  /**
   * Automatically catch all uncaught exceptions and unhandled rejections
   */
  public initGlobalHandlers(): void {
    process.on('uncaughtException', (err) => {
      if (this.debug) {
        console.log('[VantaTrace] Captured uncaught exception globally');
      }
      this.captureException(err);

      // Let the exception bubble up to avoid inconsistent process state (standard practice)
      // but give a short time window for the async request to finish sending.
      setTimeout(() => {
        process.exit(1);
      }, 500);
    });

    process.on('unhandledRejection', (reason) => {
      if (this.debug) {
        console.log('[VantaTrace] Captured unhandled promise rejection globally');
      }
      const err = reason instanceof Error ? reason : new Error(String(reason));
      this.captureException(err);
    });
  }
}
export default VantaTrace;
