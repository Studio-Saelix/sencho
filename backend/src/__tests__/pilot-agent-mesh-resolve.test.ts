/**
 * Compose-label container resolver shared by the pilot agent and the
 * proxy-mode WS handler. The resolver runs the conventional compose name
 * fast path first (`<stack>-<service>-1`), then falls back to a
 * label-filtered `listContainers` call. The deterministic IP preference
 * lives in `pickContainerIp` and is exercised here through the wrapper.
 *
 * Central is the sole authority for mesh opt-in (state lives in central's
 * SQLite); the tunnel WS authentication is the trust boundary, so this
 * resolver has no per-stack gating.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setupTestDb, cleanupTestDb } from './helpers/setupTestDb';

const listContainersMock = vi.fn();
const inspectMock = vi.fn();
const getContainerMock = vi.fn(() => ({ inspect: inspectMock }));

vi.mock('dockerode', () => {
    function Docker(this: unknown) {
        const self = this as { listContainers: typeof listContainersMock; getContainer: typeof getContainerMock };
        self.listContainers = listContainersMock;
        self.getContainer = getContainerMock;
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
    inspectMock.mockReset();
    getContainerMock.mockClear();
});

describe('resolveByComposeLabels (mesh target resolver)', () => {
    it('uses the conventional name fast path when it succeeds', async () => {
        inspectMock.mockResolvedValueOnce({
            NetworkSettings: { Networks: { sencho_mesh: { IPAddress: '172.30.0.5' } } },
        });

        const result = await resolveByComposeLabels('audit-mesh-pilot', 'echo', 9001);

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('narrowing');
        expect(result.host).toBe('172.30.0.5');
        expect(result.port).toBe(9001);
        // Fast path hit; the label-filtered listContainers call was not needed.
        expect(getContainerMock).toHaveBeenCalledWith('audit-mesh-pilot-echo-1');
        expect(listContainersMock).not.toHaveBeenCalled();
    });

    it('falls back to a label-filtered listContainers when the fast path returns no IP', async () => {
        // Fast inspect returns a container with no usable IP.
        inspectMock.mockResolvedValueOnce({ NetworkSettings: { Networks: {} } });
        listContainersMock.mockResolvedValueOnce([{ Id: 'abc' }]);
        // Fallback inspect resolves the IP.
        inspectMock.mockResolvedValueOnce({
            NetworkSettings: { Networks: { bridge: { IPAddress: '10.0.0.7' } } },
        });

        const result = await resolveByComposeLabels('api', 'db', 5432);

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('narrowing');
        expect(result.host).toBe('10.0.0.7');
        expect(listContainersMock).toHaveBeenCalledTimes(1);
        const args = listContainersMock.mock.calls[0][0] as { filters: { label: string[] } };
        expect(args.filters.label).toEqual([
            'com.docker.compose.project=api',
            'com.docker.compose.service=db',
        ]);
    });

    it('returns no_target when both the fast path and label fallback find nothing', async () => {
        inspectMock.mockResolvedValueOnce(null);
        listContainersMock.mockResolvedValueOnce([]);

        const result = await resolveByComposeLabels('missing', 'svc', 8080);

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('narrowing');
        expect(result.err).toBe('no_target');
    });

    it('returns agent_error when dockerode rejects on the listContainers call', async () => {
        inspectMock.mockResolvedValueOnce(null);
        listContainersMock.mockRejectedValueOnce(new Error('docker daemon unreachable'));

        const result = await resolveByComposeLabels('api', 'db', 5432);

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('narrowing');
        expect(result.err).toBe('agent_error');
    });

    it('prefers the compose default network over any other attached network', async () => {
        // Container is attached to both bridge and stack_default; pickContainerIp
        // must return the stack_default IP regardless of object key order.
        inspectMock.mockResolvedValueOnce({
            NetworkSettings: {
                Networks: {
                    bridge: { IPAddress: '10.0.0.7' },
                    api_default: { IPAddress: '172.30.0.42' },
                },
            },
        });

        const result = await resolveByComposeLabels('api', 'db', 5432);

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('narrowing');
        expect(result.host).toBe('172.30.0.42');
    });
});
