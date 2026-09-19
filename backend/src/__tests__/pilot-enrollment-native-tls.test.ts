/**
 * Pilot enrollment when the hub terminates TLS itself. Cert and key must be
 * set before importing the app because createServer reads them once.
 * Enrollment URL and CA are read per request.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'fs';
import request from 'supertest';
import { parse as parseYaml } from 'yaml';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { writeSelfSignedTls } from './__helpers__/selfSignedTls';
import { PILOT_CA_CONTAINER_PATH, PILOT_CA_HOST_SOURCE } from '../helpers/pilotEnrollmentCompose';

interface ComposeFile {
  services: {
    agent: {
      volumes: Array<string | { type: string; source: string; target: string }>;
      environment: Record<string, string>;
    };
  };
}

const ORIGINAL_PUBLIC = process.env.SENCHO_PUBLIC_URL;
const ORIGINAL_CERT = process.env.SENCHO_TLS_CERT_FILE;
const ORIGINAL_KEY = process.env.SENCHO_TLS_KEY_FILE;
const ORIGINAL_CA = process.env.SENCHO_TLS_CA_FILE;

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;
let files: ReturnType<typeof writeSelfSignedTls>;

beforeAll(async () => {
  files = writeSelfSignedTls();
  process.env.SENCHO_TLS_CERT_FILE = files.certFile;
  process.env.SENCHO_TLS_KEY_FILE = files.keyFile;
  delete process.env.SENCHO_TLS_CA_FILE;
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);
});

afterAll(() => {
  if (ORIGINAL_PUBLIC === undefined) delete process.env.SENCHO_PUBLIC_URL;
  else process.env.SENCHO_PUBLIC_URL = ORIGINAL_PUBLIC;
  if (ORIGINAL_CERT === undefined) delete process.env.SENCHO_TLS_CERT_FILE;
  else process.env.SENCHO_TLS_CERT_FILE = ORIGINAL_CERT;
  if (ORIGINAL_KEY === undefined) delete process.env.SENCHO_TLS_KEY_FILE;
  else process.env.SENCHO_TLS_KEY_FILE = ORIGINAL_KEY;
  if (ORIGINAL_CA === undefined) delete process.env.SENCHO_TLS_CA_FILE;
  else process.env.SENCHO_TLS_CA_FILE = ORIGINAL_CA;
  cleanupTestDb(tmpDir);
  fs.rmSync(files.dir, { recursive: true, force: true });
});

describe('pilot enrollment with native hub TLS', () => {
  it('rewrites an http SENCHO_PUBLIC_URL to https', async () => {
    process.env.SENCHO_PUBLIC_URL = 'http://sencho.example.com:1852';
    delete process.env.SENCHO_TLS_CA_FILE;
    const res = await request(app)
      .post('/api/nodes')
      .set('Cookie', adminCookie)
      .send({ name: 'pilot-tls-rewrite', type: 'remote', mode: 'pilot_agent' });

    expect(res.status).toBe(200);
    const parsed = parseYaml(res.body.enrollment.composeYaml) as ComposeFile;
    expect(parsed.services.agent.environment.SENCHO_PRIMARY_URL).toBe('https://sencho.example.com:1852');
    expect(res.body.enrollment.caPem).toBeUndefined();
    expect(parsed.services.agent.environment.SENCHO_PILOT_CA_FILE).toBeUndefined();
  });

  it('includes the hub CA PEM and bind-mount when SENCHO_TLS_CA_FILE is set', async () => {
    process.env.SENCHO_PUBLIC_URL = 'https://sencho.example.com:1852';
    process.env.SENCHO_TLS_CA_FILE = files.caFile;
    const res = await request(app)
      .post('/api/nodes')
      .set('Cookie', adminCookie)
      .send({ name: 'pilot-tls-ca', type: 'remote', mode: 'pilot_agent' });

    expect(res.status).toBe(200);
    expect(res.body.enrollment.caPem).toBe(fs.readFileSync(files.caFile, 'utf8'));
    const parsed = parseYaml(res.body.enrollment.composeYaml) as ComposeFile;
    expect(parsed.services.agent.environment.SENCHO_PRIMARY_URL).toBe('https://sencho.example.com:1852');
    expect(parsed.services.agent.environment.SENCHO_PILOT_CA_FILE).toBe(PILOT_CA_CONTAINER_PATH);
    expect(parsed.services.agent.volumes).toContain(
      `${PILOT_CA_HOST_SOURCE}:${PILOT_CA_CONTAINER_PATH}:ro`,
    );
  });
});
