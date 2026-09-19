import fs from 'fs';
import http from 'http';
import https from 'https';
import { isIP } from 'net';
import { checkServerIdentity } from 'tls';
import { PORT } from './constants';
import { isNativeTlsEnabled, TLS_CA_FILE_ENV } from './nativeTls';

const LOOPBACK = '127.0.0.1';

/**
 * TLS identity name used to verify the hub cert. TCP is always 127.0.0.1;
 * verification uses the SENCHO_PUBLIC_URL hostname (the name agents dial)
 * so a DNS or LAN-IP SAN still matches. Unset or unparsable SENCHO_PUBLIC_URL
 * falls back to 127.0.0.1. Bracketed IPv6 hostnames are unwrapped the same
 * way outbound URL checks unwrap them.
 */
export function loopbackTlsServername(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.SENCHO_PUBLIC_URL?.trim();
  if (!raw) return LOOPBACK;
  try {
    const host = new URL(raw).hostname;
    const name = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
    return name || LOOPBACK;
  } catch {
    return LOOPBACK;
  }
}

/**
 * Loopback GET /api/health used by the image HEALTHCHECK. When native TLS is
 * on, the probe speaks HTTPS to 127.0.0.1 with certificate verification
 * enabled. Identity is checked against SENCHO_PUBLIC_URL so the SAN matches
 * the name agents dial. SNI is sent only for DNS names (Node rejects an IP
 * as TLS servername). If set, SENCHO_TLS_CA_FILE is passed as `ca` so a
 * private issuer verifies.
 */
export function probeLocalHealth(port: number = PORT): Promise<number> {
  return new Promise((resolve, reject) => {
    const base: http.RequestOptions = {
      hostname: LOOPBACK,
      port,
      path: '/api/health',
      timeout: 4000,
    };
    function onResponse(res: http.IncomingMessage): void {
      res.resume();
      resolve(res.statusCode ?? 0);
    }
    let req: http.ClientRequest;
    if (isNativeTlsEnabled()) {
      const expectedName = loopbackTlsServername();
      const tlsOpts: https.RequestOptions = {
        ...base,
        checkServerIdentity: (_host, cert) => checkServerIdentity(expectedName, cert),
      };
      if (!isIP(expectedName)) tlsOpts.servername = expectedName;
      const caPath = process.env[TLS_CA_FILE_ENV]?.trim();
      if (caPath) tlsOpts.ca = fs.readFileSync(caPath);
      req = https.get(tlsOpts, onResponse);
    } else {
      req = http.get(base, onResponse);
    }
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('healthcheck timed out'));
    });
  });
}
