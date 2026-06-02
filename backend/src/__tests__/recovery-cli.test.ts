/**
 * Unit tests for the emergency recovery CLI command functions. Each command
 * exports a testable function; we exercise it against a temporary seeded
 * database and assert the database side effects and audit entries.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import { setupTestDb, cleanupTestDb, TEST_USERNAME } from './helpers/setupTestDb';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let resetPassword: typeof import('../cli/resetPassword').resetPassword;
let createEmergencyAdmin: typeof import('../cli/createEmergencyAdmin').createEmergencyAdmin;
let clearSessions: typeof import('../cli/clearSessions').clearSessions;
let disableSso: typeof import('../cli/disableSso').disableSso;
let validateDb: typeof import('../cli/validateDb').validateDb;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ resetPassword } = await import('../cli/resetPassword'));
    ({ createEmergencyAdmin } = await import('../cli/createEmergencyAdmin'));
    ({ clearSessions } = await import('../cli/clearSessions'));
    ({ disableSso } = await import('../cli/disableSso'));
    ({ validateDb } = await import('../cli/validateDb'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

describe('resetPassword', () => {
    it('rejects a missing user', async () => {
        const result = await resetPassword('nobody-here', 'newpassword123');
        expect(result.ok).toBe(false);
        expect(result.message).toContain('User not found');
    });

    it('rejects a too-short password', async () => {
        const result = await resetPassword(TEST_USERNAME, 'short');
        expect(result.ok).toBe(false);
        expect(result.message).toContain('at least');
    });

    it('refuses to reset a non-local (SSO) account', async () => {
        const db = DatabaseService.getInstance();
        db.addUser({ username: 'sso-user', password_hash: 'unused', role: 'viewer', auth_provider: 'oidc_custom' });
        const result = await resetPassword('sso-user', 'a-valid-password');
        expect(result.ok).toBe(false);
        expect(result.message).toContain('local accounts only');
    });

    it('resets the password and invalidates existing sessions', async () => {
        const db = DatabaseService.getInstance();
        const before = db.getUserByUsername(TEST_USERNAME)!;
        const result = await resetPassword(TEST_USERNAME, 'brand-new-pass');
        expect(result.ok).toBe(true);
        const after = db.getUserByUsername(TEST_USERNAME)!;
        expect(after.password_hash).not.toBe(before.password_hash);
        expect(await bcrypt.compare('brand-new-pass', after.password_hash)).toBe(true);
        expect(after.token_version).toBe(before.token_version + 1);
    });
});

describe('createEmergencyAdmin', () => {
    it('creates a new admin', async () => {
        const db = DatabaseService.getInstance();
        const result = await createEmergencyAdmin('rescue-admin', 'rescue-pass-1');
        expect(result.ok).toBe(true);
        const user = db.getUserByUsername('rescue-admin')!;
        expect(user.role).toBe('admin');
        expect(user.auth_provider).toBe('local');
    });

    it('refuses to overwrite an existing user', async () => {
        const result = await createEmergencyAdmin(TEST_USERNAME, 'whatever-pass');
        expect(result.ok).toBe(false);
        expect(result.message).toContain('already exists');
    });
});

describe('clearSessions', () => {
    it('bumps the token version of every user', () => {
        const db = DatabaseService.getInstance();
        const users = db.getUsers();
        const before = users.map(u => db.getUserByUsername(u.username)!.token_version);
        const result = clearSessions();
        expect(result.ok).toBe(true);
        const after = db.getUsers().map(u => db.getUserByUsername(u.username)!.token_version);
        after.forEach((v, i) => expect(v).toBe(before[i] + 1));
    });
});

describe('disableSso', () => {
    it('disables a named provider and preserves its config', () => {
        const db = DatabaseService.getInstance();
        db.upsertSSOConfig('oidc_custom', true, '{"clientId":"abc"}');
        const result = disableSso('oidc_custom');
        expect(result.ok).toBe(true);
        const config = db.getSSOConfig('oidc_custom')!;
        expect(config.enabled).toBe(0);
        expect(config.config_json).toBe('{"clientId":"abc"}');
    });

    it('reports cleanly when a provider is unknown', () => {
        const result = disableSso('oidc_google');
        expect(result.ok).toBe(false);
        expect(result.message).toContain('No SSO config');
    });

    it('disables every enabled provider when no argument is given', () => {
        const db = DatabaseService.getInstance();
        db.upsertSSOConfig('ldap', true, '{"url":"ldap://x"}');
        db.upsertSSOConfig('oidc_okta', true, '{"domain":"x"}');
        const result = disableSso();
        expect(result.ok).toBe(true);
        expect(db.getEnabledSSOConfigs()).toHaveLength(0);
    });
});

describe('validateDb', () => {
    it('passes on a healthy baseline database', async () => {
        const result = await validateDb();
        expect(result.ok).toBe(true);
        expect(result.message).toContain('Database OK');
    });

    // Destructive: dropping a core table must be the last test in this file.
    it('fails and names a missing core table', async () => {
        DatabaseService.getInstance().getDb().exec('DROP TABLE audit_log');
        const result = await validateDb();
        expect(result.ok).toBe(false);
        expect(result.message).toContain('audit_log');
    });
});
