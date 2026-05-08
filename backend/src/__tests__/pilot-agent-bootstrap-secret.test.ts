/**
 * Regression guard for the task #1 fix: pilot-agent hosts never run the
 * first-run setup wizard, so the wizard's `auth_jwt_secret` generation
 * (routes/auth.ts) never fires. Without that secret, the agent's loopback
 * auth helper (pilot/agent.ts::getLoopbackAuthHeader) returns null and the
 * local Sencho rejects every forwarded request with 401.
 *
 * `bootstrap/startup.ts` now generates the secret on pilot-mode boot when
 * missing, and re-uses the persisted value on subsequent boots. This test
 * exercises both branches by importing the underlying logic directly rather
 * than starting a full server (the server would also try to bind a port and
 * spawn pilot infrastructure).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let ensurePilotJwtSecret: typeof import('../bootstrap/startup').ensurePilotJwtSecret;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ ensurePilotJwtSecret } = await import('../bootstrap/startup'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

beforeEach(() => {
    delete process.env.SENCHO_MODE;
});

afterEach(() => {
    delete process.env.SENCHO_MODE;
});

describe('pilot-agent bootstrap auth_jwt_secret', () => {
    it('generates a secret on first pilot-mode boot when missing', () => {
        const db = DatabaseService.getInstance();
        // Wipe any existing secret to simulate a fresh pilot host.
        db.updateGlobalSetting('auth_jwt_secret', '');
        expect(db.getGlobalSettings().auth_jwt_secret).toBe('');

        process.env.SENCHO_MODE = 'pilot';
        const generated = ensurePilotJwtSecret();
        expect(generated).toBe(true);

        const after = db.getGlobalSettings().auth_jwt_secret;
        expect(after).toBeTruthy();
        expect(after.length).toBe(128); // 64 random bytes hex-encoded
    });

    it('does not regenerate on subsequent boots with a persisted secret', () => {
        const db = DatabaseService.getInstance();
        const seeded = 'a'.repeat(128);
        db.updateGlobalSetting('auth_jwt_secret', seeded);

        process.env.SENCHO_MODE = 'pilot';
        const generated = ensurePilotJwtSecret();
        expect(generated).toBe(false);
        expect(db.getGlobalSettings().auth_jwt_secret).toBe(seeded);
    });

    it('does nothing in non-pilot mode (even if secret is missing)', () => {
        const db = DatabaseService.getInstance();
        db.updateGlobalSetting('auth_jwt_secret', '');

        // Default: SENCHO_MODE unset — primary mode.
        const generated = ensurePilotJwtSecret();
        expect(generated).toBe(false);
        // Still empty: primary mode goes through the setup wizard, not this
        // pilot-only auto-init.
        expect(db.getGlobalSettings().auth_jwt_secret).toBe('');
    });
});
