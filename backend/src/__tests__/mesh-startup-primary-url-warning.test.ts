import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';
import { MeshService } from '../services/MeshService';
import { DatabaseService } from '../services/DatabaseService';

function seedMeshedProxyNode(): void {
    const db = DatabaseService.getInstance();
    const id = db.addNode({
        name: `p-${Date.now()}-${Math.random()}`,
        type: 'remote',
        mode: 'proxy',
        api_url: 'https://p.example.com',
        api_token: 't',
        compose_dir: '/tmp',
        is_default: false,
    });
    db.setNodeMeshEnabled(id, true);
}

describe('SENCHO_PRIMARY_URL preflight warning', () => {
    let tmpDir: string;
    let originalPrimaryUrl: string | undefined;

    beforeEach(async () => {
        tmpDir = await setupTestDb();
        originalPrimaryUrl = process.env.SENCHO_PRIMARY_URL;
        // The DB singleton persists across tests in the same process; wipe any
        // non-default nodes seeded by a prior test so each case starts clean.
        DatabaseService.getInstance().getDb().prepare('DELETE FROM nodes WHERE is_default = 0').run();
    });

    afterEach(() => {
        if (originalPrimaryUrl === undefined) {
            delete process.env.SENCHO_PRIMARY_URL;
        } else {
            process.env.SENCHO_PRIMARY_URL = originalPrimaryUrl;
        }
        cleanupTestDb(tmpDir);
    });

    it('warns when SENCHO_PRIMARY_URL is unset and a mesh-enabled proxy node exists', () => {
        delete process.env.SENCHO_PRIMARY_URL;
        seedMeshedProxyNode();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const svc = MeshService.getInstance() as unknown as { maybeWarnUnsetPrimaryUrl: () => void };
        svc.maybeWarnUnsetPrimaryUrl();
        expect(warn.mock.calls.some(c => /SENCHO_PRIMARY_URL is unset/.test(String(c[0])))).toBe(true);
        warn.mockRestore();
    });

    it('does not warn when SENCHO_PRIMARY_URL is set', () => {
        process.env.SENCHO_PRIMARY_URL = 'https://central.example.com';
        seedMeshedProxyNode();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const svc = MeshService.getInstance() as unknown as { maybeWarnUnsetPrimaryUrl: () => void };
        svc.maybeWarnUnsetPrimaryUrl();
        expect(warn.mock.calls.some(c => /SENCHO_PRIMARY_URL is unset/.test(String(c[0])))).toBe(false);
        warn.mockRestore();
    });

    it('does not warn when SENCHO_PRIMARY_URL is unset but no mesh-enabled proxy node exists', () => {
        delete process.env.SENCHO_PRIMARY_URL;
        // No seeding: zero mesh-enabled proxy nodes (only the default local node).
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const svc = MeshService.getInstance() as unknown as { maybeWarnUnsetPrimaryUrl: () => void };
        svc.maybeWarnUnsetPrimaryUrl();
        expect(warn.mock.calls.some(c => /SENCHO_PRIMARY_URL is unset/.test(String(c[0])))).toBe(false);
        warn.mockRestore();
    });
});
