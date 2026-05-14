/**
 * F7 regression: the mesh dial path resolves a target by Compose labels
 * and does not consult any per-stack gating on the agent. Central is the
 * sole authority for mesh opt-in (state lives in central's SQLite); the
 * tunnel WS authentication is the trust boundary, so this resolver is
 * called unconditionally for any inbound `tcp_open` frame.
 *
 * The shared resolver `resolveByComposeLabels` lives in
 * `mesh/tcpStreamSwitchboard.ts` and is used by both the pilot agent and
 * the proxy-mode WS handler.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

const listContainersMock = vi.fn();

vi.mock('dockerode', () => {
    function Docker(this: unknown) {
        (this as { listContainers: typeof listContainersMock }).listContainers = listContainersMock;
    }
    return { default: Docker };
});

let tmpDir: string;
let resolveByComposeLabels: typeof import('../mesh/tcpStreamSwitchboard').resolveByComposeLabels;

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ resolveByComposeLabels } = await import('../mesh/tcpStreamSwitchboard'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

afterEach(() => {
    listContainersMock.mockReset();
});

describe('resolveByComposeLabels (mesh target resolver)', () => {
    it('returns the container IP from the first attached network', async () => {
        listContainersMock.mockResolvedValue([
            { NetworkSettings: { Networks: { sencho_mesh: { IPAddress: '172.30.0.5' } } } },
        ]);

        const result = await resolveByComposeLabels('audit-mesh-pilot', 'echo', 9001);

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('narrowing');
        expect(result.host).toBe('172.30.0.5');
        expect(result.port).toBe(9001);
    });

    it('queries dockerode with the Compose project + service label filter', async () => {
        listContainersMock.mockResolvedValue([
            { NetworkSettings: { Networks: { bridge: { IPAddress: '10.0.0.7' } } } },
        ]);

        await resolveByComposeLabels('api', 'db', 5432);

        expect(listContainersMock).toHaveBeenCalledTimes(1);
        const args = listContainersMock.mock.calls[0][0] as { filters: { label: string[] } };
        expect(args.filters.label).toEqual([
            'com.docker.compose.project=api',
            'com.docker.compose.service=db',
        ]);
    });

    it('returns no_target when dockerode finds no matching container', async () => {
        listContainersMock.mockResolvedValue([]);

        const result = await resolveByComposeLabels('missing', 'svc', 8080);

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('narrowing');
        expect(result.err).toBe('no_target');
    });

    it('returns agent_error when dockerode throws', async () => {
        listContainersMock.mockRejectedValue(new Error('docker daemon unreachable'));

        const result = await resolveByComposeLabels('api', 'db', 5432);

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('narrowing');
        expect(result.err).toBe('agent_error');
    });

    it('returns no_target when the matching container has no IP on any attached network', async () => {
        listContainersMock.mockResolvedValue([
            { NetworkSettings: { Networks: { bridge: {} } } },
        ]);

        const result = await resolveByComposeLabels('api', 'db', 5432);

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('narrowing');
        expect(result.err).toBe('no_target');
    });
});
