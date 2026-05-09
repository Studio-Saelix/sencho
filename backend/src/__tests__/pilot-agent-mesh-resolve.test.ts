/**
 * F7 regression: pilot agent's mesh dial path no longer denies based on the
 * pilot's local `mesh_stacks` table. Central is the sole authority for
 * mesh opt-in (state lives in central's SQLite); the pilot resolves the
 * target container by Compose labels and dials it directly. The tunnel JWT
 * authenticates the caller, so per-stack gating on the pilot would only
 * deny legitimate central-issued dials whenever Phase D's central-only
 * state model is in effect.
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
let PilotAgent: typeof import('../pilot/agent').PilotAgent;
let DatabaseService: typeof import('../services/DatabaseService').DatabaseService;

interface ResolveResult {
    ok: boolean;
    host?: string;
    port?: number;
    err?: string;
}

function makeAgent(): import('../pilot/agent').PilotAgent {
    return new PilotAgent({
        primaryUrl: 'http://primary.invalid',
        loopbackPort: 1,
        initialToken: 'irrelevant',
        enrolling: false,
    });
}

function callResolve(agent: import('../pilot/agent').PilotAgent, stack: string, service: string, port: number): Promise<ResolveResult> {
    const fn = (agent as unknown as { resolveMeshTarget: (s: string, sv: string, p: number) => Promise<ResolveResult> }).resolveMeshTarget.bind(agent);
    return fn(stack, service, port);
}

beforeAll(async () => {
    tmpDir = await setupTestDb();
    ({ PilotAgent } = await import('../pilot/agent'));
    ({ DatabaseService } = await import('../services/DatabaseService'));
});

afterAll(() => {
    cleanupTestDb(tmpDir);
});

afterEach(() => {
    listContainersMock.mockReset();
    DatabaseService.getInstance().getDb().prepare('DELETE FROM mesh_stacks').run();
});

describe('PilotAgent.resolveMeshTarget (F7: trust central)', () => {
    it('returns the container IP when mesh_stacks is empty (central is the gate)', async () => {
        listContainersMock.mockResolvedValue([
            { NetworkSettings: { Networks: { sencho_mesh: { IPAddress: '172.30.0.5' } } } },
        ]);

        const agent = makeAgent();
        const result = await callResolve(agent, 'audit-mesh-pilot', 'echo', 9001);

        expect(result.err).not.toBe('denied');
        expect(result.ok).toBe(true);
        expect(result.host).toBe('172.30.0.5');
        expect(result.port).toBe(9001);
    });

    it('queries dockerode with the Compose project + service label filter', async () => {
        listContainersMock.mockResolvedValue([
            { NetworkSettings: { Networks: { bridge: { IPAddress: '10.0.0.7' } } } },
        ]);

        const agent = makeAgent();
        await callResolve(agent, 'api', 'db', 5432);

        expect(listContainersMock).toHaveBeenCalledTimes(1);
        const args = listContainersMock.mock.calls[0][0] as { filters: { label: string[] } };
        expect(args.filters.label).toEqual([
            'com.docker.compose.project=api',
            'com.docker.compose.service=db',
        ]);
    });

    it('returns no_target (not denied) when dockerode finds no matching container', async () => {
        listContainersMock.mockResolvedValue([]);

        const agent = makeAgent();
        const result = await callResolve(agent, 'missing', 'svc', 8080);

        expect(result.ok).toBe(false);
        expect(result.err).toBe('no_target');
    });

    it('returns agent_error (not denied) when dockerode throws', async () => {
        listContainersMock.mockRejectedValue(new Error('docker daemon unreachable'));

        const agent = makeAgent();
        const result = await callResolve(agent, 'api', 'db', 5432);

        expect(result.ok).toBe(false);
        expect(result.err).toBe('agent_error');
    });
});
