import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface SelfSignedTlsFiles {
  dir: string;
  certFile: string;
  keyFile: string;
  caFile: string;
  caPem: string;
}

/**
 * Write a 1-day self-signed leaf with an iPAddress SAN for 127.0.0.1.
 * The same PEM is the CA bundle for enrollment tests (self-signed leaf).
 */
export function writeSelfSignedTls(prefix = 'sencho-tls-'): SelfSignedTlsFiles {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const caFile = path.join(dir, 'ca.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1',
    '-nodes',
    '-keyout', keyFile,
    '-out', certFile,
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'pipe' });
  const caPem = fs.readFileSync(certFile, 'utf8');
  fs.writeFileSync(caFile, caPem);
  return { dir, certFile, keyFile, caFile, caPem };
}
