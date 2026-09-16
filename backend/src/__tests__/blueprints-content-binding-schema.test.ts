import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { DatabaseService } from '../services/DatabaseService';

describe('Blueprint content binding schema', () => {
    let tmpDir: string;

    beforeAll(async () => {
        tmpDir = await setupTestDb();
    });

    afterAll(() => {
        cleanupTestDb(tmpDir);
    });

    function createBlueprint(name: string): number {
        return DatabaseService.getInstance().createBlueprint({
            name,
            description: null,
            compose_content: 'services: {}',
            selector: { type: 'nodes', ids: [1] },
            drift_mode: 'observe',
            classification: 'stateless',
            classification_reasons: [],
            enabled: true,
            created_by: null,
        }).id;
    }

    it('defaults existing create behavior to Inline with no application binding', () => {
        const id = createBlueprint('inline-default');
        const db = DatabaseService.getInstance().getDb();
        const columns = db.pragma('table_info(blueprints)') as Array<{ name: string }>;
        expect(columns.map(column => column.name)).toContain('content_origin');
        expect(db.prepare('SELECT content_origin, application_id, compose_content FROM blueprints WHERE id = ?')
            .get(id)).toEqual({ content_origin: 'inline', application_id: null, compose_content: 'services: {}' });
    });

    it('refuses two Blueprints claiming the same application', () => {
        const first = createBlueprint('binding-first');
        const second = createBlueprint('binding-second');
        const db = DatabaseService.getInstance().getDb();
        const bind = db.prepare("UPDATE blueprints SET content_origin = 'git', application_id = ? WHERE id = ?");
        bind.run('shared-application', first);
        expect(() => bind.run('shared-application', second)).toThrow(/UNIQUE/);
        expect(db.prepare('SELECT content_origin, application_id FROM blueprints WHERE id = ?').get(second))
            .toEqual({ content_origin: 'inline', application_id: null });
    });

    it('rejects mismatched content origins and application bindings', () => {
        const id = createBlueprint('binding-pair');
        const db = DatabaseService.getInstance().getDb();
        expect(() => db.prepare("UPDATE blueprints SET content_origin = 'git' WHERE id = ?").run(id))
            .toThrow(/CHECK/);
        expect(() => db.prepare("UPDATE blueprints SET application_id = 'app' WHERE id = ?").run(id))
            .toThrow(/CHECK/);
        expect(() => db.prepare("UPDATE blueprints SET content_origin = 'unknown' WHERE id = ?").run(id))
            .toThrow(/CHECK/);
    });

    it('maps content origin through the Blueprint writer', () => {
        const id = createBlueprint('writer-bind');
        const db = DatabaseService.getInstance();
        expect(db.getBlueprint(id)).toMatchObject({ content_origin: 'inline', application_id: null });
        expect(db.updateBlueprintContentOrigin(id, 'git', 'app-writer')).toMatchObject({
            content_origin: 'git',
            application_id: 'app-writer',
        });
        expect(() => db.updateBlueprintContentOrigin(id, 'git', null)).toThrow(/requires application_id/);
        expect(() => db.updateBlueprintContentOrigin(id, 'inline', 'app-writer')).toThrow(/null/);
        expect(db.updateBlueprintContentOrigin(id, 'inline', null)).toMatchObject({
            content_origin: 'inline',
            application_id: null,
        });
    });

    it('keeps compose_content required after a Git binding', () => {
        const id = createBlueprint('compose-required');
        const sqlite = DatabaseService.getInstance().getDb();
        sqlite.prepare("UPDATE blueprints SET content_origin = 'git', application_id = 'app-compose' WHERE id = ?").run(id);
        expect(() => sqlite.prepare('UPDATE blueprints SET compose_content = NULL WHERE id = ?').run(id))
            .toThrow(/NOT NULL|constraint/i);
    });
});
