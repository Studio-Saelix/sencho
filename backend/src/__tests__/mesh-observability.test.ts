/**
 * Developer-mode diagnostics for the mesh data plane.
 *
 * The `[Mesh:diag]` logs are gated on the shared `developer_mode` setting, so
 * they must be silent in production (the default) and appear only when an
 * operator turns developer mode on. They must also never carry a node's
 * api_token: the cross-fleet inspect path runs that token in a Bearer header,
 * and a diagnostic or error log that echoed it would leak a long-lived
 * credential into the log surface.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let MeshService: typeof import('../services/MeshService').MeshService;

function captureConsole() {
    const lines: string[] = [];
    const record = (...args: unknown[]): void => {
        lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    const spies = [
        vi.spyOn(console, 'debug').mockImplementation(record),
        vi.spyOn(console, 'log').mockImplementation(record),
        vi.spyOn(console, 'warn').mockImplementation(record),
        vi.spyOn(console, 'error').mockImplementation(record),
    ];
    return { lines, restore: (): void => spies.forEach((s) => s.mockRestore()) };
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ MeshService } = await import('../services/MeshService'));
});

beforeEach(() => {
    DatabaseService.getInstance().getDb().prepare('DELETE FROM mesh_stacks').run();
    DatabaseService.getInstance().updateGlobalSetting('developer_mode', '0');
});

afterEach(() => {
    vi.restoreAllMocks();
    DatabaseService.getInstance().updateGlobalSetting('developer_mode', '0');
});

afterAll(() => cleanupTestDb(tmpDir));

describe('mesh developer-mode diagnostics', () => {
    it('emits no [Mesh:diag] logs when developer_mode is off', async () => {
        const cap = captureConsole();
        await MeshService.getInstance().refreshAliasCache();
        cap.restore();
        expect(cap.lines.some((l) => l.includes('[Mesh:diag]'))).toBe(false);
    });

    it('emits the [Mesh:diag] refresh log when developer_mode is on', async () => {
        DatabaseService.getInstance().updateGlobalSetting('developer_mode', '1');
        const cap = captureConsole();
        await MeshService.getInstance().refreshAliasCache();
        cap.restore();
        expect(cap.lines.some((l) => l.includes('[Mesh:diag] alias cache refreshed'))).toBe(true);
    });

    it('emits a [Mesh:diag] line from a second instrumented method (enable-for-node)', async () => {
        const db = DatabaseService.getInstance();
        const localNodeId = db.getDefaultNode()?.id ?? 1;
        db.updateGlobalSetting('developer_mode', '1');
        const cap = captureConsole();
        // enableForNode on the local node is a pure DB write plus the diag and
        // activity log; the proxy-dial branch only runs for remote proxy nodes.
        await MeshService.getInstance().enableForNode(localNodeId);
        cap.restore();
        expect(cap.lines.some((l) => l.includes('[Mesh:diag] enable-for-node'))).toBe(true);
    });

    it('never leaks a remote node api token through diagnostics or logs', async () => {
        const SECRET = 'SUPERSECRET_TOKEN_abc123';
        const db = DatabaseService.getInstance();
        const remoteId = db.addNode({
            name: 'obs-remote',
            type: 'remote',
            compose_dir: '',
            is_default: false,
            // Port 1 refuses immediately, so the inspect fetch fails fast without
            // a real peer; the token still travels in the Bearer header.
            api_url: 'http://127.0.0.1:1',
            api_token: SECRET,
        });
        db.insertMeshStack(remoteId, 'obs-stack', 'tester');
        db.updateGlobalSetting('developer_mode', '1');

        const activity: unknown[] = [];
        const unsub = MeshService.getInstance().subscribeActivity((e) => activity.push(e));
        const cap = captureConsole();
        await MeshService.getInstance().refreshAliasCache();
        cap.restore();
        unsub();

        const haystack = `${cap.lines.join('\n')}\n${JSON.stringify(activity)}`;
        expect(haystack).not.toContain(SECRET);
    });
});
