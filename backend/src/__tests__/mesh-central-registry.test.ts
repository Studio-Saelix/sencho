import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';
import { MeshCentralRegistry } from '../services/MeshCentralRegistry';

describe('mesh_centrals schema', () => {
  let tmpDir: string;
  beforeAll(async () => { tmpDir = await setupTestDb(); });
  afterAll(() => cleanupTestDb(tmpDir));

  it('creates the mesh_centrals table on initSchema', () => {
    const db = DatabaseService.getInstance();
    const row = db.getDb().prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='mesh_centrals'"
    ).get();
    expect(row).toBeDefined();
  });

  it('mesh_centrals has the expected columns', () => {
    const db = DatabaseService.getInstance();
    const cols = db.getDb().prepare("PRAGMA table_info('mesh_centrals')").all() as Array<{ name: string }>;
    const names = cols.map(c => c.name).sort();
    expect(names).toEqual([
      'callback_jwt',
      'central_api_url',
      'central_instance_id',
      'jwt_expires_at',
      'jwt_issued_at',
      'last_bootstrap_at',
      'last_reject_reason',
      'last_rejected_at',
      'last_used_at',
    ]);
  });
});

describe('MeshCentralRegistry', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await setupTestDb();
    MeshCentralRegistry.resetForTest();
    // Ensure a clean mesh_centrals table even if the baseline DB carried rows
    // from a prior test file (the helper's per-file copy isolates by path,
    // but resetting the table inside the file keeps tests order-independent).
    DatabaseService.getInstance().getDb().prepare('DELETE FROM mesh_centrals').run();
  });
  afterEach(() => cleanupTestDb(tmpDir));

  const sampleMaterial = (overrides: Partial<{
    centralInstanceId: string;
    centralApiUrl: string;
    callbackJwt: string;
    jwtIssuedAt: number;
    jwtExpiresAt: number;
  }> = {}) => ({
    centralInstanceId: 'inst-uuid-1',
    centralApiUrl: 'https://central.example.com',
    callbackJwt: 'eyJhbGciOiJIUzI1NiJ9.fake.token',
    jwtIssuedAt: 1_700_000_000,
    jwtExpiresAt: 1_700_000_000 + 365 * 24 * 3600,
    ...overrides,
  });

  it('upsert inserts a new row when none exists', () => {
    MeshCentralRegistry.getInstance().upsert(sampleMaterial());
    const row = MeshCentralRegistry.getInstance().getActive();
    expect(row?.centralInstanceId).toBe('inst-uuid-1');
    expect(row?.centralApiUrl).toBe('https://central.example.com');
    expect(row?.lastBootstrapAt).toBeGreaterThan(0);
  });

  it('upsert overwrites when same instance id is provided', () => {
    const reg = MeshCentralRegistry.getInstance();
    reg.upsert(sampleMaterial({ callbackJwt: 'old.jwt' }));
    reg.upsert(sampleMaterial({ callbackJwt: 'new.jwt' }));
    expect(reg.getActive()?.callbackJwt).toBe('new.jwt');
  });

  it('getActive returns most-recently-bootstrapped row when multiple exist and warns once', () => {
    const reg = MeshCentralRegistry.getInstance();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    reg.upsert(sampleMaterial({ centralInstanceId: 'old', jwtIssuedAt: 1 }));
    DatabaseService.getInstance().getDb().prepare(`
      INSERT INTO mesh_centrals VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
    `).run('new', 'https://other.example.com', 'jwt2', 2, 999, Date.now() + 1000);
    expect(reg.getActive()?.centralInstanceId).toBe('new');
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toMatch(/multiple central rows/);
    reg.getActive();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('getActive returns null when table is empty', () => {
    expect(MeshCentralRegistry.getInstance().getActive()).toBeNull();
  });

  it('clearForInstance removes only the named instance', () => {
    const reg = MeshCentralRegistry.getInstance();
    reg.upsert(sampleMaterial({ centralInstanceId: 'a' }));
    reg.upsert(sampleMaterial({ centralInstanceId: 'b' }));
    reg.clearForInstance('a');
    const remaining = DatabaseService.getInstance().getDb().prepare(
      "SELECT central_instance_id FROM mesh_centrals"
    ).all() as Array<{ central_instance_id: string }>;
    expect(remaining.map(r => r.central_instance_id)).toEqual(['b']);
  });

  it('markUsed updates last_used_at, only on success', () => {
    const reg = MeshCentralRegistry.getInstance();
    reg.upsert(sampleMaterial());
    reg.markUsed('inst-uuid-1');
    expect(reg.getActive()?.lastUsedAt).toBeGreaterThan(0);
  });

  it('markRejected stores reason and timestamp', () => {
    const reg = MeshCentralRegistry.getInstance();
    reg.upsert(sampleMaterial());
    reg.markRejected('inst-uuid-1', 'token_fingerprint_mismatch');
    const row = reg.getActive();
    expect(row?.lastRejectedAt).toBeGreaterThan(0);
    expect(row?.lastRejectReason).toBe('token_fingerprint_mismatch');
  });
});
