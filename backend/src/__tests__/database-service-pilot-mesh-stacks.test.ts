/**
 * Regression guard for F-A8: on pilot-mode hosts, `mesh_stacks` is dropped
 * at boot and the CRUD methods short-circuit.
 *
 *   - Per the C-3 design, mesh state lives on central. Pilots learn aliases
 *     via the D-1 override push and hold them in MeshService.pilotAliasOverlay.
 *     They never write to the local DB; the table is dead on pilots.
 *
 *   - DatabaseService runs `DROP TABLE IF EXISTS mesh_stacks` in
 *     `migrateMeshTables()` when `SENCHO_MODE === 'pilot'` and skips the
 *     CREATE. The four CRUD methods (`listMeshStacks`, `isMeshStackEnabled`,
 *     `insertMeshStack`, `deleteMeshStack`) short-circuit on the same check
 *     so the dropped table is never queried.
 *
 *   - Central-mode behavior is unchanged: every other mesh test in the suite
 *     (mesh-service.test.ts, mesh-diagnostic-local.test.ts, ...) exercises
 *     the table normally with `SENCHO_MODE` unset and serves as the implicit
 *     negative control.
 *
 * The test sets `SENCHO_MODE=pilot` BEFORE `setupTestDb` so the singleton's
 * constructor runs `migrateMeshTables()` in pilot mode against the freshly
 * copied baseline DB. The gate-function assertions then exercise the runtime
 * short-circuits.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

beforeAll(async () => {
    process.env.SENCHO_MODE = 'pilot';
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => {
    delete process.env.SENCHO_MODE;
    cleanupTestDb(tmpDir);
});

describe('DatabaseService mesh_stacks lifecycle on pilot-mode hosts (F-A8)', () => {
    it('drops the mesh_stacks table during migration on pilot mode', () => {
        const db = DatabaseService.getInstance();
        const row = db.getDb().prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mesh_stacks'"
        ).get();
        expect(row).toBeUndefined();
    });

    it('listMeshStacks returns [] without querying the dropped table', () => {
        const db = DatabaseService.getInstance();
        expect(db.listMeshStacks()).toEqual([]);
        expect(db.listMeshStacks(1)).toEqual([]);
    });

    it('isMeshStackEnabled returns false without querying the dropped table', () => {
        const db = DatabaseService.getInstance();
        expect(db.isMeshStackEnabled(1, 'any-stack')).toBe(false);
    });

    it('insertMeshStack is a no-op (no row written, no SQL touched)', () => {
        const db = DatabaseService.getInstance();
        expect(() => db.insertMeshStack(1, 'guarded-stack', 'tester')).not.toThrow();
        expect(db.listMeshStacks(1)).toEqual([]);
        const tableStillAbsent = db.getDb().prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mesh_stacks'"
        ).get();
        expect(tableStillAbsent).toBeUndefined();
    });

    it('deleteMeshStack is a no-op', () => {
        const db = DatabaseService.getInstance();
        expect(() => db.deleteMeshStack(1, 'any-stack')).not.toThrow();
    });
});
