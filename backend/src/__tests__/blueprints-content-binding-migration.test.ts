/**
 * Content-origin columns on blueprints.
 * Seeds a pre-binding schema with an enabled Blueprint and a live placement,
 * then opens production DatabaseService startup so migrateBlueprintContentBinding runs.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { DatabaseService } from '../services/DatabaseService';

const LEGACY_BLUEPRINT = 'legacy-bound';

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

function blueprintColumnNames(db: Database.Database): string[] {
    return (db.prepare('PRAGMA table_info(blueprints)').all() as Array<{ name: string }>).map(c => c.name);
}

function seedLegacyPreBindingSchema(dbPath: string, now: number): string[] {
    const seed = new Database(dbPath);
    try {
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
                created_by TEXT,
                pinned_node_id INTEGER,
                approval_status TEXT NOT NULL DEFAULT 'pending',
                approved_intent_fingerprint TEXT,
                approved_blast_json TEXT,
                approved_at INTEGER,
                approved_by TEXT
            );
            INSERT INTO blueprints (
                name, description, compose_content, selector_json, drift_mode,
                classification, classification_reasons, enabled, revision,
                created_at, updated_at, created_by, approval_status
            ) VALUES (
                '${LEGACY_BLUEPRINT}',
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
                'admin',
                'pending'
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
        return blueprintColumnNames(seed);
    } finally {
        seed.close();
    }
}

function bootDatabaseService(scratchDir: string): DatabaseService {
    process.env.DATA_DIR = scratchDir;
    process.env.COMPOSE_DIR = path.join(scratchDir, 'compose');
    fs.mkdirSync(process.env.COMPOSE_DIR, { recursive: true });
    resetDatabaseSingleton();
    return DatabaseService.getInstance();
}

describe('blueprint content binding column migration', () => {
    let scratchDir: string | null = null;

    afterEach(() => {
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

    it('migrates a pre-binding enabled blueprint to Inline and keeps its deployment', () => {
        scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sencho-bp-binding-mig-'));
        const now = Date.now();
        const colNamesBefore = seedLegacyPreBindingSchema(path.join(scratchDir, 'sencho.db'), now);
        expect(colNamesBefore).not.toContain('content_origin');
        expect(colNamesBefore).not.toContain('application_id');

        const db = bootDatabaseService(scratchDir);
        const cols = blueprintColumnNames(db.getDb());
        expect(cols).toContain('content_origin');
        expect(cols).toContain('application_id');

        const raw = db.getDb().prepare(
            'SELECT content_origin, application_id, compose_content, approval_status FROM blueprints WHERE name = ?',
        ).get(LEGACY_BLUEPRINT) as {
            content_origin: string;
            application_id: string | null;
            compose_content: string;
            approval_status: string;
        };
        expect(raw).toEqual({
            content_origin: 'inline',
            application_id: null,
            compose_content: 'services:\n  app:\n    image: nginx\n',
            approval_status: 'pending',
        });

        const row = db.getBlueprintByName(LEGACY_BLUEPRINT);
        expect(row).toMatchObject({
            id: 1,
            content_origin: 'inline',
            application_id: null,
        });
        expect(db.listDeployments(1).some(d => d.node_id === 1 && d.status === 'active')).toBe(true);

        expect(() => db.getDb().prepare(
            "UPDATE blueprints SET content_origin = 'git' WHERE id = 1",
        ).run()).toThrow(/CHECK/);

        resetDatabaseSingleton();
        process.env.DATA_DIR = scratchDir;
        const db2 = DatabaseService.getInstance();
        expect(blueprintColumnNames(db2.getDb()).filter(name => name === 'content_origin')).toHaveLength(1);
        expect(db2.getBlueprintByName(LEGACY_BLUEPRINT)).toMatchObject({
            content_origin: 'inline',
            application_id: null,
        });
        expect(db2.listDeployments(1)).toHaveLength(1);
    });
});
