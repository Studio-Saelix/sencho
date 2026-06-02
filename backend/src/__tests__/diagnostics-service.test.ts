/**
 * Unit tests for DiagnosticsService.collectDiagnostics: the shape of the
 * report, secret redaction (allowlist), Docker probe handling, and core-table
 * detection. Shared by the /api/diagnostics route and the diagnostics/validate
 * CLI commands, so these guarantees protect all three.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let collectDiagnostics: typeof import('../services/DiagnosticsService').collectDiagnostics;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ collectDiagnostics } = await import('../services/DiagnosticsService'));
    ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

describe('collectDiagnostics', () => {
    it('reports a healthy baseline database with at least one admin', async () => {
        const report = await collectDiagnostics();
        expect(report.database.ok).toBe(true);
        expect(report.database.integrity).toBe('ok');
        expect(report.database.missingTables).toEqual([]);
        expect(report.auth.adminCount).toBeGreaterThanOrEqual(1);
        expect(report.encryptionKey).toEqual({ present: true, valid: true });
    });

    it('reports docker unreachable when no probe is supplied', async () => {
        const report = await collectDiagnostics();
        expect(report.docker.reachable).toBe(false);
    });

    it('reflects a passed docker probe', async () => {
        const reachable = await collectDiagnostics({ checkDocker: async () => true });
        expect(reachable.docker.reachable).toBe(true);
        const down = await collectDiagnostics({
            checkDocker: async () => { throw new Error('socket closed'); },
        });
        expect(down.docker.reachable).toBe(false);
        expect(down.docker.error).toBe('socket closed');
    });

    it('never surfaces secret settings in the config block', async () => {
        const db = DatabaseService.getInstance();
        db.updateGlobalSetting('auth_jwt_secret', 'top-secret-signing-key');
        db.updateGlobalSetting('cloud_backup_secret_key', 'enc:deadbeef');
        db.updateGlobalSetting('host_cpu_limit', '80');

        const report = await collectDiagnostics();

        expect(report.config.auth_jwt_secret).toBeUndefined();
        expect(report.config.cloud_backup_secret_key).toBeUndefined();
        // The allowlisted, non-secret value is present.
        expect(report.config.host_cpu_limit).toBe('80');
        // No emitted value is one of the seeded secrets, regardless of key name.
        expect(Object.values(report.config)).not.toContain('top-secret-signing-key');
        expect(Object.values(report.config)).not.toContain('enc:deadbeef');
    });

    // Destructive: dropping a core table must run last in this file.
    it('flags a missing core table', async () => {
        DatabaseService.getInstance().getDb().exec('DROP TABLE audit_log');
        const report = await collectDiagnostics();
        expect(report.database.missingTables).toContain('audit_log');
        expect(report.database.ok).toBe(false);
    });
});
