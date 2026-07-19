/**
 * Fail-closed approval columns on blueprints.
 * Seeds a pre-approval schema with an enabled Blueprint (and live placement),
 * then opens production DatabaseService startup so migrateAddBlueprintApproval runs.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { DatabaseService } from '../services/DatabaseService';

function resetDatabaseSingleton(): void {
    const holder = DatabaseService as unknown as { instance?: DatabaseService };
    const existing = holder.instance;
    if (existing) {
        try {
            existing.getDb().close();
        } catch {
            // already closed
        }
        holder.instance = undefined;
    }
}

type ApprovalRow = {
    approval_status: string | null;
    approved_intent_fingerprint: string | null;
    approved_blast_json: string | null;
    approved_at: number | null;
    approved_by: string | null;
    enabled: number;
};

function readApprovalRow(db: Database.Database, name: string): ApprovalRow {
    return db.prepare(
        `SELECT approval_status, approved_intent_fingerprint, approved_blast_json,
                approved_at, approved_by, enabled
         FROM blueprints WHERE name = ?`,
    ).get(name) as ApprovalRow;
}

function expectPendingNullAuth(row: ApprovalRow): void {
    expect(row.approval_status).toBe('pending');
    expect(row.approved_intent_fingerprint).toBeNull();
    expect(row.approved_blast_json).toBeNull();
    expect(row.approved_at).toBeNull();
    expect(row.approved_by).toBeNull();
    expect(row.enabled).toBe(1);
}

describe('blueprint approval column migration', () => {
    let scratchDir: string | null = null;

    afterEach(() => {
        vi.restoreAllMocks();
        resetDatabaseSingleton();
        if (scratchDir) {
            try {
                fs.rmSync(scratchDir, { recursive: true, force: true });
            } catch {
                // best-effort
            }
            scratchDir = null;
        }
    });

    it('migrates a pre-approval enabled blueprint to pending with no authorization material', async () => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-bp-approval-mig-'));
        const dbPath = path.join(scratchDir, 'sencho.db');
        const now = Date.now();
        const seed = new Database(dbPath);
        try {
            // Legacy schema: no approval_* columns and no pinned_node_id.
            // Include a matching node + active deployment so a wrongly approved
            // migration would have something to mutate on reconcile.
            seed.exec(`
                CREATE TABLE nodes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    type TEXT NOT NULL DEFAULT 'local',
                    compose_dir TEXT NOT NULL DEFAULT '/app/compose',
                    is_default INTEGER DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'unknown',
                    created_at INTEGER NOT NULL
                );
                INSERT INTO nodes (id, name, type, compose_dir, is_default, status, created_at)
                    VALUES (1, 'legacy-local', 'local', '/tmp/compose', 1, 'online', ${now});

                CREATE TABLE blueprints (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL UNIQUE,
                    description TEXT,
                    compose_content TEXT NOT NULL,
                    selector_json TEXT NOT NULL,
                    drift_mode TEXT NOT NULL DEFAULT 'suggest',
                    classification TEXT NOT NULL DEFAULT 'unknown',
                    classification_reasons TEXT,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    revision INTEGER NOT NULL DEFAULT 1,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    created_by TEXT
                );
                INSERT INTO blueprints (
                    name, description, compose_content, selector_json, drift_mode,
                    classification, classification_reasons, enabled, revision,
                    created_at, updated_at, created_by
                ) VALUES (
                    'legacy-web',
                    NULL,
                    'services:\n  app:\n    image: nginx\n',
                    '{"type":"nodes","ids":[1]}',
                    'observe',
                    'stateless',
                    '[]',
                    1,
                    1,
                    ${now},
                    ${now},
                    'admin'
                );

                CREATE TABLE blueprint_deployments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    blueprint_id INTEGER NOT NULL,
                    node_id INTEGER NOT NULL,
                    status TEXT NOT NULL,
                    applied_revision INTEGER,
                    last_deployed_at INTEGER,
                    last_checked_at INTEGER,
                    last_drift_at INTEGER,
                    drift_summary TEXT,
                    last_error TEXT,
                    UNIQUE(blueprint_id, node_id)
                );
                INSERT INTO blueprint_deployments
                    (blueprint_id, node_id, status, applied_revision, last_deployed_at)
                    VALUES (1, 1, 'active', 1, ${now});
            `);
            const colsBefore = seed.prepare('PRAGMA table_info(blueprints)').all() as Array<{ name: string }>;
            expect(colsBefore.map(c => c.name)).not.toContain('approval_status');
            expect(colsBefore.map(c => c.name)).not.toContain('approved_blast_json');
        } finally {
            seed.close();
        }

        process.env.DATA_DIR = scratchDir;
        process.env.COMPOSE_DIR = path.join(scratchDir, 'compose');
        fs.mkdirSync(process.env.COMPOSE_DIR, { recursive: true });
        resetDatabaseSingleton();
        const db = DatabaseService.getInstance();

        const cols = db.getDb().prepare('PRAGMA table_info(blueprints)').all() as Array<{ name: string }>;
        const colNames = cols.map(c => c.name);
        for (const required of [
            'approval_status',
            'approved_intent_fingerprint',
            'approved_blast_json',
            'approved_at',
            'approved_by',
        ]) {
            expect(colNames).toContain(required);
        }

        // Assert raw SQLite values (not parseBlueprint coercion).
        expectPendingNullAuth(readApprovalRow(db.getDb(), 'legacy-web'));

        const row = db.getBlueprintByName('legacy-web');
        expect(row).toBeTruthy();
        expect(row!.id).toBe(1);
        expect(db.getNodes().some(n => n.id === 1)).toBe(true);
        expect(db.listDeployments(1).some(d => d.node_id === 1 && d.status === 'active')).toBe(true);

        const { BlueprintService } = await import('../services/BlueprintService');
        const { BlueprintReconciler } = await import('../services/BlueprintReconciler');
        const deploySpy = vi.spyOn(BlueprintService.getInstance(), 'deployToNode').mockResolvedValue({ status: 'active' });
        const withdrawSpy = vi.spyOn(BlueprintService.getInstance(), 'withdrawFromNode').mockResolvedValue({ status: 'withdrawn' });
        const upsertSpy = vi.spyOn(db, 'upsertDeployment');

        await BlueprintReconciler.getInstance().reconcileOne(row!.id);

        expect(deploySpy).not.toHaveBeenCalled();
        expect(withdrawSpy).not.toHaveBeenCalled();
        expect(upsertSpy).not.toHaveBeenCalled();

        // Idempotent reopen keeps a single set of columns and pending row state.
        resetDatabaseSingleton();
        process.env.DATA_DIR = scratchDir;
        const db2 = DatabaseService.getInstance();
        const cols2 = db2.getDb().prepare('PRAGMA table_info(blueprints)').all() as Array<{ name: string }>;
        expect(cols2.filter(c => c.name === 'approval_status')).toHaveLength(1);
        expectPendingNullAuth(readApprovalRow(db2.getDb(), 'legacy-web'));
    });
});
