/**
 * Native hub TLS: cert+key files opt the HTTP listener into https.createServer
 * so Pilot upgrades set socket.encrypted and registry delivery can proceed
 * without a reverse proxy.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { TLSSocket } from 'tls';
import { writeSelfSignedTls, type SelfSignedTlsFiles } from './__helpers__/selfSignedTls';
import {
  NativeTlsConfigError,
  isNativeTlsEnabled,
  loadNativeTlsMaterial,
  rewriteHttpUrlToHttps,
} from '../helpers/nativeTls';
import { createServer } from '../server';
import { probeLocalHealth } from '../helpers/healthcheckProbe';

const TLS_ENV = [
  'SENCHO_TLS_CERT_FILE',
  'SENCHO_TLS_KEY_FILE',
  'SENCHO_TLS_CA_FILE',
  'SENCHO_TLS_KEY_PASSPHRASE',
  'SENCHO_MODE',
] as const;

const originalEnv: Record<string, string | undefined> = {};
for (const key of TLS_ENV) originalEnv[key] = process.env[key];

afterEach(() => {
  for (const key of TLS_ENV) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe('loadNativeTlsMaterial', () => {
  it('returns null when neither cert nor key is set', () => {
    delete process.env.SENCHO_TLS_CERT_FILE;
    delete process.env.SENCHO_TLS_KEY_FILE;
    expect(isNativeTlsEnabled()).toBe(false);
    expect(loadNativeTlsMaterial()).toBeNull();
  });

  it('throws when only the cert file is set', () => {
    process.env.SENCHO_TLS_CERT_FILE = '/tmp/cert.pem';
    delete process.env.SENCHO_TLS_KEY_FILE;
    expect(() => loadNativeTlsMaterial()).toThrow(NativeTlsConfigError);
    expect(isNativeTlsEnabled()).toBe(false);
  });

  it('throws when only the key file is set', () => {
    delete process.env.SENCHO_TLS_CERT_FILE;
    process.env.SENCHO_TLS_KEY_FILE = '/tmp/key.pem';
    expect(() => loadNativeTlsMaterial()).toThrow(NativeTlsConfigError);
  });

  it('throws when the cert file cannot be read', () => {
    process.env.SENCHO_TLS_CERT_FILE = '/tmp/sencho-tls-missing-cert.pem';
    process.env.SENCHO_TLS_KEY_FILE = '/tmp/sencho-tls-missing-key.pem';
    expect(() => loadNativeTlsMaterial()).toThrow(NativeTlsConfigError);
  });

  it('loads key, cert, optional CA PEM, and passphrase', async () => {
    await withTlsFiles((files) => {
      process.env.SENCHO_TLS_CA_FILE = files.caFile;
      process.env.SENCHO_TLS_KEY_PASSPHRASE = 'secret';
      expect(isNativeTlsEnabled()).toBe(true);
      const material = loadNativeTlsMaterial();
      expect(material?.cert.includes('BEGIN CERTIFICATE')).toBe(true);
      expect(material?.key.includes('BEGIN')).toBe(true);
      expect(material?.caPem).toBe(fs.readFileSync(files.caFile, 'utf8'));
      expect(material?.passphrase).toBe('secret');
    });
  });

  it('throws when the cert file is empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-tls-empty-'));
    try {
      const certFile = path.join(dir, 'cert.pem');
      const keyFile = path.join(dir, 'key.pem');
      fs.writeFileSync(certFile, '  \n');
      fs.writeFileSync(keyFile, '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n');
      process.env.SENCHO_TLS_CERT_FILE = certFile;
      process.env.SENCHO_TLS_KEY_FILE = keyFile;
      expect(() => loadNativeTlsMaterial()).toThrow(NativeTlsConfigError);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when SENCHO_TLS_CA_FILE is set but unreadable', async () => {
    await withTlsFiles((files) => {
      process.env.SENCHO_TLS_CA_FILE = path.join(files.dir, 'missing-ca.pem');
      expect(() => loadNativeTlsMaterial()).toThrow(NativeTlsConfigError);
    });
  });

  it('ignores cert material when SENCHO_MODE=pilot', async () => {
    await withTlsFiles(() => {
      process.env.SENCHO_MODE = 'pilot';
      expect(isNativeTlsEnabled()).toBe(false);
      expect(loadNativeTlsMaterial()).toBeNull();
    });
  });
});

describe('rewriteHttpUrlToHttps', () => {
  it('rewrites http to https and leaves https unchanged', () => {
    expect(rewriteHttpUrlToHttps('http://192.168.1.50:1852')).toBe('https://192.168.1.50:1852');
    expect(rewriteHttpUrlToHttps('https://sencho.example.com')).toBe('https://sencho.example.com');
  });
});

describe('createServer native TLS', () => {
  it('serves HTTP when cert material is unset', async () => {
    delete process.env.SENCHO_TLS_CERT_FILE;
    delete process.env.SENCHO_TLS_KEY_FILE;
    await expectHttpPing();
  });

  it('throws when only one of cert or key is set', () => {
    process.env.SENCHO_TLS_CERT_FILE = '/tmp/cert.pem';
    delete process.env.SENCHO_TLS_KEY_FILE;
    expect(() => createServer(express())).toThrow(NativeTlsConfigError);
  });

  it('serves HTTPS and marks the socket encrypted when cert material is set', async () => {
    await withTlsFiles(async (files) => {
      const app = express();
      let encrypted: boolean | undefined;
      app.get('/ping', (req, res) => {
        encrypted = req.socket instanceof TLSSocket && req.socket.encrypted === true;
        res.send('ok');
      });
      const { server } = createServer(app);
      const port = await listen(server);
      try {
        expect(await httpsGet(port, '/ping', files.caFile)).toBe('ok');
        expect(encrypted).toBe(true);
      } finally {
        await close(server);
      }
    });
  });

  it('marks WebSocket upgrade sockets encrypted so the pilot confidentiality predicate can pass', async () => {
    await withTlsFiles(async (files) => {
      const { server } = createServer(express());
      const port = await listen(server);
      try {
        const encrypted = await new Promise<boolean>((resolve, reject) => {
          server.on('upgrade', (req, socket) => {
            resolve(req.socket instanceof TLSSocket && req.socket.encrypted === true);
            socket.destroy();
          });
          const req = https.request({
            hostname: '127.0.0.1',
            port,
            path: '/api/pilot/tunnel',
            method: 'GET',
            ca: fs.readFileSync(files.caFile),
            headers: {
              Connection: 'Upgrade',
              Upgrade: 'websocket',
              'Sec-WebSocket-Version': '13',
              'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
            },
          });
          req.on('error', reject);
          req.end();
        });
        expect(encrypted).toBe(true);
      } finally {
        await close(server);
      }
    });
  });

  it('keeps the HTTP loopback listener in SENCHO_MODE=pilot even when cert files are set', async () => {
    await withTlsFiles(async () => {
      process.env.SENCHO_MODE = 'pilot';
      await expectHttpPing();
    });
  });
});

describe('image HEALTHCHECK', () => {
  it('runs dist/healthcheck.js so the probe can speak HTTPS', () => {
    const dockerfile = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', 'Dockerfile'),
      'utf8',
    );
    expect(dockerfile).toContain('dist/healthcheck.js');
  });
});

describe('probeLocalHealth', () => {
  it('uses HTTP when native TLS is off', async () => {
    delete process.env.SENCHO_TLS_CERT_FILE;
    delete process.env.SENCHO_TLS_KEY_FILE;
    await expectHealthProbe();
  });

  it('uses HTTPS when native TLS is on', async () => {
    await withTlsFiles(async () => {
      await expectHealthProbe();
    });
  });

  it('uses HTTP in SENCHO_MODE=pilot even when cert files are set', async () => {
    await withTlsFiles(async () => {
      process.env.SENCHO_MODE = 'pilot';
      await expectHealthProbe();
    });
  });
});

/** Write a temp pair, set cert+key env, run, then delete the files. afterEach restores env. */
async function withTlsFiles(run: (files: SelfSignedTlsFiles) => Promise<void> | void): Promise<void> {
  const files = writeSelfSignedTls();
  process.env.SENCHO_TLS_CERT_FILE = files.certFile;
  process.env.SENCHO_TLS_KEY_FILE = files.keyFile;
  try {
    await run(files);
  } finally {
    fs.rmSync(files.dir, { recursive: true, force: true });
  }
}

async function expectHttpPing(): Promise<void> {
  const app = express();
  app.get('/ping', (_req, res) => res.send('ok'));
  const { server } = createServer(app);
  const port = await listen(server);
  try {
    expect(await httpGet(port, '/ping')).toBe('ok');
  } finally {
    await close(server);
  }
}

async function expectHealthProbe(): Promise<void> {
  const app = express();
  app.get('/api/health', (_req, res) => res.status(200).json({ status: 'ok' }));
  const { server } = createServer(app);
  const port = await listen(server);
  try {
    await expect(probeLocalHealth(port)).resolves.toBe(200);
  } finally {
    await close(server);
  }
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('server did not bind'));
        return;
      }
      resolve(addr.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function httpGet(port: number, pathName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${pathName}`, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function httpsGet(port: number, pathName: string, caFile: string): Promise<string> {
  return new Promise((resolve, reject) => {
    https.get({
      hostname: '127.0.0.1',
      port,
      path: pathName,
      ca: fs.readFileSync(caFile),
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}
