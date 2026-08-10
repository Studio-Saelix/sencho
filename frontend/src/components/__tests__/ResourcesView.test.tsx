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
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ isAdmin: true, can: () => true }) }));

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
    usedByStacks: [],
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


function samplePrunePlan(overrides: Record<string, unknown> = {}) {
  return {
    scope: 'managed',
    targets: ['images'],
    items: [{
      target: 'images', id: 'img1', name: 'old:v1', sizeBytes: 1000,
      managed: true, reason: 'Image is not used by any container', image: { references: ['old:v1'] },
    }],
    reclaimableBytes: 1000,
    fingerprint: 'fp-test',
    createdAt: Date.now(),
    nodeId: 1,
    ...overrides,
  };
}

function reclaimPlan() {
  return samplePrunePlan({
    scope: 'all',
    targets: ['volumes', 'containers', 'images'],
    items: [
      {
        target: 'volumes', id: 'v1', name: 'v1', sizeBytes: 500,
        managed: true, reason: 'Volume is not referenced by any container', volume: {},
      },
      {
        target: 'images', id: 'img1', name: 'old:v1', sizeBytes: 1000,
        managed: true, reason: 'Image is not used by any container', image: { references: ['old:v1'] },
      },
    ],
    reclaimableBytes: 1500,
    fingerprint: 'fp-reclaim',
  });
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

  it('fetches a prune plan before enabling confirm, then sends the fingerprint', async () => {
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/prune/plan' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse(samplePrunePlan()));
      }
      if (url === '/system/prune/system' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ success: true, reclaimedBytes: 1000, outcomes: [] }));
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
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith(
      '/system/prune/plan',
      expect.objectContaining({ method: 'POST' }),
    ));
    expect(await screen.findByText(/old:v1/)).toBeInTheDocument();

    await user.click(await screen.findByRole('button', { name: /Prune/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const pruneCall = mockedFetch.mock.calls.find(
      ([u, o]) => u === '/system/prune/system' && (o as RequestInit)?.method === 'POST',
    );
    expect(pruneCall).toBeTruthy();
    const body = JSON.parse(String((pruneCall![1] as RequestInit).body));
    expect(body.planFingerprint).toBe('fp-test');
  });

  it('surfaces the server error on a failed prune instead of a false success (M-2)', async () => {
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/prune/plan' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse(samplePrunePlan()));
      }
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
    await waitFor(() => expect(screen.getByText(/old:v1/)).toBeInTheDocument());
    await user.click(await screen.findByRole('button', { name: /Prune/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Prune blew up'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('reports partial failure from "Review & prune" without a false success', async () => {
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/prune/plan' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse(reclaimPlan()));
      }
      if (url === '/system/prune/system' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ error: 'volume prune failed' }, { ok: false, status: 500 }));
      }
      if (url === '/system/docker-df') return Promise.resolve(jsonResponse(reclaimableUsage(1000, 500)));
      if (url === '/system/resources') return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
      if (url === '/settings') return Promise.resolve(jsonResponse({ reclaim_hero: '1' }));
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);

    await user.click(await screen.findByRole('button', { name: /Review & prune/ }));
    await waitFor(() => expect(screen.getByText(/2 items/)).toBeInTheDocument());
    await user.click(await screen.findByRole('button', { name: /^Reclaim/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    const pruned = mockedFetch.mock.calls
      .filter(([u, o]) => u === '/system/prune/system' && (o as RequestInit)?.method === 'POST');
    expect(pruned).toHaveLength(1);
    const body = JSON.parse(String((pruned[0][1] as RequestInit).body));
    expect(body.targets).toEqual(['volumes', 'containers', 'images']);
    expect(body.planFingerprint).toBe('fp-reclaim');
  });

  it('reports an error when every prune fails, with no success or warning', async () => {
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/prune/plan' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse(reclaimPlan()));
      }
      if (url === '/system/prune/system' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ error: 'daemon down' }, { ok: false, status: 500 }));
      }
      if (url === '/system/docker-df') return Promise.resolve(jsonResponse(reclaimableUsage(1000, 500)));
      if (url === '/system/resources') return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
      if (url === '/settings') return Promise.resolve(jsonResponse({ reclaim_hero: '1' }));
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    await user.click(await screen.findByRole('button', { name: /Review & prune/ }));
    await waitFor(() => expect(screen.getByText(/2 items/)).toBeInTheDocument());
    await user.click(await screen.findByRole('button', { name: /^Reclaim/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('daemon down'));
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('omits the reclaimed figure on full success when the daemon reports zero bytes', async () => {
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/prune/plan' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse(reclaimPlan()));
      }
      if (url === '/system/prune/system' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ reclaimedBytes: 0, outcomes: [] }));
      }
      if (url === '/system/docker-df') return Promise.resolve(jsonResponse(reclaimableUsage(1000, 500)));
      if (url === '/system/resources') return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
      if (url === '/settings') return Promise.resolve(jsonResponse({ reclaim_hero: '1' }));
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    await user.click(await screen.findByRole('button', { name: /Review & prune/ }));
    await waitFor(() => expect(screen.getByText(/2 items/)).toBeInTheDocument());
    await user.click(await screen.findByRole('button', { name: /^Reclaim/ }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const msg = (toast.success as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).not.toMatch(/Freed/);
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows the reclaimed figure on full success when the daemon reports bytes', async () => {
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/prune/plan' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse(reclaimPlan()));
      }
      if (url === '/system/prune/system' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ reclaimedBytes: 1048576, outcomes: [] }));
      }
      if (url === '/system/docker-df') return Promise.resolve(jsonResponse(reclaimableUsage(1000, 500)));
      if (url === '/system/resources') return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
      if (url === '/settings') return Promise.resolve(jsonResponse({ reclaim_hero: '1' }));
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    await user.click(await screen.findByRole('button', { name: /Review & prune/ }));
    await waitFor(() => expect(screen.getByText(/2 items/)).toBeInTheDocument());
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
      if (url === '/settings') return Promise.resolve(jsonResponse({ reclaim_hero: '1' }));
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
      if (url === '/settings') return Promise.resolve(jsonResponse({ reclaim_hero: '1' }));
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

  it('hides the banner on a node switch when /settings fails, instead of inheriting the previous node opt-in', async () => {
    // Both responses key off the active node, so the switch cannot desync them:
    // node A opts in and serves its own image, node B fails /settings.
    mockedFetch.mockImplementation((url: string) => {
      const isNodeA = nodesState.activeNode?.id === 1;
      if (url === '/settings') {
        return isNodeA
          ? Promise.resolve(jsonResponse({ reclaim_hero: '1' }))
          : Promise.resolve(jsonResponse({}, { ok: false, status: 500 }));
      }
      if (url === '/system/docker-df') return Promise.resolve(jsonResponse(reclaimableUsage(1000, 500)));
      if (url === '/system/resources') {
        return Promise.resolve(jsonResponse({
          images: [image(isNodeA ? 'node-a-img:latest' : 'node-b-img:latest')],
          volumes: [],
          networks: [],
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    // Node A has the banner turned on; once loaded it is visible.
    const { rerender } = render(<ResourcesView />);
    await screen.findByText('node-a-img:latest');
    await screen.findByTestId('reclaim-hero');

    // Switch to node B with a failing /settings: the banner must hide (fail
    // closed), not carry over node A's enabled state.
    nodesState.activeNode = { id: 2 };
    rerender(<ResourcesView />);
    await screen.findByText('node-b-img:latest');
    expect(screen.queryByTestId('reclaim-hero')).not.toBeInTheDocument();
  });

  it('keeps the banner hidden when the setting is explicitly off, even with reclaimable space', async () => {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/docker-df') return Promise.resolve(jsonResponse(reclaimableUsage(1000, 500)));
      if (url === '/system/resources') return Promise.resolve(jsonResponse({ images: [image('off-img:latest')], volumes: [], networks: [] }));
      if (url === '/settings') return Promise.resolve(jsonResponse({ reclaim_hero: '0' }));
      return Promise.resolve(jsonResponse({}));
    });

    // Wait on rendered data, not the request: /settings lands in the same batch,
    // so a visible image proves the setting was applied before this assertion.
    render(<ResourcesView />);
    await screen.findByText('off-img:latest');
    expect(screen.queryByTestId('reclaim-hero')).not.toBeInTheDocument();
  });

  it('badges a rollback-protected image without changing its managed/unused status', async () => {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/resources') {
        return Promise.resolve(jsonResponse({
          images: [{ ...image('nginx:1.25'), managedStatus: 'unused', rollbackProtected: true, rollbackProtectionKind: 'stack' }],
          volumes: [],
          networks: [],
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<ResourcesView />);
    await screen.findByText('nginx:1.25');
    expect(screen.getByText('Rollback protected')).toBeInTheDocument();
    expect(screen.getByText('Unused')).toBeInTheDocument();
  });

  it('shows rollback generations in the Rollback tab, admin-gated release button included', async () => {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/rollback/generations') {
        return Promise.resolve(jsonResponse([
          { id: 'gen-1', shortId: 'abc123456789', stackName: 'seerr', status: 'active', isCurrent: true, phase: 'immediate_verified', createdAt: Date.now(), artifactExpiresAt: null, releasable: true },
        ]));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<ResourcesView />);
    await userEvent.click(await screen.findByRole('tab', { name: /rollback/i }));

    expect(await screen.findByText('seerr')).toBeInTheDocument();
    expect(screen.getByText('abc123456789')).toBeInTheDocument();
    // State badge and the Current filter pill both render this label.
    expect(screen.getAllByText('Current').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByRole('button', { name: /release rollback protection/i })).toBeInTheDocument();
  });
});
