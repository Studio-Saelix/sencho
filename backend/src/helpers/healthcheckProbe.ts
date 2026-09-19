import http from 'http';
import https from 'https';
import { isIP } from 'net';
import { checkServerIdentity, getCACertificates, setDefaultCACertificates } from 'tls';
import { PORT } from './constants';
import { isNativeTlsEnabled } from './nativeTls';

const LOOPBACK = '127.0.0.1';

/**
 * TLS identity for the loopback HEALTHCHECK. TCP is always 127.0.0.1;
 * verification uses SENCHO_PUBLIC_URL (the name agents dial) so a DNS or
 * LAN-IP SAN still matches. Unset or unparsable values fall back to
 * 127.0.0.1. Bracketed IPv6 hostnames are unwrapped.
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
 * Add a PEM CA to this process's default trust store. Returns a restore
 * function. HEALTHCHECK uses this so the loopback GET can verify a private
 * issuer without putting file bytes into https.get options.
 */
export function trustHealthcheckCa(caPem: string): () => void {
  const previous = getCACertificates();
  setDefaultCACertificates([...previous, caPem]);
  return () => setDefaultCACertificates(previous);
}

/**
 * Loopback GET /api/health. With native TLS, speaks HTTPS to 127.0.0.1 and
 * verifies identity against SENCHO_PUBLIC_URL. SNI is sent only for DNS
 * names. Private issuers must already be in the process default CA list.
 */
export function probeLocalHealth(port: number = PORT): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = requestLocalHealth(port, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('healthcheck timed out'));
    });
  });
}

function requestLocalHealth(
  port: number,
  onResponse: (res: http.IncomingMessage) => void,
): http.ClientRequest {
  const base: http.RequestOptions = {
    hostname: LOOPBACK,
    port,
    path: '/api/health',
    timeout: 4000,
  };
  if (!isNativeTlsEnabled()) return http.get(base, onResponse);

  const expectedName = loopbackTlsServername();
  const options: https.RequestOptions = {
    ...base,
    checkServerIdentity: (_host, cert) => checkServerIdentity(expectedName, cert),
  };
  if (!isIP(expectedName)) options.servername = expectedName;
  return https.get(options, onResponse);
}
