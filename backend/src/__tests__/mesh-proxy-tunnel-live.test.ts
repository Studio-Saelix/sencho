/**
 * Live-network test for the proxy-mode mesh tunnel against a real remote
 * Sencho. SKIPPED unless `MESH_AUDIT_URL` and `MESH_AUDIT_TOKEN_FILE`
 * env vars are set; run by hand from a developer machine, never in CI.
 *
 * The token file path is read indirectly so the credential never appears
 * in the test source, environment dump, or vitest reporter output.
 *
 * Run manually:
 *   MESH_AUDIT_URL=http://<remote>:1852 \
 *   MESH_AUDIT_TOKEN_FILE=/tmp/mesh-audit-token.txt \
 *   npx vitest run --no-coverage src/__tests__/mesh-proxy-tunnel-live.test.ts
 */
import fs from 'fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

const REMOTE_URL = process.env.MESH_AUDIT_URL;
const TOKEN_FILE = process.env.MESH_AUDIT_TOKEN_FILE;
const enabled = !!(REMOTE_URL && TOKEN_FILE);
const describeLive = enabled ? describe : describe.skip;

let tmpDir: string;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let MeshProxyTunnelDialer: typeof import('../services/MeshProxyTunnelDialer').MeshProxyTunnelDialer;
let PilotMetrics: typeof import('../services/PilotMetrics').PilotMetrics;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ MeshProxyTunnelDialer } = await import('../services/MeshProxyTunnelDialer'));
    ({ PilotMetrics } = await import('../services/PilotMetrics'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

describeLive('MeshProxyTunnelDialer (live)', () => {
    it('dials a real Sencho remote, registers a bridge, dedupes a second call, and tears down', async () => {
        const token = fs.readFileSync(TOKEN_FILE!, 'utf8').trim();
        const dialer = MeshProxyTunnelDialer.resetForTest(0); // disable idle close
        const db = DatabaseService.getInstance();
        const nodeId = db.addNode({
            name: 'audit-mesh-live',
            type: 'remote',
            compose_dir: '',
            is_default: false,
            mode: 'proxy',
            api_url: REMOTE_URL!,
            api_token: token,
        });
        try {
            const before = PilotMetrics.snapshot();
            const t0 = Date.now();
            const bridge = await dialer.ensureBridge(nodeId);
            const elapsed = Date.now() - t0;
            expect(bridge, `dial returned null after ${elapsed}ms`).not.toBeNull();
            expect(elapsed).toBeLessThan(15_000);

            // Dedupe: second call hits the cached bridge instantly.
            const t1 = Date.now();
            const second = await dialer.ensureBridge(nodeId);
            expect(second).toBe(bridge);
            expect(Date.now() - t1).toBeLessThan(50);

            const after = PilotMetrics.snapshot();
            expect(after.proxy_bridges_total).toBeGreaterThan(before.proxy_bridges_total);

            dialer.closeBridge(nodeId, 'audit teardown');
            await new Promise((r) => setTimeout(r, 200));
            expect(dialer.hasBridge(nodeId)).toBe(false);
        } finally {
            db.getDb().prepare('DELETE FROM nodes WHERE id = ?').run(nodeId);
        }
    }, 30_000);

    it('records auth_failed and a single deduped activity entry when the token is rejected', async () => {
        const dialer = MeshProxyTunnelDialer.resetForTest(0);
        const db = DatabaseService.getInstance();
        const nodeId = db.addNode({
            name: 'audit-mesh-live-bad',
            type: 'remote',
            compose_dir: '',
            is_default: false,
            mode: 'proxy',
            api_url: REMOTE_URL!,
            api_token: 'this-is-not-a-real-jwt',
        });
        try {
            const result = await dialer.ensureBridge(nodeId);
            expect(result).toBeNull();
            const failure = dialer.getRecentFailure(nodeId);
            expect(failure?.code).toBe('auth_failed');

            // Second call should short-circuit via the recent-failure cache.
            const t0 = Date.now();
            const again = await dialer.ensureBridge(nodeId);
            expect(again).toBeNull();
            expect(Date.now() - t0).toBeLessThan(20);
        } finally {
            db.getDb().prepare('DELETE FROM nodes WHERE id = ?').run(nodeId);
        }
    }, 20_000);
});
