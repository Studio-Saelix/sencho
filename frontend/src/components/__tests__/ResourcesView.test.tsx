/**
 * Coverage for ResourcesView hardening.
 *
 * Locks correctness fixes that manual smoke testing cannot reliably catch:
 *  - M-1: a slow resource fetch for a previously-active node must not overwrite
 *    the newly-selected node's data (node-switch generation guard).
 *  - M-2: a failed prune must surface the server error, never a false success.
 *  - Reclaim banner: "Review & prune" reclaims every advertised category and a
 *    partial failure reports a warning, never a false success; dismiss snoozes
 *    the banner until the reclaimable total grows past the dismissed snapshot.
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
// Testable stub: surfaces visibility (testid) and the two callbacks so the
// snooze and reclaim-all flows can be driven without the real banner styling.
// Mirrors the real component's bytes<=0 guard.
vi.mock('../resources/ReclaimHero', () => ({
  ReclaimHero: ({ bytes, onReview, onDismiss }: { bytes: number; onReview: () => void; onDismiss: () => void }) =>
    bytes <= 0 ? null : (
      <div data-testid="reclaim-hero">
        <button onClick={onReview}>Review &amp; prune</button>
        <button onClick={onDismiss}>Dismiss hero</button>
      </div>
    ),
}));
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
  localStorage.clear();
});

// Reclaimable usage shape with a non-zero total so the banner is shown.
function reclaimableUsage(images: number, volumes: number) {
  return {
    reclaimableImages: images,
    reclaimableContainers: 0,
    reclaimableVolumes: volumes,
    reclaimableImageCount: images > 0 ? 1 : 0,
    reclaimableContainerCount: 0,
    reclaimableVolumeCount: volumes > 0 ? 1 : 0,
    managedImageBytes: 0,
    unmanagedImageBytes: 0,
    managedVolumeBytes: 0,
    unmanagedVolumeBytes: 0,
  };
}

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

  it('does not surface a load failure that resolves after the view unmounts', async () => {
    let rejectResources: ((e: unknown) => void) | undefined;
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/resources') {
        return new Promise<Response>((_resolve, reject) => { rejectResources = reject; });
      }
      return Promise.resolve(jsonResponse({}));
    });

    const { unmount } = render(<ResourcesView />);
    await waitFor(() => expect(rejectResources).toBeDefined());

    unmount();
    rejectResources!(new Error('network down'));
    await Promise.resolve();
    await Promise.resolve();

    expect(toast.error).not.toHaveBeenCalled();
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

  it('reports partial failure from "Review & prune" without a false success', async () => {
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/prune/system' && opts?.method === 'POST') {
        const target = (JSON.parse(String(opts.body)) as { target: string }).target;
        if (target === 'volumes') {
          return Promise.resolve(jsonResponse({ error: 'volume prune failed' }, { ok: false, status: 500 }));
        }
        return Promise.resolve(jsonResponse({ reclaimedBytes: 100 }));
      }
      if (url === '/system/docker-df') return Promise.resolve(jsonResponse(reclaimableUsage(1000, 500)));
      if (url === '/system/resources') return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);

    await user.click(await screen.findByRole('button', { name: /Review & prune/ }));
    await user.click(await screen.findByRole('button', { name: /^Reclaim/ }));

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    const warningMsg = (toast.warning as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(warningMsg).toMatch(/volumes/);
    expect(toast.success).not.toHaveBeenCalled();
    // Volumes are pruned first (while stopped containers still protect their
    // named volumes), then containers, then images.
    const pruned = mockedFetch.mock.calls
      .filter(([u, o]) => u === '/system/prune/system' && (o as RequestInit)?.method === 'POST')
      .map(([, o]) => (JSON.parse(String((o as RequestInit).body)) as { target: string }).target);
    expect(pruned).toEqual(['volumes', 'containers', 'images']);
  });

  it('reports an error when every prune fails, with no success or warning', async () => {
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/prune/system' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ error: 'daemon down' }, { ok: false, status: 500 }));
      }
      if (url === '/system/docker-df') return Promise.resolve(jsonResponse(reclaimableUsage(1000, 500)));
      if (url === '/system/resources') return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    await user.click(await screen.findByRole('button', { name: /Review & prune/ }));
    await user.click(await screen.findByRole('button', { name: /^Reclaim/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to reclaim disk space.'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('omits the reclaimed figure on full success when the daemon reports zero bytes', async () => {
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/prune/system' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ reclaimedBytes: 0 }));
      }
      if (url === '/system/docker-df') return Promise.resolve(jsonResponse(reclaimableUsage(1000, 500)));
      if (url === '/system/resources') return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    await user.click(await screen.findByRole('button', { name: /Review & prune/ }));
    await user.click(await screen.findByRole('button', { name: /^Reclaim/ }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const msg = (toast.success as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).not.toMatch(/Freed/);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows the reclaimed figure on full success when the daemon reports bytes', async () => {
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/prune/system' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ reclaimedBytes: 1048576 }));
      }
      if (url === '/system/docker-df') return Promise.resolve(jsonResponse(reclaimableUsage(1000, 500)));
      if (url === '/system/resources') return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    await user.click(await screen.findByRole('button', { name: /Review & prune/ }));
    await user.click(await screen.findByRole('button', { name: /^Reclaim/ }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const msg = (toast.success as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toMatch(/Freed/);
  });

  it('snoozes the banner on dismiss and brings it back when more space is reclaimable', async () => {
    let usage = reclaimableUsage(1000, 500); // 1500 B total
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/docker-df') return Promise.resolve(jsonResponse(usage));
      if (url === '/system/resources') return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    const { rerender } = render(<ResourcesView />);
    await screen.findByTestId('reclaim-hero');

    // Dismiss snapshots the current total; the banner hides.
    await user.click(screen.getByRole('button', { name: /Dismiss hero/ }));
    await waitFor(() => expect(screen.queryByTestId('reclaim-hero')).not.toBeInTheDocument());

    // A larger reclaimable total on the same node pushes past the snapshot, so
    // the banner returns. Same node id keeps the snapshot; the new activeNode
    // object reference triggers a refetch.
    usage = reclaimableUsage(8000, 2000); // 10000 B total
    nodesState.activeNode = { id: 1 };
    rerender(<ResourcesView />);
    await screen.findByTestId('reclaim-hero');
  });

  it('keeps the banner hidden after dismiss when the reclaimable total does not grow', async () => {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/docker-df') return Promise.resolve(jsonResponse(reclaimableUsage(1000, 500)));
      if (url === '/system/resources') return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    const { rerender } = render(<ResourcesView />);
    await screen.findByTestId('reclaim-hero');

    await user.click(screen.getByRole('button', { name: /Dismiss hero/ }));
    await waitFor(() => expect(screen.queryByTestId('reclaim-hero')).not.toBeInTheDocument());

    // A stable residue (the same total on the same node) must stay dismissed
    // across a refetch, not re-nag. Force a refetch via a new activeNode ref.
    const dfCalls = () => mockedFetch.mock.calls.filter(([u]) => u === '/system/docker-df').length;
    const before = dfCalls();
    nodesState.activeNode = { id: 1 };
    rerender(<ResourcesView />);
    await waitFor(() => expect(dfCalls()).toBeGreaterThan(before));
    expect(screen.queryByTestId('reclaim-hero')).not.toBeInTheDocument();
  });
});
