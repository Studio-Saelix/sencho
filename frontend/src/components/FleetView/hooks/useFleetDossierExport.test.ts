import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { unzipSync, strFromU8 } from 'fflate';

const apiFetchMock = vi.fn();
const fetchForNodeMock = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
  fetchForNode: (...args: unknown[]) => fetchForNodeMock(...args),
}));

const downloadBlobMock = vi.fn();
vi.mock('@/lib/download', () => ({
  downloadBlob: (...args: unknown[]) => downloadBlobMock(...args),
}));

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock('@/components/ui/toast-store', () => ({
  toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) },
}));

import { useFleetDossierExport } from './useFleetDossierExport';

function text(body: string, ok = true): Response {
  return new Response(body, { status: ok ? 200 : 500 });
}
function json(payload: unknown, ok = true): Response {
  return new Response(JSON.stringify(payload), { status: ok ? 200 : 500, headers: { 'Content-Type': 'application/json' } });
}

const COMPOSE = 'services:\n  plex:\n    image: x\n    ports:\n      - "32400:32400"\n';

interface NodeStacks { [nodeId: number]: Record<string, { compose?: Response; dossierPurpose?: string }>; }

function wireFetchForNode(stacks: NodeStacks) {
  fetchForNodeMock.mockImplementation((endpoint: string, nodeId: number) => {
    const nodeStacks = stacks[nodeId] ?? {};
    if (endpoint === '/stacks') return Promise.resolve(json(Object.keys(nodeStacks)));
    const m = endpoint.match(/^\/stacks\/([^/?]+)(\/[a-z-]+)?/);
    const name = m ? decodeURIComponent(m[1]) : '';
    const sub = m?.[2];
    const entry = nodeStacks[name];
    if (!entry) return Promise.resolve(json({ error: 'not found' }, false));
    if (!sub) return Promise.resolve(entry.compose ?? text(COMPOSE));
    if (sub === '/envs') return Promise.resolve(json({ envFiles: [] }));
    if (sub === '/env') return Promise.resolve(text(''));
    if (sub === '/git-source') return Promise.resolve(json({ linked: false }));
    if (sub === '/dossier') {
      return Promise.resolve(json({ purpose: entry.dossierPurpose ?? '' }));
    }
    return Promise.resolve(json({}, false));
  });
}

// Stub /fleet/overview with the given node list, keeping the beforeEach default
// for /meta (version) and the empty-array fallback.
function wireOverview(nodes: unknown[]): void {
  apiFetchMock.mockImplementation((endpoint: string) => {
    if (endpoint === '/fleet/overview') return Promise.resolve(json(nodes));
    if (endpoint === '/meta') return Promise.resolve(json({ version: '0.90.0' }));
    return Promise.resolve(json([]));
  });
}

async function readZip(): Promise<Record<string, string>> {
  expect(downloadBlobMock).toHaveBeenCalledTimes(1);
  const [filename, blob] = downloadBlobMock.mock.calls[0] as [string, Blob];
  expect(filename).toBe('homelab-dossier.zip');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const unzipped = unzipSync(bytes);
  const out: Record<string, string> = {};
  // The archive nests everything under a single homelab-dossier/ folder; strip
  // it so the assertions read against clean relative paths.
  for (const [path, data] of Object.entries(unzipped)) out[path.replace(/^homelab-dossier\//, '')] = strFromU8(data);
  return out;
}

beforeEach(() => {
  apiFetchMock.mockReset();
  fetchForNodeMock.mockReset();
  downloadBlobMock.mockReset();
  toastSuccess.mockReset();
  toastError.mockReset();
  apiFetchMock.mockImplementation((endpoint: string) => {
    if (endpoint === '/meta') return Promise.resolve(json({ version: '0.90.0' }));
    return Promise.resolve(json([]));
  });
});

describe('useFleetDossierExport', () => {
  it('builds and downloads a zip of the reachable fleet', async () => {
    wireOverview([{ id: 1, name: 'local', type: 'local', status: 'online' }]);
    wireFetchForNode({ 1: { plex: {} } });

    const { result } = renderHook(() => useFleetDossierExport());
    await act(async () => { await result.current.exportDossier(); });

    const files = await readZip();
    expect(files['index.md']).toContain('# Homelab Dossier');
    expect(files['index.md']).toContain('Sencho 0.90.0');
    expect(files['nodes/local.md']).toContain('# local');
    expect(files['stacks/local--plex.md']).toContain('# plex');
    expect(files['stacks/local--plex.md']).toContain('| plex | 32400 | 32400 | tcp |');
    expect(toastSuccess).toHaveBeenCalledWith('Fleet dossier exported.');
    expect(toastError).not.toHaveBeenCalled();
  });

  it('skips an offline node with a reason and reports the skip count', async () => {
    wireOverview([
      { id: 1, name: 'local', type: 'local', status: 'online' },
      { id: 2, name: 'media-node', type: 'remote', status: 'offline' },
    ]);
    wireFetchForNode({ 1: { plex: {} } });

    const { result } = renderHook(() => useFleetDossierExport());
    await act(async () => { await result.current.exportDossier(); });

    const files = await readZip();
    expect(files['index.md']).toContain('## Skipped nodes');
    expect(files['index.md']).toContain('- **media-node** (remote): node offline');
    expect(files['nodes/media-node.md']).toContain('Skipped');
    expect(files['stacks/media-node--plex.md']).toBeUndefined();
    expect(toastSuccess).toHaveBeenCalledWith('Fleet dossier exported. 1 node skipped (unreachable).');
  });

  it('emits a stub page when a stack compose cannot be read', async () => {
    wireOverview([{ id: 1, name: 'local', type: 'local', status: 'online' }]);
    wireFetchForNode({ 1: { broken: { compose: text('boom', false), dossierPurpose: 'documented anyway' } } });

    const { result } = renderHook(() => useFleetDossierExport());
    await act(async () => { await result.current.exportDossier(); });

    const files = await readZip();
    expect(files['stacks/local--broken.md']).toContain('compose.yaml could not be parsed');
    expect(files['stacks/local--broken.md']).toContain('- **Purpose:** documented anyway');
  });

  it('surfaces an error toast and does not download when the overview fetch fails', async () => {
    apiFetchMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/fleet/overview') return Promise.resolve(json({ error: 'boom' }, false));
      if (endpoint === '/meta') return Promise.resolve(json({ version: '0.90.0' }));
      return Promise.resolve(json([]));
    });

    const { result } = renderHook(() => useFleetDossierExport());
    await act(async () => { await result.current.exportDossier(); });

    expect(downloadBlobMock).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it('nests every file under a single homelab-dossier/ folder', async () => {
    wireOverview([{ id: 1, name: 'local', type: 'local', status: 'online' }]);
    wireFetchForNode({ 1: { plex: {} } });

    const { result } = renderHook(() => useFleetDossierExport());
    await act(async () => { await result.current.exportDossier(); });

    const [, blob] = downloadBlobMock.mock.calls[0] as [string, Blob];
    const entries = Object.keys(unzipSync(new Uint8Array(await blob.arrayBuffer())));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(p => p.startsWith('homelab-dossier/'))).toBe(true);
  });

  it('skips a node with unknown status and labels the reason', async () => {
    wireOverview([
      { id: 1, name: 'local', type: 'local', status: 'online' },
      { id: 2, name: 'media-node', type: 'remote', status: 'unknown' },
    ]);
    wireFetchForNode({ 1: { plex: {} } });

    const { result } = renderHook(() => useFleetDossierExport());
    await act(async () => { await result.current.exportDossier(); });

    const files = await readZip();
    expect(files['index.md']).toContain('- **media-node** (remote): node status unknown');
  });

  it('marks a node skipped when its stack list cannot be read', async () => {
    wireOverview([{ id: 1, name: 'local', type: 'local', status: 'online' }]);
    fetchForNodeMock.mockImplementation(() => Promise.resolve(json({ error: 'boom' }, false)));

    const { result } = renderHook(() => useFleetDossierExport());
    await act(async () => { await result.current.exportDossier(); });

    const files = await readZip();
    expect(files['index.md']).toContain('- **local** (local): stack list unavailable');
  });

  it('aborts without downloading when a node-scoped request returns Unauthorized', async () => {
    wireOverview([{ id: 1, name: 'local', type: 'local', status: 'online' }]);
    fetchForNodeMock.mockImplementation((endpoint: string) => {
      if (endpoint === '/stacks') return Promise.resolve(json(['plex']));
      // fetchForNode throws this sentinel on a 401 and fires a global logout.
      return Promise.reject(new Error('Unauthorized'));
    });

    const { result } = renderHook(() => useFleetDossierExport());
    await act(async () => { await result.current.exportDossier(); });

    expect(downloadBlobMock).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
