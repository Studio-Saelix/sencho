/**
 * Integration tests for the per-stack Dossier endpoints: blank-on-first-read,
 * upsert persistence, full-document save semantics, field validation, RBAC, and
 * per (node, stack) scoping at the DAO layer.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let adminCookie: string;
let viewerCookie: string;

const FIELD_KEYS = [
  'purpose', 'owner', 'access_urls', 'static_ip', 'vlan',
  'firewall_notes', 'reverse_proxy_notes', 'backup_notes',
  'upgrade_notes', 'recovery_notes', 'custom_notes',
] as const;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);

  const viewerHash = await bcrypt.hash('viewerpass', 1);
  DatabaseService.getInstance().addUser({ username: 'viewer', password_hash: viewerHash, role: 'viewer' });
  const viewerRes = await request(app).post('/api/auth/login').send({ username: 'viewer', password: 'viewerpass' });
  const cookies = viewerRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('GET /api/stacks/:stackName/dossier', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/stacks/web/dossier');
    expect(res.status).toBe(401);
  });

  it('returns a blank dossier (200, all fields empty) when none has been saved', async () => {
    const res = await request(app).get('/api/stacks/web/dossier').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.stack_name).toBe('web');
    for (const k of FIELD_KEYS) expect(res.body[k]).toBe('');
  });
});

describe('PUT /api/stacks/:stackName/dossier', () => {
  it('persists operator fields and returns the saved row', async () => {
    const res = await request(app)
      .put('/api/stacks/web/dossier')
      .set('Cookie', adminCookie)
      .send({ purpose: 'Reverse proxy', owner: 'ops', static_ip: '10.0.20.5', vlan: '20', firewall_notes: '443 open' });
    expect(res.status).toBe(200);
    expect(res.body.purpose).toBe('Reverse proxy');
    expect(res.body.static_ip).toBe('10.0.20.5');

    const get = await request(app).get('/api/stacks/web/dossier').set('Cookie', adminCookie);
    expect(get.body.owner).toBe('ops');
    expect(get.body.firewall_notes).toBe('443 open');
  });

  it('updates in place: a second PUT keeps a single row and preserves created_at', async () => {
    const first = await request(app).put('/api/stacks/upd/dossier').set('Cookie', adminCookie).send({ purpose: 'one' });
    const createdAt = first.body.created_at as number;
    await new Promise(r => setTimeout(r, 20));
    const second = await request(app).put('/api/stacks/upd/dossier').set('Cookie', adminCookie).send({ purpose: 'two' });
    expect(second.body.purpose).toBe('two');
    expect(second.body.created_at).toBe(createdAt);
    expect(second.body.updated_at).toBeGreaterThanOrEqual(createdAt);

    const row = DatabaseService.getInstance().getDb()
      .prepare("SELECT COUNT(*) AS n FROM stack_dossiers WHERE stack_name = 'upd'").get() as { n: number };
    expect(row.n).toBe(1);
  });

  it('treats a save as a full document: omitted short and block fields are cleared', async () => {
    await request(app).put('/api/stacks/clr/dossier').set('Cookie', adminCookie)
      .send({ purpose: 'p', owner: 'o', firewall_notes: '443 open' });
    const res = await request(app).put('/api/stacks/clr/dossier').set('Cookie', adminCookie)
      .send({ purpose: 'only purpose' });
    expect(res.body.purpose).toBe('only purpose');
    expect(res.body.owner).toBe('');
    expect(res.body.firewall_notes).toBe('');
  });

  it('rejects an over-long field with 400', async () => {
    const res = await request(app)
      .put('/api/stacks/web/dossier')
      .set('Cookie', adminCookie)
      .send({ static_ip: 'x'.repeat(300) });
    expect(res.status).toBe(400);
  });
});

describe('Dossier RBAC', () => {
  it('lets a viewer read the dossier', async () => {
    const res = await request(app).get('/api/stacks/web/dossier').set('Cookie', viewerCookie);
    expect(res.status).toBe(200);
  });

  it('forbids a viewer from saving the dossier (403)', async () => {
    const res = await request(app).put('/api/stacks/web/dossier').set('Cookie', viewerCookie).send({ purpose: 'nope' });
    expect(res.status).toBe(403);
  });
});

describe('Dossier scoping (DAO)', () => {
  it('keeps dossiers isolated per (node, stack)', () => {
    const db = DatabaseService.getInstance();
    const fields = (purpose: string) => ({
      purpose, owner: '', access_urls: '', static_ip: '', vlan: '',
      firewall_notes: '', reverse_proxy_notes: '', backup_notes: '',
      upgrade_notes: '', recovery_notes: '', custom_notes: '',
    });
    db.upsertStackDossier(1, 'shared', fields('node-1'));
    db.upsertStackDossier(2, 'shared', fields('node-2'));
    expect(db.getStackDossier(1, 'shared')?.purpose).toBe('node-1');
    expect(db.getStackDossier(2, 'shared')?.purpose).toBe('node-2');

    db.deleteStackDossier(1, 'shared');
    expect(db.getStackDossier(1, 'shared')).toBeUndefined();
    expect(db.getStackDossier(2, 'shared')?.purpose).toBe('node-2');
  });
});
