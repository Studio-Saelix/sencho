import http from 'http';
import https from 'https';
import { PORT } from './constants';
import { isNativeTlsEnabled } from './nativeTls';

/**
 * Loopback GET /api/health used by the image HEALTHCHECK. When native TLS is
 * on, the probe speaks HTTPS and sets rejectUnauthorized to false because it
 * dials 127.0.0.1 in this container, which will not match a DNS or public-IP
 * certificate SAN.
 */
export function probeLocalHealth(port: number = PORT): Promise<number> {
  return new Promise((resolve, reject) => {
    const useTls = isNativeTlsEnabled();
    const opts = {
      hostname: '127.0.0.1',
      port,
      path: '/api/health',
      timeout: 4000,
    };
    function onResponse(res: http.IncomingMessage): void {
      res.resume();
      resolve(res.statusCode ?? 0);
    }
    const req = useTls
      ? https.get({ ...opts, rejectUnauthorized: false }, onResponse)
      : http.get(opts, onResponse);
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('healthcheck timed out'));
    });
  });
}
