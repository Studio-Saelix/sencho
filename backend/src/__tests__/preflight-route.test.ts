/**
 * Compose Doctor routes: GET returns the stored run (never-run before any run),
 * POST runs and persists. Both require stack:read and reject unauthenticated and
 * missing-stack requests. Docker render + snapshot are mocked.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { setupTestDb, cleanupTestDb, TEST_USERNAME, TEST_JWT_SECRET } from './helpers/setupTestDb';
import DockerController from '../services/DockerController';
import { ComposeService } from '../services/ComposeService';
import { isPreflightNoteFinding } from '../services/preflight/rules';

let tmpDir: string;
let app: import('express').Express;
let authHeader: string;

const STACK = 'preflightroute';

function stub(image = 'nginx:latest') {
  vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
    renderConfig: vi.fn().mockResolvedValue({
      rendered: JSON.stringify({ name: STACK, services: { web: { image, ports: [{ target: 80, published: '8080', protocol: 'tcp' }] } }, networks: {}, volumes: {} }),
      stderr: '', code: 0, timedOut: false,
    }),
    composeVersion: vi.fn().mockResolvedValue('5.6.0'),
  } as unknown as ComposeService);
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({
    getDependencySnapshot: vi.fn().mockResolvedValue({ containers: [], networks: [], volumes: [] }),
    getDocker: vi.fn(() => ({ listContainers: vi.fn().mockResolvedValue([]) })),
  } as unknown as DockerController);
}

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  authHeader = `Bearer ${jwt.sign({ username: TEST_USERNAME }, TEST_JWT_SECRET, { expiresIn: '5m' })}`;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('preflight routes', () => {
  let stackDir: string;
  beforeEach(() => {
    stackDir = path.join(process.env.COMPOSE_DIR as string, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:latest\n    ports:\n      - "8080:80"\n');
    stub();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(stackDir, { recursive: true, force: true });
  });

  it('GET returns a never-run report before any run', async () => {
    const res = await request(app).get(`/api/stacks/${STACK}/preflight`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('never-run');
    expect(res.body.findings).toEqual([]);
  });

  it('POST runs preflight, persists, and GET then returns the stored run', async () => {
    const run = await request(app).post(`/api/stacks/${STACK}/preflight/run`).set('Authorization', authHeader);
    expect(run.status).toBe(200);
    expect(run.body.renderable).toBe(true);
    expect(run.body.findings.length).toBeGreaterThan(0);
    expect(run.body.findings.map((f: { ruleId: string }) => f.ruleId)).toContain('port-exposed-all-interfaces');

    const get = await request(app).get(`/api/stacks/${STACK}/preflight`).set('Authorization', authHeader);
    expect(get.body.status).toBe(run.body.status);
    expect(get.body.findings.length).toBe(run.body.findings.length);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get(`/api/stacks/${STACK}/preflight`);
    expect(res.status).toBe(401);
  });

  it('returns 404 for a stack that does not exist', async () => {
    const res = await request(app).post('/api/stacks/nope-not-here/preflight/run').set('Authorization', authHeader);
    expect(res.status).toBe(404);
  });
});

describe('preflight acknowledgement routes', () => {
  let stackDir: string;
  beforeEach(() => {
    stackDir = path.join(process.env.COMPOSE_DIR as string, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), 'services:\n  web:\n    image: nginx:latest\n    ports:\n      - "8080:80"\n');
    stub();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(stackDir, { recursive: true, force: true });
  });

  it('POST acknowledges a finding and GET preflight reflects activeStatus', async () => {
    const run = await request(app).post(`/api/stacks/${STACK}/preflight/run`).set('Authorization', authHeader);
    expect(run.status).toBe(200);
    const target = run.body.findings.find((f: { ruleId: string }) => f.ruleId === 'port-exposed-all-interfaces');
    expect(target).toBeTruthy();

    const ack = await request(app)
      .post(`/api/stacks/${STACK}/preflight/acknowledgements`)
      .set('Authorization', authHeader)
      .send({ ruleId: target.ruleId, service: target.service ?? null, reason: 'intentional', expiryMode: 'forever' });
    expect(ack.status).toBe(201);

    const get = await request(app).get(`/api/stacks/${STACK}/preflight`).set('Authorization', authHeader);
    expect(get.body.acknowledgedCount).toBeGreaterThanOrEqual(1);
    const acked = get.body.findings.find((f: { ruleId: string; service?: string }) =>
      f.ruleId === target.ruleId && f.service === target.service);
    expect(acked?.acknowledged).toBe(true);
    expect(get.body.activeCount).toBe(
      get.body.findings.filter((f: { ruleId: string; acknowledged?: boolean }) =>
        !f.acknowledged && !isPreflightNoteFinding(f.ruleId)).length,
    );
  });

  it('DELETE clears an acknowledgement', async () => {
    await request(app).post(`/api/stacks/${STACK}/preflight/run`).set('Authorization', authHeader);
    const list = await request(app).get(`/api/stacks/${STACK}/preflight`).set('Authorization', authHeader);
    const target = list.body.findings[0];
    const ack = await request(app)
      .post(`/api/stacks/${STACK}/preflight/acknowledgements`)
      .set('Authorization', authHeader)
      .send({ ruleId: target.ruleId, service: target.service ?? null, expiryMode: 'forever' });
    const del = await request(app)
      .delete(`/api/stacks/${STACK}/preflight/acknowledgements/${ack.body.id}`)
      .set('Authorization', authHeader);
    expect(del.status).toBe(204);
    const get = await request(app).get(`/api/stacks/${STACK}/preflight`).set('Authorization', authHeader);
    const again = get.body.findings.find((f: { ruleId: string; service?: string }) =>
      f.ruleId === target.ruleId && f.service === target.service);
    expect(again?.acknowledged).toBe(false);
  });

  it('rejects until_image_change without a service', async () => {
    await request(app).post(`/api/stacks/${STACK}/preflight/run`).set('Authorization', authHeader);
    const res = await request(app)
      .post(`/api/stacks/${STACK}/preflight/acknowledgements`)
      .set('Authorization', authHeader)
      .send({ ruleId: 'port-exposed-all-interfaces', expiryMode: 'until_image_change' });
    expect(res.status).toBe(400);
  });

  it('rejects acknowledging informational note findings', async () => {
    await request(app).post(`/api/stacks/${STACK}/preflight/run`).set('Authorization', authHeader);
    const res = await request(app)
      .post(`/api/stacks/${STACK}/preflight/acknowledgements`)
      .set('Authorization', authHeader)
      .send({ ruleId: 'healthcheck-inherited', service: 'web', expiryMode: 'forever' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/notes cannot be acknowledged/i);
  });
});

describe('preflight responses redact credentials in findings and acknowledgements', () => {
  const CREDENTIAL_IMAGE = 'user:p4ssw0rdXYZ@registry.example.com/app';
  const NOTE = 'see postgres://bob:s3cretPASS@host/db and token=abcd1234efgh';
  const LEAKED = ['p4ssw0rdXYZ', 's3cretPASS', 'abcd1234efgh'];
  let stackDir: string;
  const get = (url: string) => request(app).get(url).set('Authorization', authHeader);
  const expectNoSecret = (body: unknown) => {
    const text = JSON.stringify(body);
    for (const secret of LEAKED) expect(text).not.toContain(secret);
  };

  beforeEach(async () => {
    // Earlier describes leave acknowledgements for this stack behind.
    const { DatabaseService } = await import('../services/DatabaseService');
    DatabaseService.getInstance().getDb().prepare('DELETE FROM preflight_acknowledgements WHERE stack_name = ?').run(STACK);
    stackDir = path.join(process.env.COMPOSE_DIR as string, STACK);
    fs.mkdirSync(stackDir, { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'compose.yaml'), `services:\n  web:\n    image: ${CREDENTIAL_IMAGE}\n`);
    stub(CREDENTIAL_IMAGE);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    fs.rmSync(stackDir, { recursive: true, force: true });
    const { DatabaseService } = await import('../services/DatabaseService');
    DatabaseService.getInstance().getDb().prepare('DELETE FROM preflight_acknowledgements WHERE stack_name = ?').run(STACK);
  });

  it('returns the same redacted report from a run as from a later read', async () => {
    const run = await request(app).post(`/api/stacks/${STACK}/preflight/run`).set('Authorization', authHeader);
    expect(run.status).toBe(200);
    const imageFinding = run.body.findings.find((f: { ruleId: string }) => f.ruleId === 'image-latest');
    expect(imageFinding.message).toContain('[redacted]@registry.example.com/app');
    expectNoSecret(run.body);

    const read = await get(`/api/stacks/${STACK}/preflight`);
    expectNoSecret(read.body);
    expect(run.body.findings).toEqual(read.body.findings);
  });

  it('stores the redacted copy, not the credential', async () => {
    await request(app).post(`/api/stacks/${STACK}/preflight/run`).set('Authorization', authHeader);
    const { DatabaseService } = await import('../services/DatabaseService');
    const rows = DatabaseService.getInstance().getDb()
      .prepare('SELECT title, message, source_path, remediation, subject_key FROM preflight_findings').all();
    expect(rows.length).toBeGreaterThan(0);
    expectNoSecret(rows);
  });

  it('redacts the acknowledgement reason on the run, the read, the list, and the create response', async () => {
    const run = await request(app).post(`/api/stacks/${STACK}/preflight/run`).set('Authorization', authHeader);
    const target = run.body.findings.find((f: { ruleId: string }) => f.ruleId === 'image-latest');
    const created = await request(app)
      .post(`/api/stacks/${STACK}/preflight/acknowledgements`)
      .set('Authorization', authHeader)
      .send({ ruleId: target.ruleId, service: target.service, reason: NOTE, expiryMode: 'forever' });
    expect(created.status).toBe(201);
    expectNoSecret(created.body);
    expect(created.body.reason).toContain('[redacted]');

    const read = await get(`/api/stacks/${STACK}/preflight`);
    const list = await get(`/api/stacks/${STACK}/preflight/acknowledgements`);
    const rerun = await request(app).post(`/api/stacks/${STACK}/preflight/run`).set('Authorization', authHeader);
    for (const body of [read.body, list.body, rerun.body]) expectNoSecret(body);
    const decided = (report: { findings: { ruleId: string; acknowledgementReason?: string }[] }) =>
      report.findings.find(f => f.ruleId === 'image-latest')?.acknowledgementReason;
    expect(decided(read.body)).toContain('[redacted]');
    expect(decided(rerun.body)).toBe(decided(read.body));
    expect(list.body[0].reason).toBe(created.body.reason);
  });

  it('redacts the image anchor of an until_image_change acknowledgement, and still matches on the raw anchor', async () => {
    const run = await request(app).post(`/api/stacks/${STACK}/preflight/run`).set('Authorization', authHeader);
    const target = run.body.findings.find((f: { ruleId: string }) => f.ruleId === 'image-latest');
    const created = await request(app)
      .post(`/api/stacks/${STACK}/preflight/acknowledgements`)
      .set('Authorization', authHeader)
      .send({ ruleId: target.ruleId, service: target.service, reason: 'ok', expiryMode: 'until_image_change' });
    expect(created.status).toBe(201);
    expectNoSecret(created.body);
    expect(created.body.anchor_image_ref).toContain('[redacted]@registry.example.com/app');

    const list = await get(`/api/stacks/${STACK}/preflight/acknowledgements`);
    expectNoSecret(list.body);
    expect(list.body[0].active).toBe(true);
    // The stored anchor is raw: the expiry check compares against it.
    const read = await get(`/api/stacks/${STACK}/preflight`);
    expect(read.body.findings.find((f: { ruleId: string }) => f.ruleId === 'image-latest').acknowledged).toBe(true);
  });

  it('keeps an ordinary note readable', async () => {
    const run = await request(app).post(`/api/stacks/${STACK}/preflight/run`).set('Authorization', authHeader);
    const target = run.body.findings.find((f: { ruleId: string }) => f.ruleId === 'image-latest');
    await request(app)
      .post(`/api/stacks/${STACK}/preflight/acknowledgements`)
      .set('Authorization', authHeader)
      .send({ ruleId: target.ruleId, service: target.service, reason: 'pinned by the platform team', expiryMode: 'forever' });
    const read = await get(`/api/stacks/${STACK}/preflight`);
    expect(read.body.findings.find((f: { ruleId: string }) => f.ruleId === 'image-latest').acknowledgementReason)
      .toBe('pinned by the platform team');
  });
});
