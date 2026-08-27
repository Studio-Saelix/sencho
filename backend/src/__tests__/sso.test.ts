import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { setupTestDb, cleanupTestDb, TEST_JWT_SECRET } from './helpers/setupTestDb';
import supertest from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import type { Express } from 'express';
import { generateApiToken } from '../utils/apiTokenFormat';

let tmpDir: string;
let app: Express;
let adminToken: string;

beforeAll(async () => {
  tmpDir = await setupTestDb();
  ({ app } = await import('../index'));
  adminToken = jwt.sign({ username: 'testadmin', role: 'admin' }, TEST_JWT_SECRET, { expiresIn: '1h' });
});

afterAll(() => {
  cleanupTestDb(tmpDir);
});

describe('SSO Providers Endpoint', () => {
  it('GET /api/auth/sso/providers returns empty array when none configured', async () => {
    const res = await supertest(app).get('/api/auth/sso/providers');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('SSO LDAP Login', () => {
  it('POST /api/auth/sso/ldap returns error when LDAP not configured', async () => {
    const res = await supertest(app)
      .post('/api/auth/sso/ldap')
      .send({ username: 'testuser', password: 'testpass' });
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('not configured');
  });

  it('POST /api/auth/sso/ldap returns 400 when missing credentials', async () => {
    const res = await supertest(app)
      .post('/api/auth/sso/ldap')
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('required');
  });
});

describe('SSO Config Endpoints (Protected)', () => {
  it('GET /api/sso/config returns 401 without auth', async () => {
    const res = await supertest(app).get('/api/sso/config');
    expect(res.status).toBe(401);
  });

  it('GET /api/sso/config returns 200 with admin token (no paid tier required)', async () => {
    const res = await supertest(app)
      .get('/api/sso/config')
      .set('Authorization', `Bearer ${adminToken}`);
    // SSO config is now available to all tiers, only admin role required
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('PUT /api/sso/config/:provider returns 401 without auth', async () => {
    const res = await supertest(app)
      .put('/api/sso/config/ldap')
      .send({ enabled: true });
    expect(res.status).toBe(401);
  });

  it('DELETE /api/sso/config/:provider returns 401 without auth', async () => {
    const res = await supertest(app).delete('/api/sso/config/ldap');
    expect(res.status).toBe(401);
  });
});

describe('SSO OIDC Authorize', () => {
  it('GET /api/auth/sso/oidc/:provider/authorize returns 400 for invalid provider', async () => {
    const res = await supertest(app).get('/api/auth/sso/oidc/invalid_provider/authorize');
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid SSO provider');
  });

  it('GET /api/auth/sso/oidc/oidc_google/authorize redirects to error when not configured', async () => {
    const res = await supertest(app).get('/api/auth/sso/oidc/oidc_google/authorize');
    // Should redirect to /?sso_error=...
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('sso_error');
  });

  it('GET /api/auth/sso/oidc/oidc_custom/authorize redirects to error when not configured', async () => {
    const res = await supertest(app).get('/api/auth/sso/oidc/oidc_custom/authorize');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('sso_error');
  });
});

describe('SSO OIDC Callback', () => {
  it('GET /api/auth/sso/oidc/:provider/callback redirects with error when no state cookie', async () => {
    const res = await supertest(app)
      .get('/api/auth/sso/oidc/oidc_google/callback?code=test&state=test');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('sso_error');
    expect(res.headers.location).toContain('expired');
  });

  it('GET /api/auth/sso/oidc/:provider/callback redirects with provider error if error param present', async () => {
    const res = await supertest(app)
      .get('/api/auth/sso/oidc/oidc_google/callback?error=access_denied&error_description=User+denied');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('User');
  });

  // Drives a callback request with a valid state cookie, returning the stubbed
  // handleOIDCCallback spy so the caller can assert on the params it received.
  async function callbackWithStubbedService(provider: string, query: Record<string, string>): Promise<MockInstance> {
    const { SSOService } = await import('../services/SSOService');
    const { CryptoService } = await import('../services/CryptoService');

    const stateCookie = CryptoService.getInstance().encrypt(JSON.stringify({
      state: 'test-state',
      codeVerifier: 'test-verifier',
      provider,
    }));

    const spy = vi
      .spyOn(SSOService.getInstance(), 'handleOIDCCallback')
      .mockResolvedValue({ success: false, error: 'stubbed for iss-forwarding assertion' });

    await supertest(app)
      .get(`/api/auth/sso/oidc/${provider}/callback`)
      .query(query)
      .set('Cookie', `sencho_sso_state=${stateCookie}`);

    return spy;
  }

  it('forwards the RFC 9207 iss query parameter to SSOService.handleOIDCCallback', async () => {
    const spy = await callbackWithStubbedService('oidc_custom', {
      code: 'test-code',
      state: 'test-state',
      iss: 'https://idp.example.com/realms/master',
    });

    expect(spy).toHaveBeenCalledWith(
      'oidc_custom',
      expect.any(String),
      expect.objectContaining({ code: 'test-code', state: 'test-state', iss: 'https://idp.example.com/realms/master' }),
      'test-state',
      'test-verifier',
    );

    spy.mockRestore();
  });

  it('omits iss from the forwarded params when the provider does not send one', async () => {
    const spy = await callbackWithStubbedService('oidc_google', { code: 'test-code', state: 'test-state' });

    expect(spy).toHaveBeenCalledWith(
      'oidc_google',
      expect.any(String),
      expect.objectContaining({ code: 'test-code', state: 'test-state', iss: undefined }),
      'test-state',
      'test-verifier',
    );

    spy.mockRestore();
  });
});

describe('SSOService.buildTokenExchangeUrl', () => {
  it('sets the iss query parameter when provided', async () => {
    const { SSOService } = await import('../services/SSOService');
    const url = SSOService.getInstance().buildTokenExchangeUrl(
      'http://sencho.example.com/api/auth/sso/oidc/oidc_custom/callback',
      { code: 'test-code', state: 'test-state', iss: 'https://idp.example.com/realms/master' },
    );
    expect(url.searchParams.get('code')).toBe('test-code');
    expect(url.searchParams.get('state')).toBe('test-state');
    expect(url.searchParams.get('iss')).toBe('https://idp.example.com/realms/master');
  });

  it('omits the iss query parameter when not provided', async () => {
    const { SSOService } = await import('../services/SSOService');
    const url = SSOService.getInstance().buildTokenExchangeUrl(
      'http://sencho.example.com/api/auth/sso/oidc/oidc_google/callback',
      { code: 'test-code', state: 'test-state' },
    );
    expect(url.searchParams.get('code')).toBe('test-code');
    expect(url.searchParams.get('state')).toBe('test-state');
    expect(url.searchParams.has('iss')).toBe(false);
  });
});

describe('SSO User Provisioning', () => {
  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('provisionUser creates a new SSO user with correct fields', async () => {
    const { SSOService } = await import('../services/SSOService');
    const { DatabaseService } = await import('../services/DatabaseService');

    const sso = SSOService.getInstance();
    const user = sso.provisionUser({
      authProvider: 'oidc_google',
      providerId: 'google-sub-123',
      preferredUsername: 'John Doe',
      email: 'john@example.com',
      role: 'viewer',
    });

    expect(user.username).toBe('John_Doe');
    expect(user.auth_provider).toBe('oidc_google');
    expect(user.provider_id).toBe('google-sub-123');
    expect(user.email).toBe('john@example.com');
    expect(user.role).toBe('viewer');
    // Password hash should be unusable (SSO prefix)
    expect(user.password_hash).toMatch(/^\$sso\$/);

    // Verify they appear in DB
    const dbUser = DatabaseService.getInstance().getUserByProviderIdentity('oidc_google', 'google-sub-123');
    expect(dbUser).toBeDefined();
    expect(dbUser!.username).toBe('John_Doe');
  });

  it('provisionUser returns existing user on second call', async () => {
    const { SSOService } = await import('../services/SSOService');
    const sso = SSOService.getInstance();

    const user1 = sso.provisionUser({
      authProvider: 'oidc_github',
      providerId: 'github-id-456',
      preferredUsername: 'janedoe',
      email: 'jane@example.com',
      role: 'admin',
    });

    const user2 = sso.provisionUser({
      authProvider: 'oidc_github',
      providerId: 'github-id-456',
      preferredUsername: 'janedoe',
      email: 'jane-new@example.com',
      role: 'admin',
    });

    expect(user1.id).toBe(user2.id);
    // Email should be updated
    expect(user2.email).toBe('jane-new@example.com');
  });

  it('provisionUser handles username collision', async () => {
    const { SSOService } = await import('../services/SSOService');
    const { DatabaseService } = await import('../services/DatabaseService');
    const sso = SSOService.getInstance();

    // Create a local user first
    DatabaseService.getInstance().addUser({
      username: 'collision',
      password_hash: '$2b$10$fake',
      role: 'viewer',
    });

    // Now provision an SSO user with the same preferred username
    const user = sso.provisionUser({
      authProvider: 'ldap',
      providerId: 'cn=collision,ou=users,dc=example',
      preferredUsername: 'collision',
      role: 'viewer',
    });

    // Should have a suffixed username
    expect(user.username).toBe('collision_ldap');
    expect(user.auth_provider).toBe('ldap');
  });

  it('provisionUser works with oidc_custom provider', async () => {
    const { SSOService } = await import('../services/SSOService');
    const sso = SSOService.getInstance();
    const user = sso.provisionUser({
      authProvider: 'oidc_custom',
      providerId: 'custom-sub-789',
      preferredUsername: 'customuser',
      email: 'custom@example.com',
      role: 'viewer',
    });
    expect(user.auth_provider).toBe('oidc_custom');
    expect(user.provider_id).toBe('custom-sub-789');
    expect(user.email).toBe('custom@example.com');
    expect(user.username).toBe('customuser');
  });

  it('SSO users cannot log in via local password endpoint', async () => {
    // The SSO user from the first test has a $sso$ password hash
    // Trying to log in with any password should fail
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ username: 'John_Doe', password: 'anything' });
    expect(res.status).toBe(401);
  });
});

describe('SSO Config CRUD (DB layer)', () => {
  it('upsertSSOConfig and getSSOConfig work correctly', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();

    db.upsertSSOConfig('ldap', true, JSON.stringify({ ldapUrl: 'ldap://test:389' }));

    const config = db.getSSOConfig('ldap');
    expect(config).toBeDefined();
    expect(config!.enabled).toBe(1);
    expect(JSON.parse(config!.config_json)).toEqual({ ldapUrl: 'ldap://test:389' });

    // Update
    db.upsertSSOConfig('ldap', false, JSON.stringify({ ldapUrl: 'ldap://test2:389' }));
    const updated = db.getSSOConfig('ldap');
    expect(updated!.enabled).toBe(0);
    expect(JSON.parse(updated!.config_json)).toEqual({ ldapUrl: 'ldap://test2:389' });

    // Delete
    db.deleteSSOConfig('ldap');
    expect(db.getSSOConfig('ldap')).toBeUndefined();
  });

  it('getEnabledSSOConfigs filters correctly', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();

    db.upsertSSOConfig('oidc_google', true, '{}');
    db.upsertSSOConfig('oidc_github', false, '{}');

    const enabled = db.getEnabledSSOConfigs();
    expect(enabled.length).toBe(1);
    expect(enabled[0].provider).toBe('oidc_google');

    // Cleanup
    db.deleteSSOConfig('oidc_google');
    db.deleteSSOConfig('oidc_github');
  });
});

describe('Database migration - SSO columns', () => {
  it('users table has auth_provider, provider_id, email columns', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();

    const user = db.addUser({
      username: 'sso_migration_test',
      password_hash: '$sso$test',
      role: 'viewer',
      auth_provider: 'ldap',
      provider_id: 'cn=test,dc=example',
      email: 'test@example.com',
    });

    const fetched = db.getUser(user);
    expect(fetched).toBeDefined();
    expect(fetched!.auth_provider).toBe('ldap');
    expect(fetched!.provider_id).toBe('cn=test,dc=example');
    expect(fetched!.email).toBe('test@example.com');

    // getUserByProviderIdentity
    const byProvider = db.getUserByProviderIdentity('ldap', 'cn=test,dc=example');
    expect(byProvider).toBeDefined();
    expect(byProvider!.username).toBe('sso_migration_test');
  });
});

describe('SSO Role Sync on Re-Login', () => {
  afterEach(async () => {
    // Ensure sso_role_sync is reset to default between tests so the
    // enabled-case does not leak into subsequent suites.
    const { DatabaseService } = await import('../services/DatabaseService');
    DatabaseService.getInstance().updateGlobalSetting('sso_role_sync', '0');
    vi.restoreAllMocks();
  });

  it('provisionUser preserves existing role when sso_role_sync setting is missing', async () => {
    const { SSOService } = await import('../services/SSOService');
    const { DatabaseService } = await import('../services/DatabaseService');
    const sso = SSOService.getInstance();
    const db = DatabaseService.getInstance();

    // Spy: return settings without sso_role_sync to simulate a missing key
    const realSettings = { ...db.getGlobalSettings() };
    delete realSettings['sso_role_sync'];
    vi.spyOn(db, 'getGlobalSettings').mockReturnValue(Object.freeze(realSettings));

    // Create a viewer
    const user1 = sso.provisionUser({
      authProvider: 'oidc_okta',
      providerId: 'okta-role-sync-missing',
      preferredUsername: 'rolesync_missing',
      email: 'rolesync_missing@example.com',
      role: 'viewer',
    });
    expect(user1.role).toBe('viewer');

    // Re-login with admin role from IdP - should NOT overwrite when sync is off
    const user2 = sso.provisionUser({
      authProvider: 'oidc_okta',
      providerId: 'okta-role-sync-missing',
      preferredUsername: 'rolesync_missing',
      email: 'rolesync_missing_new@example.com',
      role: 'admin',
    });
    expect(user2.id).toBe(user1.id);
    expect(user2.role).toBe('viewer'); // preserved, not promoted
    expect(user2.email).toBe('rolesync_missing_new@example.com'); // email still syncs
  });

  it('provisionUser preserves existing role when sso_role_sync is off', async () => {
    const { SSOService } = await import('../services/SSOService');
    const { DatabaseService } = await import('../services/DatabaseService');
    const sso = SSOService.getInstance();
    const db = DatabaseService.getInstance();

    // Explicitly set to '0'
    db.updateGlobalSetting('sso_role_sync', '0');

    // Create a viewer
    const user1 = sso.provisionUser({
      authProvider: 'oidc_okta',
      providerId: 'okta-role-sync-off',
      preferredUsername: 'rolesync_off',
      email: 'rolesync_off@example.com',
      role: 'viewer',
    });
    expect(user1.role).toBe('viewer');

    // Re-login with admin role - should NOT overwrite when sync is off
    const user2 = sso.provisionUser({
      authProvider: 'oidc_okta',
      providerId: 'okta-role-sync-off',
      preferredUsername: 'rolesync_off',
      email: 'rolesync_off_new@example.com',
      role: 'admin',
    });
    expect(user2.id).toBe(user1.id);
    expect(user2.role).toBe('viewer'); // preserved
    expect(user2.email).toBe('rolesync_off_new@example.com'); // email still syncs
  });

  it('provisionUser applies IdP role when sso_role_sync is enabled', async () => {
    const { SSOService } = await import('../services/SSOService');
    const { DatabaseService } = await import('../services/DatabaseService');
    const sso = SSOService.getInstance();
    const db = DatabaseService.getInstance();

    // Enable sync
    db.updateGlobalSetting('sso_role_sync', '1');

    // Create a viewer
    const user1 = sso.provisionUser({
      authProvider: 'oidc_okta',
      providerId: 'okta-role-sync-on',
      preferredUsername: 'rolesync_on',
      email: 'rolesync_on@example.com',
      role: 'viewer',
    });
    expect(user1.role).toBe('viewer');

    // Re-login with admin role - SHOULD overwrite when sync is enabled
    const user2 = sso.provisionUser({
      authProvider: 'oidc_okta',
      providerId: 'okta-role-sync-on',
      preferredUsername: 'rolesync_on',
      email: 'rolesync_on_new@example.com',
      role: 'admin',
    });
    expect(user2.id).toBe(user1.id);
    expect(user2.role).toBe('admin'); // promoted
    expect(user2.email).toBe('rolesync_on_new@example.com'); // email still syncs
  });

  it('provisionUser applies IdP role demotion when sso_role_sync is enabled', async () => {
    const { SSOService } = await import('../services/SSOService');
    const { DatabaseService } = await import('../services/DatabaseService');
    const sso = SSOService.getInstance();
    const db = DatabaseService.getInstance();
    db.updateGlobalSetting('sso_role_sync', '1');

    // Create an admin
    const user1 = sso.provisionUser({
      authProvider: 'oidc_okta',
      providerId: 'okta-role-sync-demote',
      preferredUsername: 'rolesync_demote',
      email: 'rolesync_demote@example.com',
      role: 'admin',
    });
    expect(user1.role).toBe('admin');

    // Re-login with viewer role (removed from admin group) - SHOULD demote
    const user = sso.provisionUser({
      authProvider: 'oidc_okta',
      providerId: 'okta-role-sync-demote',
      preferredUsername: 'rolesync_demote',
      email: 'rolesync_demote@example.com',
      role: 'viewer',
    });
    expect(user.role).toBe('viewer'); // demoted
  });
});

describe('LDAP Filter Escaping', () => {
  it('escapes special characters in LDAP filters', async () => {
    const { SSOService } = await import('../services/SSOService');
    const sso = SSOService.getInstance();
    // Access private method via bracket notation for testing
    const escape = (sso as unknown as { escapeLdapFilter: (v: string) => string }).escapeLdapFilter.bind(sso);

    expect(escape('user*(admin)')).toBe('user\\2a\\28admin\\29');
    expect(escape('test\\value')).toBe('test\\5cvalue');
    expect(escape('normal')).toBe('normal');
    expect(escape('null\0byte')).toBe('null\\00byte');
  });
});

describe('SSO Config Validation on PUT', () => {
  // Validation tests exercise the required-field checks inside PUT. Per-provider
  // tier gates run before validation, so mock the license to the paid tier here
  // to keep these tests focused on validation logic; tier-gate coverage lives in
  // its own block.
  beforeAll(async () => {
    const { LicenseService } = await import('../services/LicenseService');
    vi.spyOn(LicenseService.getInstance(), 'getTier').mockReturnValue('paid');
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('rejects enabled LDAP config without Server URL', async () => {
    const res = await supertest(app)
      .put('/api/sso/config/ldap')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true, ldapSearchBase: 'ou=users,dc=example' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Server URL');
  });

  it('rejects enabled LDAP config without Search Base', async () => {
    const res = await supertest(app)
      .put('/api/sso/config/ldap')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true, ldapUrl: 'ldap://localhost:389' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Search Base');
  });

  it('rejects enabled OIDC config without Client ID', async () => {
    const res = await supertest(app)
      .put('/api/sso/config/oidc_google')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Client ID');
  });

  it('rejects enabled Okta config without Issuer URL', async () => {
    const res = await supertest(app)
      .put('/api/sso/config/oidc_okta')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true, oidcClientId: 'test-client-id' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Issuer URL');
  });

  it('rejects enabled Custom OIDC config without Issuer URL', async () => {
    const res = await supertest(app)
      .put('/api/sso/config/oidc_custom')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true, oidcClientId: 'test-client-id' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Issuer URL');
  });

  it('accepts oidc_custom as a valid provider', async () => {
    const res = await supertest(app)
      .put('/api/sso/config/oidc_custom')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('allows saving disabled config without required fields', async () => {
    const res = await supertest(app)
      .put('/api/sso/config/ldap')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('rejects invalid provider name', async () => {
    const res = await supertest(app)
      .put('/api/sso/config/invalid_provider')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid SSO provider');
  });
});

describe('SSO Claim Mapping', () => {
  it('resolveRoleFromOidc respects custom admin claim name', async () => {
    const { SSOService } = await import('../services/SSOService');
    const sso = SSOService.getInstance();
    // Access private method for testing
    const resolve = (sso as unknown as {
      resolveRoleFromOidc: (userInfo: Record<string, unknown>, config: { oidcAdminClaim?: string; oidcAdminClaimValue?: string; oidcDefaultRole?: string }) => string;
    }).resolveRoleFromOidc.bind(sso);

    // Standard claim name
    expect(resolve({ groups: ['sencho-admins'] }, { oidcAdminClaim: 'groups', oidcAdminClaimValue: 'sencho-admins' })).toBe('admin');

    // Custom claim name
    expect(resolve({ roles: 'admin-role' }, { oidcAdminClaim: 'roles', oidcAdminClaimValue: 'admin-role' })).toBe('admin');

    // Claim missing, falls back to default
    expect(resolve({}, { oidcAdminClaim: 'roles', oidcAdminClaimValue: 'admin-role', oidcDefaultRole: 'viewer' })).toBe('viewer');

    // Claim present but no match
    expect(resolve({ roles: 'user-role' }, { oidcAdminClaim: 'roles', oidcAdminClaimValue: 'admin-role', oidcDefaultRole: 'viewer' })).toBe('viewer');
  });

  it('resolveRoleFromOidc handles edge cases', async () => {
    const { SSOService } = await import('../services/SSOService');
    const sso = SSOService.getInstance();
    const resolve = (sso as unknown as {
      resolveRoleFromOidc: (userInfo: Record<string, unknown>, config: { oidcAdminClaim?: string; oidcAdminClaimValue?: string; oidcDefaultRole?: string }) => string;
    }).resolveRoleFromOidc.bind(sso);

    // Empty oidcAdminClaimValue falls back to default 'sencho-admins' via || operator,
    // so a matching claim still resolves to admin
    expect(resolve({ groups: ['sencho-admins'] }, { oidcAdminClaim: 'groups', oidcAdminClaimValue: '', oidcDefaultRole: 'viewer' })).toBe('admin');

    // Claim exists but is an empty array (no match possible)
    expect(resolve({ groups: [] }, { oidcAdminClaim: 'groups', oidcAdminClaimValue: 'sencho-admins', oidcDefaultRole: 'viewer' })).toBe('viewer');

    // Claim exists but is an empty string (no match)
    expect(resolve({ groups: '' }, { oidcAdminClaim: 'groups', oidcAdminClaimValue: 'sencho-admins', oidcDefaultRole: 'viewer' })).toBe('viewer');

    // Claim value is a number (should be coerced to string for comparison)
    expect(resolve({ role_id: 42 }, { oidcAdminClaim: 'role_id', oidcAdminClaimValue: '42', oidcDefaultRole: 'viewer' })).toBe('admin');
  });
});

describe('SSO Config - Role Enforcement', () => {
  let viewerToken: string;

  beforeAll(async () => {
    // Create a viewer user in the DB so the auth middleware can resolve it
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    if (!db.getUserByUsername('sso_test_viewer')) {
      db.addUser({ username: 'sso_test_viewer', password_hash: '$2b$10$fake', role: 'viewer' });
    }
    viewerToken = jwt.sign({ username: 'sso_test_viewer', role: 'viewer' }, TEST_JWT_SECRET, { expiresIn: '1h' });
  });

  it('GET /api/sso/config returns 403 for viewer role', async () => {
    const res = await supertest(app)
      .get('/api/sso/config')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
  });

  it('PUT /api/sso/config/:provider returns 403 for viewer role', async () => {
    const res = await supertest(app)
      .put('/api/sso/config/ldap')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ enabled: false });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
  });

  it('DELETE /api/sso/config/:provider returns 403 for viewer role', async () => {
    const res = await supertest(app).delete('/api/sso/config/ldap').set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
  });
});

describe('SSO Config - API Token Denied', () => {
  let apiRawToken: string;

  beforeAll(async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    apiRawToken = generateApiToken();
    const tokenHash = crypto.createHash('sha256').update(apiRawToken).digest('hex');
    const admin = db.getUserByUsername('testadmin');
    db.addApiToken({ token_hash: tokenHash, name: `sso-scope-${Date.now()}`, scope: 'full-admin', user_id: admin!.id, created_at: Date.now(), expires_at: null });
  });

  it('GET /api/sso/config returns 403 SCOPE_DENIED for API token', async () => {
    const res = await supertest(app)
      .get('/api/sso/config')
      .set('Authorization', `Bearer ${apiRawToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SCOPE_DENIED');
  });

  it('PUT /api/sso/config/:provider returns 403 SCOPE_DENIED for API token', async () => {
    const res = await supertest(app)
      .put('/api/sso/config/ldap')
      .set('Authorization', `Bearer ${apiRawToken}`)
      .send({ enabled: false });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SCOPE_DENIED');
  });
});

describe('SSO Role Sync Config Endpoints', () => {
  let viewerToken: string;

  beforeAll(async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    if (!db.getUserByUsername('sso_test_viewer')) {
      db.addUser({ username: 'sso_test_viewer', password_hash: '$2b$10$fake', role: 'viewer' });
    }
    viewerToken = jwt.sign({ username: 'sso_test_viewer', role: 'viewer' }, TEST_JWT_SECRET, { expiresIn: '1h' });
  });

  beforeEach(async () => {
    // Ensure order independence: reset to default before each test
    const { DatabaseService } = await import('../services/DatabaseService');
    DatabaseService.getInstance().updateGlobalSetting('sso_role_sync', '0');
  });

  afterEach(() => {
    // Restore any spies after each test
    vi.restoreAllMocks();
  });

  it('Administrator GET returns { enabled: false } initially', async () => {
    const res = await supertest(app)
      .get('/api/sso/config/role-sync')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: false });
  });

  it('Administrator PUT persists and returns { success: true }', async () => {
    const res = await supertest(app)
      .put('/api/sso/config/role-sync')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
  });

  it('Subsequent GET returns { enabled: true } after PUT', async () => {
    // PUT first
    await supertest(app)
      .put('/api/sso/config/role-sync')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true });
    // Then GET
    const res = await supertest(app)
      .get('/api/sso/config/role-sync')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true });
  });

  it('PUT with missing body returns 400', async () => {
    const res = await supertest(app)
      .put('/api/sso/config/role-sync')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('enabled must be a boolean');
  });

  it('PUT with non-boolean enabled returns 400', async () => {
    const res = await supertest(app)
      .put('/api/sso/config/role-sync')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('enabled must be a boolean');
  });

  it('PUT with null enabled returns 400', async () => {
    const res = await supertest(app)
      .put('/api/sso/config/role-sync')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: null });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('enabled must be a boolean');
  });

  it('Unauthenticated GET returns 401', async () => {
    const res = await supertest(app).get('/api/sso/config/role-sync');
    expect(res.status).toBe(401);
  });

  it('Unauthenticated PUT returns 401', async () => {
    const res = await supertest(app)
      .put('/api/sso/config/role-sync')
      .send({ enabled: true });
    expect(res.status).toBe(401);
  });

  it('Viewer GET returns 403 ADMIN_REQUIRED', async () => {
    const res = await supertest(app)
      .get('/api/sso/config/role-sync')
      .set('Authorization', `Bearer ${viewerToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
  });

  it('Viewer PUT returns 403 ADMIN_REQUIRED', async () => {
    const res = await supertest(app)
      .put('/api/sso/config/role-sync')
      .set('Authorization', `Bearer ${viewerToken}`)
      .send({ enabled: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ADMIN_REQUIRED');
  });

  it('Direct API token GET returns 403 SCOPE_DENIED', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const rawToken = generateApiToken();
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const admin = db.getUserByUsername('testadmin');
    db.addApiToken({
      token_hash: tokenHash, name: `role-sync-test-${Date.now()}`,
      scope: 'full-admin', user_id: admin!.id, created_at: Date.now(), expires_at: null,
    });

    const res = await supertest(app)
      .get('/api/sso/config/role-sync')
      .set('Authorization', `Bearer ${rawToken}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SCOPE_DENIED');
  });

  it('Direct API token PUT returns 403 SCOPE_DENIED', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    const rawToken = generateApiToken();
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const admin = db.getUserByUsername('testadmin');
    db.addApiToken({
      token_hash: tokenHash, name: `role-sync-put-test-${Date.now()}`,
      scope: 'full-admin', user_id: admin!.id, created_at: Date.now(), expires_at: null,
    });

    const res = await supertest(app)
      .put('/api/sso/config/role-sync')
      .set('Authorization', `Bearer ${rawToken}`)
      .send({ enabled: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SCOPE_DENIED');
  });

  it('Database failure returns controlled 500 response on PUT', async () => {
    const { DatabaseService } = await import('../services/DatabaseService');
    const db = DatabaseService.getInstance();
    // Spy on updateGlobalSetting (only called in the route handler, not auth
    // middleware) to simulate a database write failure.
    vi.spyOn(db, 'updateGlobalSetting').mockImplementation(() => {
      throw new Error('DB write failure');
    });
    const res = await supertest(app)
      .put('/api/sso/config/role-sync')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Failed to update role-sync setting');
  });
});

describe('SSO Test Connection - Custom OIDC', () => {
  it('POST /api/sso/config/oidc_custom/test returns failure when not configured', async () => {
    const res = await supertest(app)
      .post('/api/sso/config/oidc_custom/test')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBeDefined();
  });
});

describe('SSO OIDC Callback - Additional Error Handling', () => {
  it('handles error param without error_description', async () => {
    const res = await supertest(app)
      .get('/api/auth/sso/oidc/oidc_google/callback?error=server_error');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('sso_error');
    expect(res.headers.location).toContain('server_error');
  });

  it('handles error with description for oidc_custom provider', async () => {
    const res = await supertest(app)
      .get('/api/auth/sso/oidc/oidc_custom/callback?error=consent_required&error_description=User+must+consent');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('User');
  });
});

describe('SSO Config Tier Gating (per-provider)', () => {
  // Per-provider tier rules: Custom OIDC and preset OIDC (Google/GitHub/Okta) are
  // free; only LDAP requires the paid tier. The matrix below covers mutations
  // only; GET /sso/config (list) intentionally stays tier-ungated so downgraded
  // admins can still see previously-configured providers.
  let tierSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    const { LicenseService } = await import('../services/LicenseService');
    tierSpy = vi.spyOn(LicenseService.getInstance(), 'getTier');
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  const setTier = (tier: 'community' | 'paid'): void => {
    tierSpy.mockReturnValue(tier);
  };

  describe('community tier', () => {
    beforeAll(() => setTier('community'));

    it('PUT oidc_custom succeeds (no tier gate)', async () => {
      const res = await supertest(app)
        .put('/api/sso/config/oidc_custom')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ enabled: false });
      expect(res.status).toBe(200);
    });

    it('PUT oidc_google succeeds (presets are free)', async () => {
      const res = await supertest(app)
        .put('/api/sso/config/oidc_google')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ enabled: false });
      expect(res.status).toBe(200);
    });

    it('DELETE oidc_github succeeds (presets are free)', async () => {
      const res = await supertest(app)
        .delete('/api/sso/config/oidc_github')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
    });

    it('POST oidc_okta/test reaches the handler (presets are free, not tier-gated)', async () => {
      const res = await supertest(app)
        .post('/api/sso/config/oidc_okta/test')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).not.toBe(403);
    });

    it('PUT ldap returns 403 PAID_REQUIRED', async () => {
      const res = await supertest(app)
        .put('/api/sso/config/ldap')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ enabled: false });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PAID_REQUIRED');
    });

    it('GET /sso/config (list) still returns 200 — list is tier-ungated', async () => {
      const res = await supertest(app)
        .get('/api/sso/config')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });

  describe('paid tier', () => {
    beforeAll(() => setTier('paid'));

    it('PUT ldap succeeds', async () => {
      const res = await supertest(app)
        .put('/api/sso/config/ldap')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ enabled: false });
      expect(res.status).toBe(200);
    });

    it('PUT oidc_okta succeeds', async () => {
      const res = await supertest(app)
        .put('/api/sso/config/oidc_okta')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ enabled: false });
      expect(res.status).toBe(200);
    });
  });
});
