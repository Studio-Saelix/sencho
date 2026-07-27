/**
 * Authentication mode (SSO-only) route and activation safeguards.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import {
  setupTestDb,
  cleanupTestDb,
  loginAsTestAdmin,
  TEST_USERNAME,
  TEST_PASSWORD,
} from './helpers/setupTestDb';
import { setAuthenticationMode } from '../helpers/authenticationMode';

let tmpDir: string;
let app: import('express').Express;
let adminCookie: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let LicenseService: typeof import('../services/LicenseService').LicenseService;
let SSOService: typeof import('../services/SSOService').SSOService;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  ({ DatabaseService } = await import('../services/DatabaseService'));
  ({ LicenseService } = await import('../services/LicenseService'));
  ({ SSOService } = await import('../services/SSOService'));
  adminCookie = await loginAsTestAdmin(app);
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

function markAdminAsSso(): void {
  const db = DatabaseService.getInstance();
  db.getDb()
    .prepare("UPDATE users SET auth_provider = 'oidc_custom', provider_id = 'sso-admin-1' WHERE username = ?")
    .run(TEST_USERNAME);
}

function markAdminAsLocal(): void {
  const db = DatabaseService.getInstance();
  db.getDb()
    .prepare("UPDATE users SET auth_provider = 'local', provider_id = NULL WHERE username = ?")
    .run(TEST_USERNAME);
}

function enableGithubProvider(): void {
  DatabaseService.getInstance().upsertSSOConfig(
    'oidc_github',
    true,
    JSON.stringify({
      provider: 'oidc_github',
      enabled: true,
      displayName: 'GitHub',
      oidcClientId: 'test-client',
    }),
  );
}

beforeEach(() => {
  setAuthenticationMode('local_and_sso');
  markAdminAsLocal();
  const db = DatabaseService.getInstance();
  for (const cfg of db.getSSOConfigs()) {
    db.upsertSSOConfig(cfg.provider, false, cfg.config_json);
  }
  vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
});

describe('GET /api/sso/auth-mode', () => {
  it('returns the current mode for an admin', async () => {
    const res = await request(app).get('/api/sso/auth-mode').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.authenticationMode).toBe('local_and_sso');
    expect(res.body.localLoginEnabled).toBe(true);
  });
});

describe('PUT /api/sso/auth-mode', () => {
  it('rejects PUT sso_only without confirm: true', async () => {
    markAdminAsSso();
    enableGithubProvider();
    vi.spyOn(SSOService.getInstance(), 'testOidcDiscovery').mockResolvedValue({ success: true });

    const missing = await request(app)
      .put('/api/sso/auth-mode')
      .set('Cookie', adminCookie)
      .send({ mode: 'sso_only' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/confirm/i);

    const falsy = await request(app)
      .put('/api/sso/auth-mode')
      .set('Cookie', adminCookie)
      .send({ mode: 'sso_only', confirm: false });
    expect(falsy.status).toBe(400);
    expect(falsy.body.error).toMatch(/confirm/i);
  });

  it('allows Community admin to enable sso_only', async () => {
    markAdminAsSso();
    enableGithubProvider();
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');
    vi.spyOn(SSOService.getInstance(), 'testOidcDiscovery').mockResolvedValue({ success: true });

    const res = await request(app)
      .put('/api/sso/auth-mode')
      .set('Cookie', adminCookie)
      .send({ mode: 'sso_only', confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.authenticationMode).toBe('sso_only');
    expect(res.body.localLoginEnabled).toBe(false);
  });

  it('rejects local-only admin entering sso_only', async () => {
    enableGithubProvider();
    vi.spyOn(SSOService.getInstance(), 'testOidcDiscovery').mockResolvedValue({ success: true });

    const res = await request(app)
      .put('/api/sso/auth-mode')
      .set('Cookie', adminCookie)
      .send({ mode: 'sso_only', confirm: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Sign in with SSO/i);
  });

  it('rejects sso_only when no provider is enabled', async () => {
    markAdminAsSso();
    const res = await request(app)
      .put('/api/sso/auth-mode')
      .set('Cookie', adminCookie)
      .send({ mode: 'sso_only', confirm: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one SSO provider/i);
  });

  it('enables sso_only for an SSO admin when a provider test passes', async () => {
    markAdminAsSso();
    enableGithubProvider();
    vi.spyOn(SSOService.getInstance(), 'testOidcDiscovery').mockResolvedValue({ success: true });

    const res = await request(app)
      .put('/api/sso/auth-mode')
      .set('Cookie', adminCookie)
      .send({ mode: 'sso_only', confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.authenticationMode).toBe('sso_only');
    expect(res.body.localLoginEnabled).toBe(false);
  });

  it('lets a Community admin revert to local_and_sso (not paid-gated)', async () => {
    setAuthenticationMode('sso_only');
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('community');

    const res = await request(app)
      .put('/api/sso/auth-mode')
      .set('Cookie', adminCookie)
      .send({ mode: 'local_and_sso' });
    expect(res.status).toBe(200);
    expect(res.body.authenticationMode).toBe('local_and_sso');
    expect(res.body.localLoginEnabled).toBe(true);
  });
});

describe('Last-provider guard while sso_only', () => {
  it('rejects disabling the last enabled provider', async () => {
    markAdminAsSso();
    enableGithubProvider();
    setAuthenticationMode('sso_only');

    const res = await request(app)
      .put('/api/sso/config/oidc_github')
      .set('Cookie', adminCookie)
      .send({
        provider: 'oidc_github',
        enabled: false,
        displayName: 'GitHub',
        oidcClientId: 'test-client',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/last SSO provider/i);
    expect(DatabaseService.getInstance().getEnabledSSOConfigs()).toHaveLength(1);
  });

  it('rejects deleting the last enabled provider', async () => {
    markAdminAsSso();
    enableGithubProvider();
    setAuthenticationMode('sso_only');

    const res = await request(app)
      .delete('/api/sso/config/oidc_github')
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/last SSO provider/i);
  });
});

describe('Password change under sso_only', () => {
  it('still allows an authenticated password change', async () => {
    setAuthenticationMode('local_and_sso');
    const freshCookie = await loginAsTestAdmin(app);
    setAuthenticationMode('sso_only');

    const res = await request(app)
      .put('/api/auth/password')
      .set('Cookie', freshCookie)
      .send({ oldPassword: TEST_PASSWORD, newPassword: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
