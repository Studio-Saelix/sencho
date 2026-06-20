/**
 * buildEnvInventory status derivation, the hard no-value guarantee, and the
 * GET /api/stacks/:stackName/env-inventory route. The effective model render is
 * mocked; the filesystem and DB are real.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';
import { ComposeService } from '../services/ComposeService';
import { buildEnvInventory, type EnvInventory } from '../services/EnvInventoryService';

let tmpDir: string;
let app: import('express').Express;
let authCookie: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let nodeId: number;

function composeDir(): string { return process.env.COMPOSE_DIR as string; }

function writeStack(stack: string, files: Record<string, string>): void {
  const dir = path.join(composeDir(), stack);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
}

/** Mock the effective model render with the given injected env keys per service. */
function stubRender(serviceEnv: Record<string, Record<string, string>> | null, stderr = ''): void {
  const rendered = serviceEnv === null
    ? null
    : JSON.stringify({ name: 'proj', services: Object.fromEntries(Object.entries(serviceEnv).map(([s, env]) => [s, { environment: env }])) });
  vi.spyOn(ComposeService, 'getInstance').mockReturnValue({
    renderConfig: vi.fn().mockResolvedValue({ rendered, stderr, code: rendered === null ? 1 : 0, timedOut: false }),
  } as unknown as ComposeService);
}

const itemFor = (inv: EnvInventory, key: string) => inv.items.find(i => i.key === key);

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  authCookie = await loginAsTestAdmin(app);
  nodeId = (DatabaseService.getInstance().getDb().prepare('SELECT id FROM nodes WHERE is_default = 1').get() as { id: number }).id;
});

afterAll(() => cleanupTestDb(tmpDir));
afterEach(() => vi.restoreAllMocks());

describe('buildEnvInventory status derivation', () => {
  it('classifies present, unused, interpolation, and injection sources', async () => {
    writeStack('inv1', {
      'compose.yaml': 'services:\n  web:\n    image: nginx:${USED:-x}\n    environment:\n      INLINE_KEY: "1"\n    env_file:\n      - ./svc.env\n',
      '.env': 'USED=1\nUNUSED_VAR=2\n',
      'svc.env': 'FILE_KEY=3\n',
    });
    stubRender({ web: { INLINE_KEY: '1', FILE_KEY: '3' } });
    const inv = await buildEnvInventory(nodeId, 'inv1');
    expect(inv.renderable).toBe(true);
    expect(itemFor(inv, 'USED')).toMatchObject({ status: 'present', usedForInterpolation: true, sources: expect.arrayContaining(['dotenv']) });
    expect(itemFor(inv, 'UNUSED_VAR')).toMatchObject({ status: 'unused' });
    expect(itemFor(inv, 'INLINE_KEY')).toMatchObject({ injectedIntoService: true, sources: expect.arrayContaining(['compose-inline']) });
    const fileKey = itemFor(inv, 'FILE_KEY');
    expect(fileKey?.sources).toContain('env-file');
    expect(fileKey?.sources).not.toContain('compose-inline');
  });

  it('marks a referenced-but-unset variable as missing', async () => {
    writeStack('inv2', { 'compose.yaml': 'services:\n  web:\n    image: nginx:${MISSING}\n' });
    stubRender({ web: {} }, 'The "MISSING" variable is not set. Defaulting to a blank string.');
    const inv = await buildEnvInventory(nodeId, 'inv2');
    expect(itemFor(inv, 'MISSING')).toMatchObject({ status: 'missing', usedForInterpolation: true });
  });

  it('picks up inline array and bare key forms', async () => {
    writeStack('inv3', { 'compose.yaml': 'services:\n  web:\n    image: nginx\n    environment:\n      - ARR_KEY=v\n      - BARE_KEY\n' });
    stubRender({ web: { ARR_KEY: 'v', BARE_KEY: '' } });
    const inv = await buildEnvInventory(nodeId, 'inv3');
    expect(itemFor(inv, 'ARR_KEY')?.sources).toContain('compose-inline');
    expect(itemFor(inv, 'BARE_KEY')?.sources).toContain('compose-inline');
  });

  it('drops an inline key that an override removed from the effective model', async () => {
    writeStack('inv4', { 'compose.yaml': 'services:\n  web:\n    image: nginx\n    environment:\n      KEPT: "1"\n      GONE: "1"\n' });
    stubRender({ web: { KEPT: '1' } }); // GONE not in effective model
    const inv = await buildEnvInventory(nodeId, 'inv4');
    expect(itemFor(inv, 'KEPT')).toBeTruthy();
    expect(itemFor(inv, 'GONE')).toBeUndefined();
  });

  it('does not flag .env doubling as env_file: .env as a duplicate', async () => {
    writeStack('inv5', {
      'compose.yaml': 'services:\n  web:\n    image: nginx:${SHARED}\n    env_file:\n      - .env\n',
      '.env': 'SHARED=1\n',
    });
    stubRender({ web: { SHARED: '1' } });
    const inv = await buildEnvInventory(nodeId, 'inv5');
    const shared = itemFor(inv, 'SHARED');
    expect(shared?.status).not.toBe('duplicate');
    expect(shared).toMatchObject({ usedForInterpolation: true, injectedIntoService: true });
  });

  it('reports duplicate when a key is defined inline and in a separate file', async () => {
    writeStack('inv6', {
      'compose.yaml': 'services:\n  web:\n    image: nginx\n    environment:\n      DUP: "1"\n    env_file:\n      - ./other.env\n',
      'other.env': 'DUP=2\n',
    });
    stubRender({ web: { DUP: '1' } });
    const inv = await buildEnvInventory(nodeId, 'inv6');
    expect(itemFor(inv, 'DUP')?.status).toBe('duplicate');
  });

  it('degrades to renderable:false but still lists authored refs when render fails', async () => {
    writeStack('inv7', { 'compose.yaml': 'services:\n  web:\n    image: nginx:${REF}\n' });
    stubRender(null, 'yaml: line 2: mapping values are not allowed');
    const inv = await buildEnvInventory(nodeId, 'inv7');
    expect(inv.renderable).toBe(false);
    expect(itemFor(inv, 'REF')).toBeTruthy();
  });

  it('still marks inline and env_file keys as injected when the model cannot render', async () => {
    writeStack('inv8', {
      'compose.yaml': 'services:\n  web:\n    image: nginx\n    environment:\n      INLINE_X: "1"\n    env_file:\n      - ./svc.env\n',
      'svc.env': 'FILE_X=1\n',
    });
    stubRender(null, 'yaml: line 5: bad mapping');
    const inv = await buildEnvInventory(nodeId, 'inv8');
    expect(inv.renderable).toBe(false);
    expect(itemFor(inv, 'INLINE_X')).toMatchObject({ injectedIntoService: true, sources: expect.arrayContaining(['compose-inline']) });
    expect(itemFor(inv, 'FILE_X')).toMatchObject({ injectedIntoService: true, sources: expect.arrayContaining(['env-file']) });
  });
});

describe('buildEnvInventory secret safety', () => {
  it('never includes an inline environment value, only the key', async () => {
    const value = 'actual-secret-value-zzz';
    writeStack('sec1', { 'compose.yaml': `services:\n  web:\n    image: nginx\n    environment:\n      SECRET: ${value}\n` });
    stubRender({ web: { SECRET: value } });
    const inv = await buildEnvInventory(nodeId, 'sec1');
    expect(itemFor(inv, 'SECRET')).toMatchObject({ likelySecret: true });
    expect(JSON.stringify(inv)).not.toContain(value);
  });

  it('never emits an inventory row for an unreferenced process.env key', async () => {
    process.env.UNRELATED_HOST_SECRET_XYZ = 'leak-me';
    try {
      writeStack('sec2', { 'compose.yaml': 'services:\n  web:\n    image: nginx\n' });
      stubRender({ web: {} });
      const inv = await buildEnvInventory(nodeId, 'sec2');
      expect(itemFor(inv, 'UNRELATED_HOST_SECRET_XYZ')).toBeUndefined();
      expect(JSON.stringify(inv)).not.toContain('UNRELATED_HOST_SECRET_XYZ');
    } finally {
      delete process.env.UNRELATED_HOST_SECRET_XYZ;
    }
  });

  it('marks a shell-resolved, unpersisted referenced var as unpersisted', async () => {
    process.env.SHELL_ONLY_VAR_ABC = 'present-in-shell';
    try {
      writeStack('sec3', { 'compose.yaml': 'services:\n  web:\n    image: nginx:${SHELL_ONLY_VAR_ABC}\n' });
      stubRender({ web: {} }); // resolved (no unset warning) because shell has it
      const inv = await buildEnvInventory(nodeId, 'sec3');
      expect(itemFor(inv, 'SHELL_ONLY_VAR_ABC')).toMatchObject({ status: 'unpersisted', sources: expect.arrayContaining(['process-env']) });
    } finally {
      delete process.env.SHELL_ONLY_VAR_ABC;
    }
  });
});

describe('GET /api/stacks/:stackName/env-inventory', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/stacks/inv1/env-inventory');
    expect(res.status).toBe(401);
  });

  it('returns 404 for an unknown stack', async () => {
    const res = await request(app).get('/api/stacks/does-not-exist/env-inventory').set('Cookie', authCookie);
    expect(res.status).toBe(404);
  });

  it('returns the inventory without leaking a value', async () => {
    const value = 'route-secret-value-qqq';
    writeStack('route1', { 'compose.yaml': `services:\n  web:\n    image: nginx\n    environment:\n      SECRET: ${value}\n` });
    stubRender({ web: { SECRET: value } });
    const res = await request(app).get('/api/stacks/route1/env-inventory').set('Cookie', authCookie);
    expect(res.status).toBe(200);
    expect(res.body.stackName).toBe('route1');
    // The key must appear (so the test fails if the row is dropped, not just if the
    // value happens to be absent), and the value must never appear.
    const secret = (res.body.items as { key: string; likelySecret: boolean }[]).find(i => i.key === 'SECRET');
    expect(secret).toMatchObject({ likelySecret: true });
    expect(JSON.stringify(res.body)).not.toContain(value);
  });
});
