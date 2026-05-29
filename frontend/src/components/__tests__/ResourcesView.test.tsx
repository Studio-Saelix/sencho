/**
 * Coverage for ResourcesView hardening.
 *
 * Locks two correctness fixes that manual smoke testing cannot reliably catch:
 *  - M-1: a slow resource fetch for a previously-active node must not overwrite
 *    the newly-selected node's data (node-switch generation guard).
 *  - M-2: a failed prune must surface the server error, never a false success.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    dismiss: vi.fn(),
  },
}));

const licenseState = { isPaid: true };
vi.mock('@/context/LicenseContext', () => ({ useLicense: () => licenseState }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ isAdmin: true }) }));

const nodesState: { activeNode: { id: number } | null } = { activeNode: { id: 1 } };
vi.mock('@/context/NodeContext', () => ({ useNodes: () => nodesState }));

vi.mock('@/hooks/useTrivyStatus', () => ({
  useTrivyStatus: () => ({
    status: { available: false, version: null, source: 'none', autoUpdate: false, busy: false },
    updateCheck: null,
    refresh: vi.fn(),
    refreshUpdateCheck: vi.fn(),
  }),
}));

// Heavy or portal-bound children are not under test; stub them to keep the
// render tree light and deterministic.
vi.mock('../VulnerabilityScanSheet', () => ({ VulnerabilityScanSheet: () => null }));
vi.mock('../resources/ReclaimHero', () => ({ ReclaimHero: () => null }));
vi.mock('../resources/FootprintTreemap', () => ({ FootprintTreemap: () => null }));
vi.mock('../resources/ImageDetailsSheet', () => ({ ImageDetailsSheet: () => null }));
vi.mock('../resources/VolumeBrowserSheet', () => ({ VolumeBrowserSheet: () => null }));
vi.mock('../resources/NetworkDetailSheet', () => ({ NetworkDetailSheet: () => null }));
vi.mock('../NetworkTopologyView', () => ({ default: () => null }));
vi.mock('../CapabilityGate', () => ({ CapabilityGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../LazyBoundary', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../NodeManager', () => ({ SENCHO_NAVIGATE_EVENT: 'sencho-navigate' }));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import ResourcesView from '../ResourcesView';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as unknown as Response;
}

function image(repoTag: string) {
  return {
    Id: `sha256:${repoTag}`,
    RepoTags: [repoTag],
    Size: 1000,
    Containers: 0,
    managedBy: null,
    managedStatus: 'unmanaged' as const,
    isSencho: false,
  };
}

beforeEach(() => {
  mockedFetch.mockReset();
  licenseState.isPaid = true;
  nodesState.activeNode = { id: 1 };
});

afterEach(() => vi.clearAllMocks());

describe('ResourcesView', () => {
  it('drops a stale node fetch so it cannot overwrite the newly selected node (M-1)', async () => {
    // Hold every /system/resources response open so we control resolution order.
    const resourcesResolvers: Array<(r: Response) => void> = [];
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/resources') {
        return new Promise<Response>((resolve) => resourcesResolvers.push(resolve));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const { rerender } = render(<ResourcesView />);
    await waitFor(() => expect(resourcesResolvers).toHaveLength(1));

    // Switch nodes before the first fetch resolves; the effect re-runs and
    // claims a newer generation.
    nodesState.activeNode = { id: 2 };
    rerender(<ResourcesView />);
    await waitFor(() => expect(resourcesResolvers).toHaveLength(2));

    // Resolve the newer (node 2) fetch first; its data should render.
    resourcesResolvers[1](jsonResponse({ images: [image('node2-img:latest')], volumes: [], networks: [] }));
    expect(await screen.findByText('node2-img:latest')).toBeInTheDocument();

    // Now resolve the stale (node 1) fetch. Its generation is old, so the guard
    // must drop it rather than stomp node 2's resources.
    resourcesResolvers[0](jsonResponse({ images: [image('node1-img:latest')], volumes: [], networks: [] }));
    await waitFor(() => {
      expect(screen.getByText('node2-img:latest')).toBeInTheDocument();
    });
    expect(screen.queryByText('node1-img:latest')).not.toBeInTheDocument();
  });

  it('surfaces the server error on a failed prune instead of a false success (M-2)', async () => {
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/prune/system' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ error: 'Prune blew up' }, { ok: false, status: 500 }));
      }
      if (url === '/system/resources') {
        return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith('/system/resources'));

    await user.click(screen.getByRole('button', { name: /Prune Unused Images/ }));
    await user.click(await screen.findByRole('button', { name: /^Prune$/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Prune blew up'));
    expect(toast.success).not.toHaveBeenCalled();
  });
});
