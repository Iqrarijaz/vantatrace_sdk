import * as os from 'os';

export function getSystemContext() {
  const memoryUsage = process.memoryUsage();
  return {
    nodeVersion: process.version,
    hostname: os.hostname(),
    pid: process.pid,
    platform: os.platform(),
    arch: os.arch(),
    memory: {
      rss: memoryUsage.rss,
      heapTotal: memoryUsage.heapTotal,
      heapUsed: memoryUsage.heapUsed,
      external: memoryUsage.external,
      freeMem: os.freemem(),
      totalMem: os.totalmem()
    },
    loadavg: os.loadavg(),
    uptime: Math.round(process.uptime())
  };
}
