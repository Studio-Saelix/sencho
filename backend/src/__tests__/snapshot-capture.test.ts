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
const mockGetStackDossier = vi.fn();

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

vi.mock('../services/DatabaseService', () => ({
    DatabaseService: { getInstance: () => ({ getStackDossier: mockGetStackDossier }) },
}));

import {
    captureLocalNodeFiles,
    captureRemoteNodeFiles,
    buildSnapshotDocumentation,
    pickDossierFields,
    dossierHasContent,
    MAX_SNAPSHOT_FILE_BYTES,
    type SnapshotNodeData,
} from '../utils/snapshot-capture';
import type { StackDossierFields } from '../services/DatabaseService';

const BLANK_DOSSIER: StackDossierFields = {
    purpose: '', owner: '', access_urls: '', static_ip: '', vlan: '', firewall_notes: '',
    reverse_proxy_notes: '', backup_notes: '', upgrade_notes: '', recovery_notes: '', custom_notes: '',
};

function dossier(partial: Partial<StackDossierFields>): StackDossierFields {
    return { ...BLANK_DOSSIER, ...partial };
}

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
    function mockFetchRoutes(routes: Record<string, Partial<Response> & { jsonValue?: unknown; textValue?: string; xEnvExists?: string }>) {
        const fetchMock = vi.fn(async (url: string) => {
            const match = Object.keys(routes).find(k => url.endsWith(k));
            const r = match ? routes[match] : { ok: false, status: 404 };
            return {
                ok: r.ok ?? true,
                status: r.status ?? 200,
                headers: { get: (name: string) => name.toLowerCase() === 'x-env-exists' ? ((r as { xEnvExists?: string }).xEnvExists ?? null) : null },
                json: async () => (r as { jsonValue?: unknown }).jsonValue,
                text: async () => (r as { textValue?: string }).textValue ?? '',
            } as unknown as Response;
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

    it('treats a remote .env as absent (no empty file) when X-Env-Exists is false', async () => {
        mockFetchRoutes({
            '/api/stacks': { ok: true, jsonValue: ['web'] },
            '/api/stacks/web': { ok: true, textValue: 'services: {}\n' },
            '/api/stacks/web/env': { ok: true, textValue: '', xEnvExists: 'false' },
        });

        const result = await captureRemoteNodeFiles(remoteNode);

        expect(result.stacks[0].files.map(f => f.filename)).toEqual(['compose.yaml']);
        expect(result.warnings).toHaveLength(0);
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

describe('documentation capture', () => {
    function mockFetchRoutes(routes: Record<string, Partial<Response> & { jsonValue?: unknown; textValue?: string; xEnvExists?: string }>) {
        const fetchMock = vi.fn(async (url: string) => {
            const match = Object.keys(routes).find(k => url.endsWith(k));
            const r = match ? routes[match] : { ok: false, status: 404 };
            return {
                ok: r.ok ?? true,
                status: r.status ?? 200,
                headers: { get: (name: string) => name.toLowerCase() === 'x-env-exists' ? ((r as { xEnvExists?: string }).xEnvExists ?? null) : null },
                json: async () => (r as { jsonValue?: unknown }).jsonValue,
                text: async () => (r as { textValue?: string }).textValue ?? '',
            } as unknown as Response;
        });
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    }

    it('captures local dossier notes when captureDocs is on and the stack has content', async () => {
        mockGetStacks.mockResolvedValue(['web']);
        mockGetStackContent.mockResolvedValue('services: {}\n');
        mockGetEnvContent.mockRejectedValue(Object.assign(new Error('no file'), { code: 'ENOENT' }));
        mockGetStackDossier.mockReturnValue(dossier({ purpose: 'edge proxy', owner: 'ops' }));

        const result = await captureLocalNodeFiles(localNode, true);

        expect(result.stacks[0].dossier).toMatchObject({ purpose: 'edge proxy', owner: 'ops' });
        expect(result.docWarnings).toHaveLength(0);
    });

    it('omits the local dossier when every field is blank', async () => {
        mockGetStacks.mockResolvedValue(['web']);
        mockGetStackContent.mockResolvedValue('services: {}\n');
        mockGetEnvContent.mockRejectedValue(Object.assign(new Error('no file'), { code: 'ENOENT' }));
        mockGetStackDossier.mockReturnValue(undefined);

        const result = await captureLocalNodeFiles(localNode, true);

        expect(result.stacks[0].dossier).toBeUndefined();
    });

    it('does not read dossiers when captureDocs is off (default)', async () => {
        mockGetStacks.mockResolvedValue(['web']);
        mockGetStackContent.mockResolvedValue('services: {}\n');
        mockGetEnvContent.mockRejectedValue(Object.assign(new Error('no file'), { code: 'ENOENT' }));

        const result = await captureLocalNodeFiles(localNode);

        expect(result.stacks[0].dossier).toBeUndefined();
        expect(mockGetStackDossier).not.toHaveBeenCalled();
    });

    it('captures dossier notes from the remote dossier endpoint', async () => {
        mockFetchRoutes({
            '/api/stacks': { ok: true, jsonValue: ['web'] },
            '/api/stacks/web': { ok: true, textValue: 'services: {}\n' },
            '/api/stacks/web/env': { ok: false, status: 404 },
            '/api/stacks/web/dossier': { ok: true, jsonValue: dossier({ purpose: 'edge' }) },
        });

        const result = await captureRemoteNodeFiles(remoteNode, true);

        expect(result.stacks[0].dossier).toMatchObject({ purpose: 'edge' });
        expect(result.docWarnings).toHaveLength(0);
    });

    it('records a doc warning when the remote dossier fetch fails (non-404)', async () => {
        mockFetchRoutes({
            '/api/stacks': { ok: true, jsonValue: ['web'] },
            '/api/stacks/web': { ok: true, textValue: 'services: {}\n' },
            '/api/stacks/web/env': { ok: false, status: 404 },
            '/api/stacks/web/dossier': { ok: false, status: 500 },
        });

        const result = await captureRemoteNodeFiles(remoteNode, true);

        expect(result.stacks).toHaveLength(1);
        expect(result.stacks[0].dossier).toBeUndefined();
        expect(result.docWarnings[0].reason).toContain('HTTP 500');
    });

    it('treats a 404 dossier as absent without warning', async () => {
        mockFetchRoutes({
            '/api/stacks': { ok: true, jsonValue: ['web'] },
            '/api/stacks/web': { ok: true, textValue: 'services: {}\n' },
            '/api/stacks/web/env': { ok: false, status: 404 },
            '/api/stacks/web/dossier': { ok: false, status: 404 },
        });

        const result = await captureRemoteNodeFiles(remoteNode, true);

        expect(result.stacks[0].dossier).toBeUndefined();
        expect(result.docWarnings).toHaveLength(0);
    });

    it('pickDossierFields keeps only the eleven string fields and drops extras', () => {
        const f = pickDossierFields({ purpose: 'p', owner: 'o', node_id: 5, source_hash: 'x' } as Record<string, unknown>);
        expect(f.purpose).toBe('p');
        expect(f.owner).toBe('o');
        expect(Object.keys(f)).toHaveLength(11);
        expect((f as unknown as Record<string, unknown>).node_id).toBeUndefined();
    });

    it('dossierHasContent is false for all-blank or whitespace, true for any real value', () => {
        expect(dossierHasContent(BLANK_DOSSIER)).toBe(false);
        expect(dossierHasContent(dossier({ vlan: '   ' }))).toBe(false);
        expect(dossierHasContent(dossier({ purpose: 'x' }))).toBe(true);
    });

    it('buildSnapshotDocumentation returns null when nothing was captured', () => {
        const nodes: SnapshotNodeData[] = [
            { nodeId: 1, nodeName: 'a', stacks: [{ stackName: 'web', files: [] }], warnings: [], docWarnings: [] },
        ];
        expect(buildSnapshotDocumentation(nodes, 'now')).toBeNull();
    });

    it('buildSnapshotDocumentation aggregates dossiers and dossier warnings', () => {
        const nodes: SnapshotNodeData[] = [{
            nodeId: 1,
            nodeName: 'a',
            stacks: [{ stackName: 'web', files: [], dossier: dossier({ purpose: 'p' }) }],
            warnings: [],
            docWarnings: [{ stackName: 'db', reason: 'boom' }],
        }];

        const doc = buildSnapshotDocumentation(nodes, '2026-01-01T00:00:00Z');

        expect(doc).not.toBeNull();
        expect(doc!.stacks).toHaveLength(1);
        expect(doc!.stacks[0]).toMatchObject({ nodeId: 1, nodeName: 'a', stackName: 'web' });
        expect(doc!.warnings[0]).toMatchObject({ nodeId: 1, stackName: 'db', reason: 'boom' });
        expect(doc!.generated_at).toBe('2026-01-01T00:00:00Z');
    });
});
