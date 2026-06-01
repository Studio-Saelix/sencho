/**
 * Unit coverage for the fleet snapshot capture helpers: a stack whose compose
 * file cannot be captured must be surfaced as a warning rather than silently
 * dropped, a genuinely-absent .env must NOT warn, a real .env read error must,
 * and a file over the size cap must be skipped with a warning.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetStacks = vi.fn();
const mockGetStackContent = vi.fn();
const mockGetEnvContent = vi.fn();
const mockGetProxyTarget = vi.fn();

vi.mock('../services/FileSystemService', () => ({
    FileSystemService: { getInstance: () => ({
        getStacks: mockGetStacks,
        getStackContent: mockGetStackContent,
        getEnvContent: mockGetEnvContent,
    }) },
}));

vi.mock('../services/NodeRegistry', () => ({
    NodeRegistry: { getInstance: () => ({ getProxyTarget: mockGetProxyTarget }) },
}));

import {
    captureLocalNodeFiles,
    captureRemoteNodeFiles,
    MAX_SNAPSHOT_FILE_BYTES,
} from '../utils/snapshot-capture';

const localNode = { id: 1, name: 'local', mode: 'proxy' as const };
const remoteNode = { id: 2, name: 'remote', mode: 'proxy' as const };

beforeEach(() => {
    vi.clearAllMocks();
    mockGetProxyTarget.mockReturnValue({ apiUrl: 'http://remote:1852', apiToken: 'tok' });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('captureLocalNodeFiles', () => {
    it('captures compose and .env with no warnings on the happy path', async () => {
        mockGetStacks.mockResolvedValue(['web']);
        mockGetStackContent.mockResolvedValue('services: {}\n');
        mockGetEnvContent.mockResolvedValue('KEY=value\n');

        const result = await captureLocalNodeFiles(localNode);

        expect(result.stacks).toHaveLength(1);
        expect(result.stacks[0].files.map(f => f.filename)).toEqual(['compose.yaml', '.env']);
        expect(result.warnings).toHaveLength(0);
    });

    it('drops the stack and warns when compose cannot be read', async () => {
        mockGetStacks.mockResolvedValue(['web']);
        mockGetStackContent.mockRejectedValue(new Error('EACCES'));

        const result = await captureLocalNodeFiles(localNode);

        expect(result.stacks).toHaveLength(0);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toMatchObject({ stackName: 'web' });
        expect(result.warnings[0].reason).toContain('compose.yaml could not be read');
    });

    it('does not warn when the .env is simply absent (ENOENT)', async () => {
        mockGetStacks.mockResolvedValue(['web']);
        mockGetStackContent.mockResolvedValue('services: {}\n');
        mockGetEnvContent.mockRejectedValue(Object.assign(new Error('no file'), { code: 'ENOENT' }));

        const result = await captureLocalNodeFiles(localNode);

        expect(result.stacks[0].files.map(f => f.filename)).toEqual(['compose.yaml']);
        expect(result.warnings).toHaveLength(0);
    });

    it('warns but still captures the stack when the .env read fails for a non-ENOENT reason', async () => {
        mockGetStacks.mockResolvedValue(['web']);
        mockGetStackContent.mockResolvedValue('services: {}\n');
        mockGetEnvContent.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

        const result = await captureLocalNodeFiles(localNode);

        expect(result.stacks[0].files.map(f => f.filename)).toEqual(['compose.yaml']);
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0].reason).toContain('.env could not be read');
    });

    it('skips a compose file that exceeds the size cap and warns', async () => {
        mockGetStacks.mockResolvedValue(['web']);
        mockGetStackContent.mockResolvedValue('x'.repeat(MAX_SNAPSHOT_FILE_BYTES + 1));

        const result = await captureLocalNodeFiles(localNode);

        expect(result.stacks).toHaveLength(0);
        expect(result.warnings[0].reason).toContain('exceeds');
    });

    it('keeps the stack but warns when the .env exceeds the size cap', async () => {
        mockGetStacks.mockResolvedValue(['web']);
        mockGetStackContent.mockResolvedValue('services: {}\n');
        mockGetEnvContent.mockResolvedValue('x'.repeat(MAX_SNAPSHOT_FILE_BYTES + 1));

        const result = await captureLocalNodeFiles(localNode);

        expect(result.stacks[0].files.map(f => f.filename)).toEqual(['compose.yaml']);
        expect(result.warnings[0].reason).toContain('exceeds');
    });
});

describe('captureRemoteNodeFiles', () => {
    function mockFetchRoutes(routes: Record<string, Partial<Response> & { jsonValue?: unknown; textValue?: string }>) {
        const fetchMock = vi.fn(async (url: string) => {
            const match = Object.keys(routes).find(k => url.endsWith(k));
            const r = match ? routes[match] : { ok: false, status: 404 };
            return {
                ok: r.ok ?? true,
                status: r.status ?? 200,
                json: async () => (r as { jsonValue?: unknown }).jsonValue,
                text: async () => (r as { textValue?: string }).textValue ?? '',
            } as Response;
        });
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    }

    it('captures compose and .env with no warnings on the happy path', async () => {
        mockFetchRoutes({
            '/api/stacks': { ok: true, jsonValue: ['web'] },
            '/api/stacks/web': { ok: true, textValue: 'services: {}\n' },
            '/api/stacks/web/env': { ok: true, textValue: 'KEY=value\n' },
        });

        const result = await captureRemoteNodeFiles(remoteNode);

        expect(result.stacks).toHaveLength(1);
        expect(result.stacks[0].files.map(f => f.filename)).toEqual(['compose.yaml', '.env']);
        expect(result.warnings).toHaveLength(0);
    });

    it('drops the stack and warns when the remote compose fetch is not ok', async () => {
        mockFetchRoutes({
            '/api/stacks': { ok: true, jsonValue: ['web'] },
            '/api/stacks/web': { ok: false, status: 500 },
        });

        const result = await captureRemoteNodeFiles(remoteNode);

        expect(result.stacks).toHaveLength(0);
        expect(result.warnings[0].reason).toContain('HTTP 500');
    });

    it('treats a 404 .env as absent without warning', async () => {
        mockFetchRoutes({
            '/api/stacks': { ok: true, jsonValue: ['web'] },
            '/api/stacks/web': { ok: true, textValue: 'services: {}\n' },
            '/api/stacks/web/env': { ok: false, status: 404 },
        });

        const result = await captureRemoteNodeFiles(remoteNode);

        expect(result.stacks[0].files.map(f => f.filename)).toEqual(['compose.yaml']);
        expect(result.warnings).toHaveLength(0);
    });

    it('warns when the remote .env fetch fails for a non-404 reason', async () => {
        mockFetchRoutes({
            '/api/stacks': { ok: true, jsonValue: ['web'] },
            '/api/stacks/web': { ok: true, textValue: 'services: {}\n' },
            '/api/stacks/web/env': { ok: false, status: 500 },
        });

        const result = await captureRemoteNodeFiles(remoteNode);

        expect(result.stacks[0].files.map(f => f.filename)).toEqual(['compose.yaml']);
        expect(result.warnings[0].reason).toContain('HTTP 500');
    });

    it('keeps the stack but warns when the remote .env exceeds the size cap', async () => {
        mockFetchRoutes({
            '/api/stacks': { ok: true, jsonValue: ['web'] },
            '/api/stacks/web': { ok: true, textValue: 'services: {}\n' },
            '/api/stacks/web/env': { ok: true, textValue: 'x'.repeat(MAX_SNAPSHOT_FILE_BYTES + 1) },
        });

        const result = await captureRemoteNodeFiles(remoteNode);

        expect(result.stacks[0].files.map(f => f.filename)).toEqual(['compose.yaml']);
        expect(result.warnings[0].reason).toContain('exceeds');
    });

    it('drops the stack and warns when the remote compose fetch throws', async () => {
        const fetchMock = vi.fn(async (url: string) => {
            if (url.endsWith('/api/stacks')) {
                return { ok: true, status: 200, json: async () => ['web'], text: async () => '' } as Response;
            }
            throw new Error('network down');
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await captureRemoteNodeFiles(remoteNode);

        expect(result.stacks).toHaveLength(0);
        expect(result.warnings[0].reason).toContain('fetch error');
    });
});
