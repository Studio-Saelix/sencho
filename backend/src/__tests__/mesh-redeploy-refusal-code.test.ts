/**
 * Narrow contract test for `MeshService.triggerRedeploy` against a remote
 * node: when the registry delivery gate refuses the redeploy, the
 * fire-and-forget failure trail must keep the machine-readable refusal code.
 * The mesh activity event and the audit row persist message strings only, so
 * the code is asserted inside the suffix the gate appends to the message.
 *
 * The refusal is queued on a partial mock of the outbound helper (every other
 * export stays live, and non-queued calls delegate to the real
 * implementation), so the test pins what MeshService does with a refusal, not
 * how the refusal was produced.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

vi.mock('../helpers/registryDeliveryOutbound', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../helpers/registryDeliveryOutbound')>();
    return {
        ...actual,
        prepareOutboundRegistryDeliveryBody: vi.fn(
            (...args: Parameters<typeof actual.prepareOutboundRegistryDeliveryBody>) =>
                actual.prepareOutboundRegistryDeliveryBody(...args),
        ),
    };
});

let tmpDir: string;
let MeshService: typeof import('../services/MeshService').MeshService;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;
let NodeRegistry: typeof import('../services/NodeRegistry').NodeRegistry;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ MeshService } = await import('../services/MeshService'));
    ({ DatabaseService } = await import('../services/DatabaseService'));
    ({ NodeRegistry } = await import('../services/NodeRegistry'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('MeshService.triggerRedeploy (registry delivery refusal)', () => {
    it('carries the refusal code into the activity message and audit summary', async () => {
        const db = DatabaseService.getInstance();
        const stackName = 'mesh-refusal-stack';
        const remoteNodeId = db.addNode({
            name: 'mesh-redeploy-refusal-remote',
            type: 'remote',
            mode: 'proxy',
            compose_dir: '/tmp',
            is_default: false,
            api_url: 'https://remote.example.com:1852',
            api_token: 'remote-tok',
        });

        vi.spyOn(NodeRegistry.getInstance(), 'getProxyTarget').mockReturnValue({
            apiUrl: 'https://remote.example.com:1852',
            apiToken: 'remote-tok',
            trustedLoopback: false,
        });
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(new Response('ok', { status: 200 }));

        const outbound = await import('../helpers/registryDeliveryOutbound');
        vi.mocked(outbound.prepareOutboundRegistryDeliveryBody).mockResolvedValueOnce({
            ok: false as const,
            status: 409,
            code: 'REGISTRY_DELIVERY_CREDENTIAL_UNAVAILABLE',
            error: 'Registry credentials unavailable for challenged image hosts',
        });

        const svc = MeshService.getInstance();
        svc.triggerRedeploy(remoteNodeId, stackName, 'admin');

        // triggerRedeploy is fire-and-forget; wait for the catch handler to
        // land its activity event and its buffered audit row.
        await vi.waitFor(() => {
            const events = svc.getActivity({ source: 'mesh' });
            expect(events.some(e =>
                e.message.includes('mesh redeploy failed for ' + stackName + ':')
                && e.message.includes('[REGISTRY_DELIVERY_CREDENTIAL_UNAVAILABLE]'),
            )).toBe(true);
        });

        const audit = db.getAuditLogs({ search: stackName });
        const row = audit.entries.find(e => e.path.endsWith('/redeploy'));
        expect(row?.summary).toContain('Sencho Mesh: redeploy failed for ' + stackName);
        expect(row?.summary).toContain('[REGISTRY_DELIVERY_CREDENTIAL_UNAVAILABLE]');

        // The refusal is answered before any proxy fetch leaves the hub.
        expect(fetchMock).not.toHaveBeenCalled();

        db.deleteNode(remoteNodeId);
    });
});
