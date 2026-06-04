/**
 * Integration tests for /api/settings (GET/POST/PATCH). These endpoints had
 * zero route-layer coverage prior to Phase 4B of the index.ts refactor; this
 * file locks down the shape before extraction.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, loginAsTestAdmin } from './helpers/setupTestDb';

let tmpDir: string;
let app: import('express').Express;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let adminCookie: string;
let viewerCookie: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ DatabaseService } = await import('../services/DatabaseService'));

  const { LicenseService } = await import('../services/LicenseService');
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('admiral');
  vi.spyOn(LicenseService.getInstance(), 'getSeatLimits').mockReturnValue({ maxAdmins: null, maxViewers: null });

  ({ app } = await import('../index'));
  adminCookie = await loginAsTestAdmin(app);

  const viewerHash = await bcrypt.hash('viewerpass', 1);
  DatabaseService.getInstance().addUser({ username: 'settings-viewer', password_hash: viewerHash, role: 'viewer' });
  const viewerRes = await request(app).post('/api/auth/login').send({ username: 'settings-viewer', password: 'viewerpass' });
  const cookies = viewerRes.headers['set-cookie'] as string | string[];
  viewerCookie = Array.isArray(cookies) ? cookies[0] : cookies;
});

afterAll(() => cleanupTestDb(tmpDir));

describe('GET /api/settings', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(401);
  });

  it('returns settings for authenticated users', async () => {
    const res = await request(app).get('/api/settings').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toBeInstanceOf(Object);
  });

  it('strips auth credentials from the response', async () => {
    const res = await request(app).get('/api/settings').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.auth_username).toBeUndefined();
    expect(res.body.auth_password_hash).toBeUndefined();
    expect(res.body.auth_jwt_secret).toBeUndefined();
  });

  describe('credential projection (leak prevention)', () => {
    // Seeded leak-probe values are reset afterward so the shared test DB does
    // not carry them into later suites (matches the cleanup convention used by
    // the mesh_auto_recreate write test below).
    afterAll(() => {
      const db = DatabaseService.getInstance();
      for (const k of [
        'cloud_backup_access_key',
        'cloud_backup_secret_key',
        'cloud_backup_endpoint',
        'cloud_backup_bucket',
        'some_future_setting',
      ]) {
        db.updateGlobalSetting(k, '');
      }
      db.updateGlobalSetting('trivy_auto_update', '0');
      db.updateGlobalSetting('mesh_auto_recreate', '0');
    });

    it('never returns credentials or other non-allowlisted keys, even to admins', async () => {
      // Cloud backup config is stored in global_settings by the cloud-backup
      // route (access key plaintext, secret key encrypted). The generic settings
      // GET projects an allowlist, so these credentials and any other key written
      // to the table are never disclosed here.
      const db = DatabaseService.getInstance();
      db.updateGlobalSetting('cloud_backup_access_key', 'AKIA-must-not-leak');
      db.updateGlobalSetting('cloud_backup_secret_key', 'cipher-must-not-leak');
      db.updateGlobalSetting('cloud_backup_endpoint', 'https://s3.example.com');
      db.updateGlobalSetting('cloud_backup_bucket', 'private-bucket');
      db.updateGlobalSetting('trivy_auto_update', '1');
      // A key that is neither allowlisted nor obviously sensitive: the allowlist
      // must still exclude it. This locks the fail-closed contract that is the
      // reason the GET uses an allowlist rather than a denylist.
      db.updateGlobalSetting('some_future_setting', 'should-not-appear');
      db.updateGlobalSetting('host_cpu_limit', '80');
      db.updateGlobalSetting('mesh_auto_recreate', '1');

      const res = await request(app).get('/api/settings').set('Cookie', adminCookie);
      expect(res.status).toBe(200);
      expect(res.body.cloud_backup_access_key).toBeUndefined();
      expect(res.body.cloud_backup_secret_key).toBeUndefined();
      expect(res.body.cloud_backup_endpoint).toBeUndefined();
      expect(res.body.cloud_backup_bucket).toBeUndefined();
      expect(res.body.trivy_auto_update).toBeUndefined();
      expect(res.body.some_future_setting).toBeUndefined();
      // Allowlisted keys still come through. Two structurally different keys (a
      // numeric and an enum-shaped one) prove the projection passes the whole
      // allowlist, not just one key.
      expect(res.body.host_cpu_limit).toBe('80');
      expect(res.body.mesh_auto_recreate).toBe('1');
    });

    it('allows non-admin users to read settings without leaking credentials', async () => {
      // Settings is read-only for non-admins; write is admin-gated separately.
      // The leak matters most here: a viewer must never receive backup creds.
      DatabaseService.getInstance().updateGlobalSetting('cloud_backup_access_key', 'AKIA-viewer-must-not-see');
      const res = await request(app).get('/api/settings').set('Cookie', viewerCookie);
      expect(res.status).toBe(200);
      expect(res.body.cloud_backup_access_key).toBeUndefined();
      expect(res.body.auth_password_hash).toBeUndefined();
    });
  });
});

describe('POST /api/settings (single-key write)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).post('/api/settings').send({ key: 'host_cpu_limit', value: '80' });
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    const res = await request(app)
      .post('/api/settings')
      .set('Cookie', viewerCookie)
      .send({ key: 'host_cpu_limit', value: '80' });
    expect(res.status).toBe(403);
  });

  it('rejects disallowed setting keys with 400', async () => {
    const res = await request(app)
      .post('/api/settings')
      .set('Cookie', adminCookie)
      .send({ key: 'auth_jwt_secret', value: 'pwned' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid or disallowed setting key/);
  });

  it('rejects missing value with 400', async () => {
    const res = await request(app)
      .post('/api/settings')
      .set('Cookie', adminCookie)
      .send({ key: 'host_cpu_limit' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/value is required/);
  });

  it('updates an allowlisted key', async () => {
    const res = await request(app)
      .post('/api/settings')
      .set('Cookie', adminCookie)
      .send({ key: 'host_cpu_limit', value: '75' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const settings = DatabaseService.getInstance().getGlobalSettings();
    expect(settings.host_cpu_limit).toBe('75');
  });

  it('rejects an enum-shaped key whose value is not one of the allowed literals', async () => {
    // Regression: the single-key POST previously wrote `String(value)`
    // without re-validating, so an allowlisted enum-shaped key like
    // `mesh_auto_recreate` could store arbitrary strings (`'banana'`)
    // that the bulk PATCH would later refuse. The single-key path now
    // routes through the same SettingsPatchSchema as PATCH.
    const res = await request(app)
      .post('/api/settings')
      .set('Cookie', adminCookie)
      .send({ key: 'mesh_auto_recreate', value: 'banana' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details).toBeInstanceOf(Object);
    const settings = DatabaseService.getInstance().getGlobalSettings();
    // Confirm the bad write did NOT leak through.
    expect(settings.mesh_auto_recreate).not.toBe('banana');
  });

  it('accepts a well-formed mesh_auto_recreate write', async () => {
    const res = await request(app)
      .post('/api/settings')
      .set('Cookie', adminCookie)
      .send({ key: 'mesh_auto_recreate', value: '1' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(DatabaseService.getInstance().getGlobalSettings().mesh_auto_recreate).toBe('1');
    // Reset for any later tests that read the value.
    DatabaseService.getInstance().updateGlobalSetting('mesh_auto_recreate', '0');
  });

  it('rejects an out-of-range numeric value on the single-key path (now schema-validated)', async () => {
    // Same regression class as mesh_auto_recreate=banana, but exercised
    // on a numeric setting to lock down the schema routing.
    const res = await request(app)
      .post('/api/settings')
      .set('Cookie', adminCookie)
      .send({ key: 'host_cpu_limit', value: '9999' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
  });
});

describe('PATCH /api/settings (bulk update)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await request(app).patch('/api/settings').send({ host_cpu_limit: 50 });
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users with 403', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('Cookie', viewerCookie)
      .send({ host_cpu_limit: 50 });
    expect(res.status).toBe(403);
  });

  it('rejects invalid values with 400 and returns field-level errors', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('Cookie', adminCookie)
      .send({ host_cpu_limit: 9999, log_retention_days: 'not-a-number' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.details).toBeInstanceOf(Object);
  });

  it('applies a partial update atomically', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('Cookie', adminCookie)
      .send({ host_cpu_limit: 60, host_ram_limit: 70 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const settings = DatabaseService.getInstance().getGlobalSettings();
    expect(settings.host_cpu_limit).toBe('60');
    expect(settings.host_ram_limit).toBe('70');
  });

  it('accepts an empty body and no-ops successfully', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(200);
  });

  it('rejects a PATCH with unknown or disallowed keys (400) and writes nothing', async () => {
    const before = DatabaseService.getInstance().getGlobalSettings().host_cpu_limit;
    const res = await request(app)
      .patch('/api/settings')
      .set('Cookie', adminCookie)
      .send({ host_cpu_limit: 65, auth_jwt_secret: 'pwned' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid or disallowed setting key/);
    // Fail-closed: the allowlisted key in the same body must not be written.
    expect(DatabaseService.getInstance().getGlobalSettings().host_cpu_limit).toBe(before);
  });

  it('rejects a PATCH whose only key is a private auth secret (was a silent 200 no-op before)', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('Cookie', adminCookie)
      .send({ auth_jwt_secret: 'pwned' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid or disallowed setting key/);
    // The auth secret must never be written through the settings API.
    expect(DatabaseService.getInstance().getGlobalSettings().auth_jwt_secret).not.toBe('pwned');
  });
});

describe('Admiral-only setting keys (audit_retention_days)', () => {
  // audit_retention_days configures the Admiral-only audit log, so its write is
  // gated by requireAdmiral in addition to the admin role. beforeAll mocks a
  // paid Admiral license; individual tests override the variant to simulate an
  // admin whose license is not Admiral.
  it('allows an Admiral admin to write audit_retention_days', async () => {
    const res = await request(app)
      .patch('/api/settings')
      .set('Cookie', adminCookie)
      .send({ audit_retention_days: 120 });
    expect(res.status).toBe(200);
    expect(DatabaseService.getInstance().getGlobalSettings().audit_retention_days).toBe('120');
  });

  it('rejects an audit_retention_days PATCH from a non-Admiral admin (403) and does not apply it', async () => {
    const before = DatabaseService.getInstance().getGlobalSettings().audit_retention_days;
    const { LicenseService } = await import('../services/LicenseService');
    const spy = vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('skipper');
    try {
      const res = await request(app)
        .patch('/api/settings')
        .set('Cookie', adminCookie)
        .send({ audit_retention_days: 200 });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ADMIRAL_REQUIRED');
      expect(DatabaseService.getInstance().getGlobalSettings().audit_retention_days).toBe(before);
    } finally {
      spy.mockReturnValue('admiral');
    }
  });

  it('rejects an audit_retention_days single-key POST from a non-Admiral admin (403) and does not apply it', async () => {
    const before = DatabaseService.getInstance().getGlobalSettings().audit_retention_days;
    const { LicenseService } = await import('../services/LicenseService');
    const spy = vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('skipper');
    try {
      const res = await request(app)
        .post('/api/settings')
        .set('Cookie', adminCookie)
        .send({ key: 'audit_retention_days', value: '300' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ADMIRAL_REQUIRED');
      expect(DatabaseService.getInstance().getGlobalSettings().audit_retention_days).toBe(before);
    } finally {
      spy.mockReturnValue('admiral');
    }
  });

  it('still lets a non-Admiral admin write non-Admiral keys via PATCH and POST (gate is per-key)', async () => {
    const { LicenseService } = await import('../services/LicenseService');
    const spy = vi.spyOn(LicenseService.getInstance(), 'getVariant').mockReturnValue('skipper');
    try {
      const patchRes = await request(app)
        .patch('/api/settings')
        .set('Cookie', adminCookie)
        .send({ host_cpu_limit: 55 });
      expect(patchRes.status).toBe(200);
      const postRes = await request(app)
        .post('/api/settings')
        .set('Cookie', adminCookie)
        .send({ key: 'host_ram_limit', value: '55' });
      expect(postRes.status).toBe(200);
    } finally {
      spy.mockReturnValue('admiral');
    }
  });
});
