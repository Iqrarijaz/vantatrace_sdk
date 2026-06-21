export interface VantaTraceOptions {
  apiKey: string;
  serviceName: string;
  /** @deprecated Environment is automatically determined by the API Key. */
  environment?: string;
  debug?: boolean;
  apiUrl?: string;
}

export interface VantaTraceContext {
  userId?: string;
  route?: string;
  method?: string;
  ip?: string;
  headers?: Record<string, any>;
  metadata?: Record<string, any>;
  severity?: 'critical' | 'warning' | 'info';
}

export interface ErrorPayload {
  apiKey: string;
  serviceName: string;
  environment: string;
  timestamp: string;
  error: {
    message: string;
    stack: string;
    name: string;
    fingerprint: string;
    code?: string;
    statusCode?: number;
    extra?: Record<string, any>;
  };
  context: VantaTraceContext;
  system: {
    nodeVersion: string;
    hostname: string;
    pid: number;
    platform: string;
    arch: string;
    memory: {
      rss: number;
      heapTotal: number;
      heapUsed: number;
      external?: number;
      freeMem: number;
      totalMem: number;
    };
    loadavg: number[];
    uptime: number;
  };
  severity?: 'critical' | 'warning' | 'info';
}
