/**
 * Coverage for ResourcesView.
 *
 * Locks correctness fixes that manual smoke testing cannot reliably catch:
 *  - a slow resource fetch for a previously-active node must not overwrite the
 *    newly-selected node's data (node-switch generation guard).
 *  - a failed prune must surface the server error, never a false success.
 *  - Load behaviour: the tables render without waiting on the disk-usage
 *    call, a refresh after an action keeps the rows on screen, and a failed
 *    inventory load reads as an error with a Retry, never as "No images found."
 *  - The masthead answers one question (what a reclaim frees, or Tidy), and
 *    Reclaim reclaims every advertised category with a partial failure
 *    reported as a warning, never a false success.
 *  - Prune verbs open an itemized preview with a scope switch, and are
 *    admin-only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
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
const authState = { isAdmin: true };
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ isAdmin: authState.isAdmin, can: () => true }) }));

const nodesState: { activeNode: { id: number } | null } = { activeNode: { id: 1 } };
vi.mock('@/context/NodeContext', () => ({ useNodes: () => nodesState }));

const trivyState = { available: false };
vi.mock('@/hooks/useTrivyStatus', () => ({
  useTrivyStatus: () => ({
    status: { available: trivyState.available, version: null, source: 'none', autoUpdate: false, busy: false },
    updateCheck: null,
    refresh: vi.fn(),
    refreshUpdateCheck: vi.fn(),
  }),
}));

// Heavy or portal-bound children are not under test; stub them to keep the
// render tree light and deterministic.
// Exposes the rescan callback so the force/scanner arguments the view picks can be asserted.
vi.mock('../VulnerabilityScanSheet', () => ({
  VulnerabilityScanSheet: ({ onRescan }: { onRescan?: (imageRef: string) => void }) =>
    onRescan ? <button onClick={() => onRescan('old:v1')}>rescan-stub</button> : null,
}));
const scanMock = { scanImage: vi.fn(), cancelScan: vi.fn() };
vi.mock('@/hooks/useImageScan', () => ({
  useImageScan: () => ({ scanningRef: null, scanImage: scanMock.scanImage, cancelScan: scanMock.cancelScan }),
}));
const mobileState = { value: false };
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => mobileState.value }));
vi.mock('../resources/ImageDetailsSheet', () => ({ ImageDetailsSheet: () => null }));
vi.mock('../resources/VolumeBrowserSheet', () => ({ VolumeBrowserSheet: () => null }));
vi.mock('../NetworkTopologyView', () => ({ default: () => null }));
vi.mock('../CapabilityGate', () => ({ CapabilityGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../LazyBoundary', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('../NodeManager', () => ({ SENCHO_NAVIGATE_EVENT: 'sencho-navigate' }));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import ResourcesView from '../ResourcesView';
import { formatBytes } from '@/lib/utils';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Headers(),
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
  authState.isAdmin = true;
  trivyState.available = false;
  mobileState.value = false;
  scanMock.scanImage.mockReset();
  scanMock.cancelScan.mockReset();
  localStorage.clear();
});

// Reclaimable usage shape with a non-zero total so the masthead offers Reclaim.
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

  it('renders the image table while the disk-usage request is still pending', async () => {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/docker-df') return new Promise<Response>(() => {});
      if (url === '/system/resources') {
        return Promise.resolve(jsonResponse({ images: [image('fast:latest')], volumes: [], networks: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<ResourcesView />);

    expect(await screen.findByText('fast:latest')).toBeInTheDocument();
  });

  it('keeps the rows on screen while a post-prune refresh is in flight', async () => {
    let resourcesCalls = 0;
    let releaseRefresh: ((r: Response) => void) | undefined;
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/prune/plan' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse(samplePrunePlan()));
      }
      if (url === '/system/prune/system' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ success: true, reclaimedBytes: 1000, outcomes: [] }));
      }
      if (url === '/system/resources') {
        resourcesCalls += 1;
        if (resourcesCalls === 1) {
          return Promise.resolve(jsonResponse({ images: [image('keep:me')], volumes: [], networks: [] }));
        }
        return new Promise<Response>((resolve) => { releaseRefresh = resolve; });
      }
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    expect(await screen.findByText('keep:me')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Prune unused' }));
    await user.click(await screen.findByRole('button', { name: /Prune/ }));
    await waitFor(() => expect(releaseRefresh).toBeDefined());

    // The refresh is still pending: the row stays and no skeleton replaces it.
    expect(screen.getByText('keep:me')).toBeInTheDocument();
    // The prune stays busy (dialog open, confirm disabled) until that refreshed
    // payload lands, so the stale row cannot be pruned again.
    const pruneDialog = screen.getByRole('alertdialog');
    expect(within(pruneDialog).getByRole('button', { name: /Prun/ })).toBeDisabled();

    releaseRefresh!(jsonResponse({ images: [], volumes: [], networks: [] }));
    await waitFor(() => expect(screen.queryByText('keep:me')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('keeps a delete busy until the refreshed inventory drops the removed image', async () => {
    let resourcesCalls = 0;
    let releaseRefresh: ((r: Response) => void) | undefined;
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/resources') {
        resourcesCalls += 1;
        if (resourcesCalls === 1) {
          return Promise.resolve(jsonResponse({ images: [image('unused:v1')], volumes: [], networks: [] }));
        }
        return new Promise<Response>((resolve) => { releaseRefresh = resolve; });
      }
      if (url === '/system/images/delete' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ success: true }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    expect(await screen.findByText('unused:v1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Delete image unused:v1' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(releaseRefresh).toBeDefined());

    // The delete answered, but the row still names the removed image: the
    // action stays busy until the refresh replaces it, so a second click cannot
    // send the stale id and collect "Image not found".
    expect(screen.getAllByText('unused:v1').length).toBeGreaterThan(0);
    expect(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' })).toBeDisabled();

    releaseRefresh!(jsonResponse({ images: [], volumes: [], networks: [] }));
    await waitFor(() => expect(screen.queryByText('unused:v1')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('keeps a purge busy until the refreshed external list drops the purged containers', async () => {
    const orphans = {
      'legacy-app': [{ Id: 'c1', Names: ['/web'], State: 'running', Status: 'Up', Image: 'nginx' }],
    };
    let orphansCalls = 0;
    let releaseRefresh: ((r: Response) => void) | undefined;
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/orphans') {
        orphansCalls += 1;
        if (orphansCalls === 1) return Promise.resolve(jsonResponse(structuredClone(orphans)));
        return new Promise<Response>((resolve) => { releaseRefresh = resolve; });
      }
      if (url === '/system/prune/orphans') {
        return Promise.resolve(jsonResponse({ results: [{ id: 'c1', success: true }] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    await user.click(await screen.findByRole('tab', { name: /external/i }));
    await user.click(await screen.findByRole('checkbox', { name: 'Select web' }));
    await user.click(screen.getByRole('button', { name: 'Purge selected (1)' }));
    await user.click(await screen.findByRole('button', { name: 'Purge' }));
    await waitFor(() => expect(releaseRefresh).toBeDefined());

    // The purge answered, but the list still shows the container and the
    // selection still names its id: the dialog stays busy until the refreshed
    // list lands instead of allowing an immediate second purge of that id.
    expect(screen.getByText('web')).toBeInTheDocument();
    expect(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Purge' })).toBeDisabled();

    releaseRefresh!(jsonResponse({}));
    await waitFor(() => expect(screen.queryByText('web')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('keeps a reclaim busy until the refreshed inventory drops the removed items', async () => {
    let resourcesCalls = 0;
    let releaseRefresh: ((r: Response) => void) | undefined;
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/docker-df') return Promise.resolve(jsonResponse(reclaimableUsage(1000, 500)));
      if (url === '/system/resources') {
        resourcesCalls += 1;
        if (resourcesCalls === 1) {
          return Promise.resolve(jsonResponse({ images: [image('old:v1')], volumes: [], networks: [] }));
        }
        return new Promise<Response>((resolve) => { releaseRefresh = resolve; });
      }
      if (url === '/system/prune/plan' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse(reclaimPlan()));
      }
      if (url === '/system/prune/system' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ success: true, reclaimedBytes: 1500, outcomes: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    expect(await screen.findByText('old:v1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Reclaim' }));
    await user.click(await screen.findByRole('button', { name: /Reclaim/ }));
    await waitFor(() => expect(releaseRefresh).toBeDefined());

    expect(screen.getByText('old:v1')).toBeInTheDocument();
    expect(within(screen.getByRole('alertdialog')).getByRole('button', { name: /Reclaim/ })).toBeDisabled();

    releaseRefresh!(jsonResponse({ images: [], volumes: [], networks: [] }));
    await waitFor(() => expect(screen.queryByText('old:v1')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('keeps a rollback release busy until the refreshed generations drop the released one', async () => {
    let rollbackCalls = 0;
    let releaseRefresh: ((r: Response) => void) | undefined;
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/rollback/generations') {
        rollbackCalls += 1;
        if (rollbackCalls === 1) {
          return Promise.resolve(jsonResponse([{
            id: 'gen-1', shortId: 'abc123456789', stackName: 'seerr', status: 'active',
            isCurrent: true, phase: 'immediate_verified', createdAt: Date.now(), artifactExpiresAt: null, releasable: true,
          }]));
        }
        return new Promise<Response>((resolve) => { releaseRefresh = resolve; });
      }
      if (url === '/system/rollback/generations/gen-1/release' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ success: true, message: 'Rollback protection released' }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    await user.click(await screen.findByRole('tab', { name: /rollback/i }));
    expect(await screen.findByText('abc123456789')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Release rollback protection for abc123456789' }));
    await user.click(await screen.findByRole('button', { name: 'Release' }));
    await waitFor(() => expect(releaseRefresh).toBeDefined());

    // The released generation is still listed until its own refresh lands, so
    // the dialog stays busy instead of allowing a second release of that id.
    expect(screen.getByText('abc123456789')).toBeInTheDocument();
    expect(within(screen.getByRole('alertdialog')).getByRole('button', { name: /Releas/ })).toBeDisabled();

    releaseRefresh!(jsonResponse([]));
    await waitFor(() => expect(screen.queryByText('abc123456789')).not.toBeInTheDocument());
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('shows an error with Retry when the inventory fails to load, not an empty table', async () => {
    let attempt = 0;
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/resources') {
        attempt += 1;
        return Promise.resolve(attempt === 1
          ? jsonResponse({ error: 'boom' }, { ok: false, status: 500 })
          : jsonResponse({ images: [image('back:again')], volumes: [], networks: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);

    expect(await screen.findByText('Could not load images.')).toBeInTheDocument();
    expect(screen.queryByText('No images found.')).not.toBeInTheDocument();
    // A first read that fails has no rows to keep: its own Retry row reports it.
    expect(toast.error).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('back:again')).toBeInTheDocument();
  });

  it('says the disk usage is unknown, with a Retry, when it fails to load, and reloads only usage', async () => {
    let dfCalls = 0;
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/docker-df') {
        dfCalls += 1;
        return Promise.resolve(dfCalls === 1
          ? jsonResponse({ error: 'slow' }, { ok: false, status: 500 })
          : jsonResponse(reclaimableUsage(0, 0)));
      }
      if (url === '/system/resources') {
        return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);

    expect(await screen.findByText('Disk usage unknown')).toBeInTheDocument();
    const resourcesCallsBefore = mockedFetch.mock.calls.filter(([u]) => u === '/system/resources').length;

    await user.click(screen.getByRole('button', { name: 'Retry disk usage' }));
    expect(await screen.findByText('Tidy')).toBeInTheDocument();
    expect(mockedFetch.mock.calls.filter(([u]) => u === '/system/resources')).toHaveLength(resourcesCallsBefore);
  });

  it('keeps the rows and warns when a background refresh fails, without a Retry row', async () => {
    let resourcesCalls = 0;
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/prune/plan' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse(samplePrunePlan()));
      }
      if (url === '/system/prune/system' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ success: true, reclaimedBytes: 1000, outcomes: [] }));
      }
      if (url === '/system/resources') {
        resourcesCalls += 1;
        return Promise.resolve(resourcesCalls === 1
          ? jsonResponse({ images: [image('still:here')], volumes: [], networks: [] })
          : jsonResponse({ error: 'boom' }, { ok: false, status: 500 }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    expect(await screen.findByText('still:here')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Prune unused' }));
    await user.click(await screen.findByRole('button', { name: /Prune/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to refresh resources'));
    expect(screen.getByText('still:here')).toBeInTheDocument();
    expect(screen.queryByText('Could not load images.')).not.toBeInTheDocument();
  });

  it('reports one warning when several regions fail in the same refresh', async () => {
    let refreshStarted = false;
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/prune/plan' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse(samplePrunePlan()));
      }
      if (url === '/system/prune/system' && opts?.method === 'POST') {
        refreshStarted = true;
        return Promise.resolve(jsonResponse({ success: true, reclaimedBytes: 1000, outcomes: [] }));
      }
      if (url === '/system/resources') {
        return Promise.resolve(refreshStarted
          ? jsonResponse({ error: 'boom' }, { ok: false, status: 500 })
          : jsonResponse({ images: [image('still:here')], volumes: [], networks: [] }));
      }
      if (url === '/system/orphans') {
        return Promise.resolve(refreshStarted
          ? jsonResponse({ error: 'boom' }, { ok: false, status: 500 })
          : jsonResponse({ 'project': [] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    expect(await screen.findByText('still:here')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Prune unused' }));
    await user.click(await screen.findByRole('button', { name: /Prune/ }));

    // Both the inventory and the external-container refresh fail; the operator
    // gets one notice, not one per region.
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to refresh resources'));
    await waitFor(() => expect(mockedFetch.mock.calls.filter(([u]) => u === '/system/orphans').length).toBeGreaterThan(1));
    const refreshWarnings = (toast.error as ReturnType<typeof vi.fn>).mock.calls
      .filter(([message]) => message === 'Failed to refresh resources');
    expect(refreshWarnings).toHaveLength(1);
    expect(screen.getByText('still:here')).toBeInTheDocument();
  });

  it('drops the previous node usage when a node switch loads, and ignores its late usage response', async () => {
    const dfResolvers: Array<(r: Response) => void> = [];
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/docker-df') {
        return new Promise<Response>((resolve) => dfResolvers.push(resolve));
      }
      if (url === '/system/resources') {
        return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const { rerender } = render(<ResourcesView />);
    await waitFor(() => expect(dfResolvers).toHaveLength(1));

    nodesState.activeNode = { id: 2 };
    rerender(<ResourcesView />);
    await waitFor(() => expect(dfResolvers).toHaveLength(2));

    // Node 1's slow answer arrives after the switch and must not render.
    dfResolvers[0](jsonResponse(reclaimableUsage(777_000_000, 0)));
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByText('Measuring disk')).toBeInTheDocument();
    expect(screen.queryByText(/reclaimable/)).not.toBeInTheDocument();

    dfResolvers[1](jsonResponse(reclaimableUsage(5_000_000, 0)));
    expect(await screen.findByText(`${formatBytes(5_000_000)} reclaimable`)).toBeInTheDocument();
  });

  it('says the disk usage is unknown when the usage request throws, and Retry recovers', async () => {
    let dfCalls = 0;
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/docker-df') {
        dfCalls += 1;
        return dfCalls === 1 ? Promise.reject(new Error('network down')) : Promise.resolve(jsonResponse(reclaimableUsage(0, 0)));
      }
      if (url === '/system/resources') {
        return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    expect(await screen.findByText('Disk usage unknown')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry disk usage' }));
    expect(await screen.findByText('Tidy')).toBeInTheDocument();
  });

  it('recovers the half-failed page from the table Retry', async () => {
    // The inventory and disk-usage reads fail together on a silent node. The
    // Retry the operator reaches for (the table's) must restore both, not leave
    // the header on "Disk usage unknown" beside a loaded inventory.
    let resourcesCalls = 0;
    let dfCalls = 0;
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/resources') {
        resourcesCalls += 1;
        return Promise.resolve(resourcesCalls === 1
          ? jsonResponse({ error: 'down' }, { ok: false, status: 504 })
          : jsonResponse({ images: [image('back:again')], volumes: [], networks: [] }));
      }
      if (url === '/system/docker-df') {
        dfCalls += 1;
        return Promise.resolve(dfCalls === 1
          ? jsonResponse({ error: 'down' }, { ok: false, status: 504 })
          : jsonResponse(reclaimableUsage(0, 0)));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);

    expect(await screen.findByText('Disk usage unknown')).toBeInTheDocument();
    expect(await screen.findByText('Could not load images.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('back:again')).toBeInTheDocument();
    expect(await screen.findByText('Tidy')).toBeInTheDocument();
    expect(dfCalls).toBe(2);
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
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith('/system/resources', expect.objectContaining({ signal: expect.anything() })));

    await user.click(screen.getByRole('button', { name: 'Prune unused' }));
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

  it('discloses extra repository tags in the prune confirm list', async () => {
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/prune/plan' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse(samplePrunePlan({
          items: [{
            target: 'images',
            id: 'img-multi',
            name: 'ghcr.io/example/very-long-app-name:1.5.2-build.1844',
            sizeBytes: 1000,
            managed: false,
            reason: 'Image is not used by any container',
            image: {
              references: [
                'ghcr.io/example/very-long-app-name:1.5.2-build.1844',
                'ghcr.io/example/very-long-app-name:latest',
              ],
            },
          }],
        })));
      }
      if (url === '/system/resources') {
        return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith('/system/resources', expect.objectContaining({ signal: expect.anything() })));
    await user.click(screen.getByRole('button', { name: 'Prune unused' }));

    const extraRef = await screen.findByText('ghcr.io/example/very-long-app-name:latest');
    expect(extraRef).toHaveClass('break-all');
    expect(extraRef).not.toHaveClass('truncate');
    expect(screen.getByText(/1\.5\.2-build\.1844/)).toBeInTheDocument();
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
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith('/system/resources', expect.objectContaining({ signal: expect.anything() })));

    await user.click(screen.getByRole('button', { name: 'Prune unused' }));
    await waitFor(() => expect(screen.getByText(/old:v1/)).toBeInTheDocument());
    await user.click(await screen.findByRole('button', { name: /Prune/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Prune blew up'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('reports a total request failure from Reclaim without a false success', async () => {
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/prune/plan' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse(reclaimPlan()));
      }
      if (url === '/system/prune/system' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ error: 'volume prune failed' }, { ok: false, status: 500 }));
      }
      if (url === '/system/docker-df') return Promise.resolve(jsonResponse(reclaimableUsage(1000, 500)));
      if (url === '/system/resources') return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);

    await user.click(await screen.findByRole('button', { name: 'Reclaim' }));
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
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    await user.click(await screen.findByRole('button', { name: 'Reclaim' }));
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
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    await user.click(await screen.findByRole('button', { name: 'Reclaim' }));
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
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    await user.click(await screen.findByRole('button', { name: 'Reclaim' }));
    await waitFor(() => expect(screen.getByText(/2 items/)).toBeInTheDocument());
    await user.click(await screen.findByRole('button', { name: /^Reclaim/ }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const msg = (toast.success as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(msg).toMatch(/Freed/);
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

  describe('masthead and prune verbs', () => {
    function mockNode(overrides: Record<string, unknown> = {}, executeBody: object = { success: true, reclaimedBytes: 1000, outcomes: [] }) {
      mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
        if (url === '/system/docker-df') return Promise.resolve(jsonResponse(reclaimableUsage(1000, 500)));
        if (url === '/system/resources') return Promise.resolve(jsonResponse({ images: [image('old:v1')], volumes: [], networks: [] }));
        if (url === '/system/prune/plan' && opts?.method === 'POST') {
          const body = JSON.parse(String(opts.body));
          const items = body.target === 'networks'
            ? [{ target: 'networks', id: 'n1', name: 'old_net', managed: true, reason: 'Network has no attached containers', network: {} }]
            : body.target === 'containers'
              ? [{ target: 'containers', id: 'c1', name: 'old_ctr', managed: true, reason: 'Container is exited and no longer running' }]
              : undefined;
          return Promise.resolve(jsonResponse(samplePrunePlan({
            scope: body.scope,
            targets: body.targets ?? [body.target],
            fingerprint: `fp-${body.scope}-${body.target ?? 'multi'}`,
            ...(items ? { items, reclaimableBytes: 0 } : {}),
          })));
        }
        if (url === '/system/prune/system' && opts?.method === 'POST') {
          return Promise.resolve(jsonResponse(executeBody));
        }
        if (overrides[url]) return Promise.resolve(jsonResponse(overrides[url]));
        return Promise.resolve(jsonResponse({}));
      });
    }

    function planBodies() {
      return mockedFetch.mock.calls
        .filter(([u, o]) => u === '/system/prune/plan' && (o as RequestInit)?.method === 'POST')
        .map(([, o]) => JSON.parse(String((o as RequestInit).body)));
    }

    it('answers with what a reclaim frees, and says Tidy when nothing is reclaimable', async () => {
      mockNode();
      const { unmount } = render(<ResourcesView />);
      expect(await screen.findByText(`${formatBytes(1500)} reclaimable`)).toBeInTheDocument();
      expect(screen.getByText('1 unused image · 1 dangling volume')).toBeInTheDocument();
      unmount();

      mockedFetch.mockImplementation((url: string) => {
        if (url === '/system/docker-df') return Promise.resolve(jsonResponse(reclaimableUsage(0, 0)));
        if (url === '/system/resources') return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
        return Promise.resolve(jsonResponse({}));
      });
      render(<ResourcesView />);
      expect(await screen.findByText('Tidy')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reclaim' })).not.toBeInTheDocument();
    });

    it('opens the prune preview at the managed scope and re-plans when the scope switches to all Docker', async () => {
      mockNode();
      const user = userEvent.setup();
      render(<ResourcesView />);
      await screen.findByText('old:v1');

      await user.click(screen.getByRole('button', { name: 'Prune unused' }));
      await waitFor(() => expect(planBodies()).toEqual([{ target: 'images', scope: 'managed' }]));

      await user.click(await screen.findByRole('radio', { name: 'All Docker' }));
      await waitFor(() => expect(planBodies()).toEqual([
        { target: 'images', scope: 'managed' },
        { target: 'images', scope: 'all' },
      ]));

      await user.click(await screen.findByRole('button', { name: /^Prune/ }));
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      const execute = mockedFetch.mock.calls.find(([u, o]) => u === '/system/prune/system' && (o as RequestInit)?.method === 'POST');
      const body = JSON.parse(String((execute![1] as RequestInit).body));
      expect(body).toMatchObject({ target: 'images', scope: 'all', planFingerprint: 'fp-all-images' });
    });

    it('does not re-plan when the already-active scope is clicked again', async () => {
      mockNode();
      const user = userEvent.setup();
      render(<ResourcesView />);
      await screen.findByText('old:v1');

      await user.click(screen.getByRole('button', { name: 'Prune unused' }));
      await waitFor(() => expect(planBodies()).toHaveLength(1));
      await user.click(await screen.findByRole('radio', { name: 'Sencho-managed' }));
      await user.click(screen.getByRole('radio', { name: 'Sencho-managed' }));

      expect(planBodies()).toHaveLength(1);
      expect(await screen.findByRole('button', { name: /^Prune/ })).toBeEnabled();
    });

    it('offers networks in the overflow and opens their preview at the managed scope', async () => {
      mockNode();
      const user = userEvent.setup();
      render(<ResourcesView />);
      await screen.findByText('old:v1');

      await user.click(screen.getByRole('button', { name: 'More cleanup actions' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Prune unused networks' }));
      await waitFor(() => expect(planBodies()).toEqual([{ target: 'networks', scope: 'managed' }]));
      expect((await screen.findAllByText('Prune Sencho-managed networks')).length).toBeGreaterThan(0);
      expect(await screen.findByText(/old_net/)).toBeInTheDocument();
    });

    it('opens the volumes preview from the Volumes tab', async () => {
      mockNode();
      const user = userEvent.setup();
      render(<ResourcesView />);
      await user.click(await screen.findByRole('tab', { name: /volumes/i }));
      await user.click(await screen.findByRole('button', { name: 'Prune unused' }));
      await waitFor(() => expect(planBodies()).toEqual([{ target: 'volumes', scope: 'managed' }]));
    });

    it('offers stopped containers in the overflow and opens their preview at the managed scope', async () => {
      mockNode();
      const user = userEvent.setup();
      render(<ResourcesView />);
      await screen.findByText('old:v1');

      await user.click(screen.getByRole('button', { name: 'More cleanup actions' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Prune stopped containers' }));
      await waitFor(() => expect(planBodies()).toEqual([{ target: 'containers', scope: 'managed' }]));
      expect((await screen.findAllByText('Prune Sencho-managed containers')).length).toBeGreaterThan(0);
      expect(await screen.findByText(/old_ctr/)).toBeInTheDocument();
    });

    it('requests the whole-node plan for Reclaim and sends that plan to the executor', async () => {
      mockNode();
      const user = userEvent.setup();
      render(<ResourcesView />);
      await user.click(await screen.findByRole('button', { name: 'Reclaim' }));
      await waitFor(() => expect(planBodies()).toEqual([{ targets: ['volumes', 'containers', 'images'], scope: 'all' }]));

      await user.click(await screen.findByRole('button', { name: /^Reclaim/ }));
      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      const execute = mockedFetch.mock.calls.find(([u, o]) => u === '/system/prune/system' && (o as RequestInit)?.method === 'POST');
      expect(JSON.parse(String((execute![1] as RequestInit).body))).toMatchObject({
        targets: ['volumes', 'containers', 'images'],
        scope: 'all',
        planFingerprint: 'fp-all-multi',
      });
    });

    it('warns, without a success toast, when Reclaim removes some items and fails others', async () => {
      mockNode({}, {
        success: true,
        reclaimedBytes: 500,
        outcomes: [
          { id: 'v1', target: 'volumes', status: 'failed', error: 'volume busy' },
          { id: 'img1', target: 'images', status: 'removed' },
        ],
      });
      const user = userEvent.setup();
      render(<ResourcesView />);
      await user.click(await screen.findByRole('button', { name: 'Reclaim' }));
      await user.click(await screen.findByRole('button', { name: /^Reclaim/ }));

      await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('Some items could not be pruned.')));
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    });

    it('reports an error when Reclaim fails every item even though the request succeeded', async () => {
      mockNode({}, { success: true, reclaimedBytes: 0, outcomes: [{ id: 'img1', target: 'images', status: 'failed', error: 'in use' }] });
      const user = userEvent.setup();
      render(<ResourcesView />);
      await user.click(await screen.findByRole('button', { name: 'Reclaim' }));
      await user.click(await screen.findByRole('button', { name: /^Reclaim/ }));

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to reclaim disk space.'));
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.warning).not.toHaveBeenCalled();
    });

    it('scans with the right scanners and force flag from the row menu and from the rescan action', async () => {
      trivyState.available = true;
      mockNode();
      const user = userEvent.setup();
      render(<ResourcesView />);
      await screen.findByText('old:v1');

      await user.click(screen.getByRole('button', { name: 'Scan old:v1' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Scan (vulnerabilities)' }));
      expect(scanMock.scanImage).toHaveBeenLastCalledWith('old:v1', ['vuln'], { force: false });

      await user.click(screen.getByRole('button', { name: 'Scan old:v1' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Full scan (vulnerabilities + secrets)' }));
      expect(scanMock.scanImage).toHaveBeenLastCalledWith('old:v1', ['vuln', 'secret'], { force: false });

      await user.click(screen.getByRole('button', { name: 'rescan-stub' }));
      expect(scanMock.scanImage).toHaveBeenLastCalledWith('old:v1', undefined, { force: true });
    });

    it('stops following an in-flight scan when the node switches, not on a plain re-render', async () => {
      mockNode();
      const { rerender, unmount } = render(<ResourcesView />);
      await screen.findByText('old:v1');
      expect(scanMock.cancelScan).not.toHaveBeenCalled();

      rerender(<ResourcesView />);
      expect(scanMock.cancelScan).not.toHaveBeenCalled();

      nodesState.activeNode = { id: 2 };
      rerender(<ResourcesView />);
      expect(scanMock.cancelScan).toHaveBeenCalledTimes(1);

      unmount();
      expect(scanMock.cancelScan).toHaveBeenCalledTimes(2);
    });

    it('keeps Reclaim and the cleanup menu reachable on a phone, behind the same admin gate', async () => {
      mobileState.value = true;
      mockNode();
      const { unmount } = render(<ResourcesView />);
      expect(await screen.findByText(`${formatBytes(1500)} reclaimable`)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Reclaim' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'More cleanup actions' })).toBeInTheDocument();
      unmount();

      authState.isAdmin = false;
      render(<ResourcesView />);
      expect(await screen.findByText(`${formatBytes(1500)} reclaimable`)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Reclaim' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'More cleanup actions' })).not.toBeInTheDocument();
    });

    it('hides every prune verb from a non-admin and keeps the masthead and the usage Retry', async () => {
      authState.isAdmin = false;
      mockNode();
      render(<ResourcesView />);
      expect(await screen.findByText(`${formatBytes(1500)} reclaimable`)).toBeInTheDocument();
      await screen.findByText('old:v1');

      expect(screen.queryByRole('button', { name: 'Reclaim' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'More cleanup actions' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Prune unused' })).not.toBeInTheDocument();
    });

    it('does not request /settings', async () => {
      mockNode();
      render(<ResourcesView />);
      await screen.findByText('old:v1');
      expect(mockedFetch.mock.calls.some(([u]) => u === '/settings')).toBe(false);
    });

    it('opens the Rollback tab from a stack-held image badge, and leaves a service-held badge static', async () => {
      mockNode({});
      mockedFetch.mockImplementation((url: string) => {
        if (url === '/system/resources') {
          return Promise.resolve(jsonResponse({
            images: [
              { ...image('held:stack'), managedStatus: 'unused', rollbackProtected: true, rollbackProtectionKind: 'stack' },
              { ...image('held:service'), managedStatus: 'unused', rollbackProtected: true, rollbackProtectionKind: 'service' },
            ],
            volumes: [],
            networks: [],
          }));
        }
        if (url === '/system/rollback/generations') {
          return Promise.resolve(jsonResponse([
            { id: 'gen-1', shortId: 'abc123456789', stackName: 'seerr', status: 'active', isCurrent: true, phase: 'immediate_verified', createdAt: Date.now(), artifactExpiresAt: null, releasable: true },
          ]));
        }
        return Promise.resolve(jsonResponse({}));
      });

      const user = userEvent.setup();
      render(<ResourcesView />);
      await screen.findByText('held:stack');
      expect(screen.getAllByText('Rollback protected')).toHaveLength(2);
      expect(screen.getAllByRole('button', { name: /rollback protected/i })).toHaveLength(1);

      await user.click(screen.getByRole('button', { name: /rollback protected/i }));
      expect(await screen.findByText('abc123456789')).toBeInTheDocument();
    });

    it('lists unmanaged containers under an External tab and selects them with checkboxes', async () => {
      mockNode({
        '/system/orphans': { 'legacy-app': [{ Id: 'c1', Names: ['/web'], State: 'running', Status: 'Up', Image: 'nginx' }] },
      });
      const user = userEvent.setup();
      render(<ResourcesView />);
      await user.click(await screen.findByRole('tab', { name: /external/i }));

      expect(await screen.findByText('legacy-app')).toBeInTheDocument();
      await user.click(screen.getByRole('checkbox', { name: 'Select web' }));
      expect(screen.getByRole('button', { name: 'Purge selected (1)' })).toBeEnabled();
    });

    it('clears the external-container selection when a refresh re-lists the same ids', async () => {
      // The prune refreshes every region, and the external-container read that
      // comes back lists the same container. Only the payload identity tells
      // the page the selection was made against a read it no longer owns.
      const orphans = {
        'legacy-app': [{ Id: 'c1', Names: ['/web'], State: 'running', Status: 'Up', Image: 'nginx' }],
      };
      // Every read hands back a fresh body, as a real response does, so the
      // refresh is a new payload even though it lists the same container.
      mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
        if (url === '/system/orphans') return Promise.resolve(jsonResponse(structuredClone(orphans)));
        if (url === '/system/docker-df') return Promise.resolve(jsonResponse(reclaimableUsage(1000, 500)));
        if (url === '/system/resources') return Promise.resolve(jsonResponse({ images: [image('old:v1')], volumes: [], networks: [] }));
        if (url === '/system/prune/plan' && opts?.method === 'POST') {
          return Promise.resolve(jsonResponse(samplePrunePlan({
            scope: 'managed',
            targets: ['networks'],
            items: [{ target: 'networks', id: 'n1', name: 'old_net', managed: true, reason: 'Network has no attached containers', network: {} }],
            reclaimableBytes: 0,
          })));
        }
        if (url === '/system/prune/system' && opts?.method === 'POST') {
          return Promise.resolve(jsonResponse({ success: true, reclaimedBytes: 0, outcomes: [] }));
        }
        return Promise.resolve(jsonResponse({}));
      });

      const user = userEvent.setup();
      render(<ResourcesView />);
      await user.click(await screen.findByRole('tab', { name: /external/i }));
      await user.click(await screen.findByRole('checkbox', { name: 'Select web' }));
      expect(screen.getByRole('button', { name: 'Purge selected (1)' })).toBeEnabled();

      await user.click(screen.getByRole('button', { name: 'More cleanup actions' }));
      await user.click(await screen.findByRole('menuitem', { name: 'Prune unused networks' }));
      await user.click(await screen.findByRole('button', { name: 'Prune' }));
      await waitFor(() => expect(toast.success).toHaveBeenCalled());

      // Waits for the refreshed read to land: until it does the old payload is
      // still the one on screen, and with it the old selection.
      await waitFor(() => {
        expect(screen.getByRole('checkbox', { name: 'Select web' })).not.toBeChecked();
        expect(screen.getByRole('button', { name: 'Purge selected (0)' })).toBeDisabled();
      });
      expect(mockedFetch.mock.calls.filter(([url]) => url === '/system/orphans').length).toBeGreaterThan(1);

      // A deliberate selection on the refreshed list is what the purge carries.
      await user.click(screen.getByRole('checkbox', { name: 'Select web' }));
      await user.click(screen.getByRole('button', { name: 'Purge selected (1)' }));
      await user.click(await screen.findByRole('button', { name: 'Purge' }));
      await waitFor(() => {
        const purgeCall = mockedFetch.mock.calls.find(([url]) => url === '/system/prune/orphans');
        expect(purgeCall).toBeDefined();
        expect(JSON.parse(String((purgeCall?.[1] as RequestInit).body))).toEqual({ containerIds: ['c1'] });
      });
    });

    it('clears the external-container selection when the node changes', async () => {
      const orphans = {
        'legacy-app': [{ Id: 'c1', Names: ['/web'], State: 'running', Status: 'Up', Image: 'nginx' }],
      };
      mockedFetch.mockImplementation((url: string) => {
        if (url === '/system/orphans') return Promise.resolve(jsonResponse(structuredClone(orphans)));
        if (url === '/system/resources') return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
        return Promise.resolve(jsonResponse({}));
      });

      const user = userEvent.setup();
      const { rerender } = render(<ResourcesView />);
      await user.click(await screen.findByRole('tab', { name: /external/i }));
      await user.click(await screen.findByRole('checkbox', { name: 'Select web' }));
      expect(screen.getByRole('button', { name: 'Purge selected (1)' })).toBeEnabled();

      nodesState.activeNode = { id: 2 };
      rerender(<ResourcesView />);

      // The new node's read lists the same container id; the selection was
      // made on the previous node's list and must not follow it.
      expect(await screen.findByRole('checkbox', { name: 'Select web' })).not.toBeChecked();
      expect(screen.getByRole('button', { name: 'Purge selected (0)' })).toBeDisabled();
    });

    describe('purging external containers', () => {
      const orphans = {
        'legacy-app': [
          { Id: 'c1', Names: ['/web'], State: 'running', Status: 'Up', Image: 'nginx' },
          { Id: 'c2', Names: ['/socket-proxy'], State: 'running', Status: 'Up', Image: 'proxy' },
        ],
      };

      async function purgeBoth(results: Array<{ id: string; success: boolean; error?: string }>) {
        mockNode({ '/system/orphans': orphans, '/system/prune/orphans': { results } });
        const user = userEvent.setup();
        render(<ResourcesView />);
        await user.click(await screen.findByRole('tab', { name: /external/i }));
        await user.click(await screen.findByRole('checkbox', { name: 'Select all external containers' }));
        await user.click(screen.getByRole('button', { name: 'Purge selected (2)' }));
        await user.click(await screen.findByRole('button', { name: 'Purge' }));
      }

      it('reports success when every container was removed', async () => {
        await purgeBoth([{ id: 'c1', success: true }, { id: 'c2', success: true }]);

        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Purged 2 external container(s)'));
        expect(toast.warning).not.toHaveBeenCalled();
        expect(toast.error).not.toHaveBeenCalled();
      });

      it('warns, naming the reason, when the server refused some of them', async () => {
        await purgeBoth([{ id: 'c1', success: true }, { id: 'c2', success: false, error: 'Service "socket-proxy" carries the Docker connection.' }]);

        await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
          'Purged 1 of 2 external containers. Service "socket-proxy" carries the Docker connection.',
        ));
        expect(toast.success).not.toHaveBeenCalled();
      });

      it('does not claim success when the server answered without per-container results', async () => {
        mockNode({ '/system/orphans': orphans, '/system/prune/orphans': {} });
        const user = userEvent.setup();
        render(<ResourcesView />);
        await user.click(await screen.findByRole('tab', { name: /external/i }));
        await user.click(await screen.findByRole('checkbox', { name: 'Select all external containers' }));
        await user.click(screen.getByRole('button', { name: 'Purge selected (2)' }));
        await user.click(await screen.findByRole('button', { name: 'Purge' }));

        await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('The purge finished but its result could not be read. Check the list below.'));
        expect(toast.success).not.toHaveBeenCalled();
      });

      it('reports an error, not a success, when none could be removed', async () => {
        await purgeBoth([{ id: 'c1', success: false, error: 'Service "socket-proxy" carries the Docker connection.' }, { id: 'c2', success: false, error: 'busy' }]);

        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Service "socket-proxy" carries the Docker connection.'));
        expect(toast.success).not.toHaveBeenCalled();
      });
    });
  });

  it('does not report "No external containers" when only the external read failed', async () => {
    // A node that answers /system/resources but misses the read deadline on
    // /system/orphans has not told us it has none. The only external slice
    // failed, so that tab names the failure instead of claiming an empty host.
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/resources') {
        return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
      }
      if (url === '/system/orphans') {
        return Promise.resolve({
          ok: false,
          status: 504,
          json: async () => ({ code: 'remote_read_timeout' }),
          headers: new Headers({ 'x-sencho-read-timeout': '1' }),
        } as unknown as Response);
      }
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith(
      '/system/resources',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));

    await user.click(await screen.findByRole('tab', { name: /external/i }));
    expect(await screen.findByText('Could not load external containers.')).toBeInTheDocument();
    expect(screen.queryByText('No external containers')).toBeNull();
  });

  it('settles the external tab when the inventory batch rejects as a whole', async () => {
    // apiFetch throws on a 401, which rejects the batch before any per-slice
    // branch runs: the external tab must not keep its skeleton.
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/resources') {
        return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
      }
      if (url === '/system/orphans') return Promise.reject(new Error('Unauthorized'));
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith(
      '/system/resources',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));

    await user.click(await screen.findByRole('tab', { name: /external/i }));
    expect(await screen.findByText('Could not load external containers.')).toBeInTheDocument();
    expect(screen.queryByText('No external containers')).toBeNull();
  });

  it('recovers the external read and the disk usage from the external Retry', async () => {
    let orphansCalls = 0;
    let dfCalls = 0;
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/resources') {
        return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
      }
      if (url === '/system/orphans') {
        orphansCalls += 1;
        return Promise.resolve(orphansCalls === 1
          ? jsonResponse({ error: 'down' }, { ok: false, status: 504 })
          : jsonResponse({ 'legacy-app': [{ Id: 'c1', Names: ['/web'], State: 'running', Status: 'Up', Image: 'nginx' }] }));
      }
      if (url === '/system/docker-df') {
        dfCalls += 1;
        return Promise.resolve(dfCalls === 1
          ? jsonResponse({ error: 'down' }, { ok: false, status: 504 })
          : jsonResponse(reclaimableUsage(0, 0)));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);

    await user.click(await screen.findByRole('tab', { name: /external/i }));
    expect(await screen.findByText('Could not load external containers.')).toBeInTheDocument();
    expect(await screen.findByText('Disk usage unknown')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('web')).toBeInTheDocument();
    expect(await screen.findByText('Tidy')).toBeInTheDocument();
    expect(dfCalls).toBe(2);
  });

  it('names the external read’s own failure, not the inventory read’s', async () => {
    // /system/resources succeeds and /system/orphans times out: the external
    // tab must show the orphans cause rather than an empty inventory reason.
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/resources') {
        return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
      }
      if (url === '/system/orphans') {
        return Promise.resolve({
          ok: false,
          status: 504,
          json: async () => ({ code: 'remote_read_timeout' }),
          headers: new Headers({ 'x-sencho-read-timeout': '1' }),
        } as unknown as Response);
      }
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith(
      '/system/resources',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));

    await user.click(await screen.findByRole('tab', { name: /external/i }));
    expect(await screen.findByText('Could not load external containers.')).toBeInTheDocument();
    expect(screen.getByText(/did not answer in time/i)).toBeInTheDocument();
  });

  it('keeps the external rows and warns when a background refresh fails only on the external read', async () => {
    let orphansCalls = 0;
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/prune/plan' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse(samplePrunePlan()));
      }
      if (url === '/system/prune/system' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ success: true, reclaimedBytes: 1000, outcomes: [] }));
      }
      if (url === '/system/resources') {
        return Promise.resolve(jsonResponse({ images: [image('still:here')], volumes: [], networks: [] }));
      }
      if (url === '/system/orphans') {
        orphansCalls += 1;
        return Promise.resolve(orphansCalls === 1
          ? jsonResponse({ 'legacy-app': [{ Id: 'c1', Names: ['/web'], State: 'running', Status: 'Up', Image: 'nginx' }] })
          : jsonResponse({ error: 'boom' }, { ok: false, status: 500 }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    expect(await screen.findByText('still:here')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Prune unused' }));
    await user.click(await screen.findByRole('button', { name: /Prune/ }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to refresh resources'));
    await user.click(await screen.findByRole('tab', { name: /external/i }));
    expect(await screen.findByText('web')).toBeInTheDocument();
    expect(screen.queryByText('Could not load external containers.')).toBeNull();
  });

  it('keeps a confirmed-empty external list and warns when its background refresh fails', async () => {
    let orphansCalls = 0;
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/prune/plan' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse(samplePrunePlan()));
      }
      if (url === '/system/prune/system' && opts?.method === 'POST') {
        return Promise.resolve(jsonResponse({ success: true, reclaimedBytes: 1000, outcomes: [] }));
      }
      if (url === '/system/resources') {
        return Promise.resolve(jsonResponse({ images: [image('still:here')], volumes: [], networks: [] }));
      }
      if (url === '/system/orphans') {
        orphansCalls += 1;
        return Promise.resolve(orphansCalls === 1
          ? jsonResponse({})
          : jsonResponse({ error: 'boom' }, { ok: false, status: 500 }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    expect(await screen.findByText('still:here')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Prune unused' }));
    await user.click(await screen.findByRole('button', { name: /Prune/ }));

    // The first read confirmed an empty list, which is the last good payload: a
    // failed refresh keeps it and reports the failure once, instead of
    // replacing a confirmed answer with an error surface.
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Failed to refresh resources'));
    await user.click(await screen.findByRole('tab', { name: /external/i }));
    expect(await screen.findByText('No external containers')).toBeInTheDocument();
    expect(screen.queryByText('Could not load external containers.')).toBeNull();
  });

  it('names a disconnected Pilot on the tables and on the disk-usage card', async () => {
    const marked = {
      ok: false,
      status: 503,
      headers: new Headers({ 'x-sencho-read-failure': 'pilot-disconnected' }),
      json: async () => ({ error: 'Pilot tunnel disconnected.' }),
    } as unknown as Response;
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/resources' || url === '/system/docker-df') return Promise.resolve(marked);
      return Promise.resolve(jsonResponse({}));
    });

    render(<ResourcesView />);

    expect(await screen.findByText('Could not load images.')).toBeInTheDocument();
    expect(screen.getAllByText(/Pilot tunnel to this node is disconnected/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/503/)).toBeNull();
    expect(await screen.findByText('Disk usage unknown')).toBeInTheDocument();
    // One copy on the table, one under the masthead answer.
    expect(screen.getAllByText(/Pilot tunnel to this node is disconnected/i).length).toBeGreaterThanOrEqual(2);
  });

  it('names a silent node from the first read that answers, without waiting for the slow inventory read', async () => {
    // The full resources inventory is on the gateway's 30 second budget, but
    // the rest of the batch answers on the interactive one. A node that is not
    // answering must be named by the first of those reads, not after the slow
    // read's whole budget.
    let releaseResources: ((r: Response) => void) | undefined;
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/resources') {
        return new Promise<Response>((resolve) => { releaseResources = resolve; });
      }
      if (url === '/system/orphans') {
        return Promise.resolve({
          ok: false,
          status: 504,
          headers: new Headers({ 'x-sencho-read-timeout': '1' }),
          json: async () => ({ code: 'remote_read_timeout' }),
        } as unknown as Response);
      }
      // Disk usage is on the same slow budget; it has not answered either.
      return new Promise<Response>(() => {});
    });

    render(<ResourcesView />);

    expect(await screen.findByText('Could not load images.')).toBeInTheDocument();
    // One copy on the table, one under the disk-usage answer.
    expect(screen.getAllByText(/did not answer in time/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Disk usage unknown')).toBeInTheDocument();

    // The slow read landing is authoritative and replaces the early failure.
    releaseResources!(jsonResponse({ images: [image('slow:but-ok')], volumes: [], networks: [] }));
    expect(await screen.findByText('slow:but-ok')).toBeInTheDocument();
    expect(screen.queryByText('Could not load images.')).toBeNull();
  });

  it('settles the page from a marked cause on the scan-summaries read too', async () => {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/resources' || url === '/system/docker-df') return new Promise<Response>(() => {});
      if (url === '/security/image-summaries') {
        return Promise.resolve({
          ok: false,
          status: 503,
          headers: new Headers({ 'x-sencho-read-failure': 'pilot-disconnected' }),
          json: async () => ({ error: 'Pilot tunnel disconnected.' }),
        } as unknown as Response);
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<ResourcesView />);

    expect(await screen.findByText('Could not load images.')).toBeInTheDocument();
    expect(screen.getAllByText(/Pilot tunnel to this node is disconnected/i).length).toBeGreaterThan(0);
  });

  it('does not name the node when a sibling read fails with an ordinary error', async () => {
    // Only a failure that proves the hub has no readable path to the node may
    // fail the tables and the usage card while the slow inventory is pending.
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/system/resources' || url === '/system/docker-df') return new Promise<Response>(() => {});
      if (url === '/system/orphans') {
        return Promise.resolve(jsonResponse({ error: 'boom' }, { ok: false, status: 500 }));
      }
      return Promise.resolve(jsonResponse({}));
    });

    render(<ResourcesView />);

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledWith('/system/orphans', expect.anything()));
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText('Could not load images.')).toBeNull();
    expect(screen.queryByText('Disk usage unknown')).toBeNull();
  });

  it('retries a sibling failure without aborting the slow inventory read that is still pending', async () => {
    const resourcesSignals: AbortSignal[] = [];
    let releaseResources: ((r: Response) => void) | undefined;
    let orphansCalls = 0;
    let usageCalls = 0;
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/resources') {
        if (opts?.signal) resourcesSignals.push(opts.signal);
        return new Promise<Response>((resolve) => { releaseResources = resolve; });
      }
      if (url === '/system/docker-df') {
        usageCalls += 1;
        return new Promise<Response>(() => {});
      }
      if (url === '/system/orphans') {
        orphansCalls += 1;
        return Promise.resolve(orphansCalls === 1
          ? ({
            ok: false,
            status: 504,
            headers: new Headers({ 'x-sencho-read-timeout': '1' }),
            json: async () => ({ code: 'remote_read_timeout' }),
          } as unknown as Response)
          : jsonResponse({}));
      }
      return Promise.resolve(jsonResponse({}));
    });

    const user = userEvent.setup();
    render(<ResourcesView />);
    expect(await screen.findByText('Could not load images.')).toBeInTheDocument();

    await user.click(screen.getAllByRole('button', { name: 'Retry' })[0]);

    await waitFor(() => expect(orphansCalls).toBe(2));
    await waitFor(() => expect(usageCalls).toBe(2));
    // The pending inventory read was never restarted.
    expect(resourcesSignals).toHaveLength(1);
    expect(resourcesSignals[0].aborted).toBe(false);

    releaseResources!(jsonResponse({ images: [image('slow:but-ok')], volumes: [], networks: [] }));
    expect(await screen.findByText('slow:but-ok')).toBeInTheDocument();
  });

  it('aborts the previous node’s inventory reads on a node switch and ignores their results', async () => {
    const resourcesSignals: AbortSignal[] = [];
    const resourcesResolvers: Array<(r: Response) => void> = [];
    mockedFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/system/resources') {
        if (opts?.signal) resourcesSignals.push(opts.signal);
        return new Promise<Response>((resolve) => resourcesResolvers.push(resolve));
      }
      if (url === '/system/orphans') return Promise.resolve(jsonResponse({}));
      return Promise.resolve(jsonResponse({}));
    });

    const { rerender } = render(<ResourcesView />);
    await waitFor(() => expect(resourcesSignals).toHaveLength(1));

    nodesState.activeNode = { id: 2 };
    rerender(<ResourcesView />);
    await waitFor(() => expect(resourcesSignals).toHaveLength(2));

    expect(resourcesSignals[0].aborted).toBe(true);
    expect(resourcesSignals[1].aborted).toBe(false);

    resourcesResolvers[1](jsonResponse({ images: [image('node2-img:latest')], volumes: [], networks: [] }));
    expect(await screen.findByText('node2-img:latest')).toBeInTheDocument();

    resourcesResolvers[0](jsonResponse({ images: [image('node1-img:latest')], volumes: [], networks: [] }));
    await waitFor(() => expect(screen.getByText('node2-img:latest')).toBeInTheDocument());
    expect(screen.queryByText('node1-img:latest')).not.toBeInTheDocument();
  });

  describe('progressive hydration', () => {
    it('renders the images and their count while rollback, usage, and scan summaries are still pending', async () => {
      mockedFetch.mockImplementation((url: string) => {
        if (url === '/system/resources') {
          return Promise.resolve(jsonResponse({ images: [image('fast:latest')], volumes: [], networks: [] }));
        }
        if (url === '/system/docker-df' || url === '/system/rollback/generations' || url === '/security/image-summaries') {
          // Never settles during this test: these regions are still reading.
          return new Promise<Response>(() => {});
        }
        return Promise.resolve(jsonResponse({}));
      });

      render(<ResourcesView />);

      expect(await screen.findByText('fast:latest')).toBeInTheDocument();
      // The Images count is known; Rollback's source has not answered, so its
      // tab shows no number at all rather than an implied zero.
      expect(screen.getByRole('tab', { name: 'Images1' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Rollback' })).toBeInTheDocument();
      expect(screen.getByText('Measuring disk')).toBeInTheDocument();
    });

    it('shows rollback generations as soon as they arrive, without waiting on usage or scan summaries', async () => {
      mockedFetch.mockImplementation((url: string) => {
        if (url === '/system/rollback/generations') {
          return Promise.resolve(jsonResponse([{
            id: 'gen-1', shortId: 'abc123456789', stackName: 'seerr', status: 'active',
            isCurrent: true, phase: 'immediate_verified', createdAt: Date.now(), artifactExpiresAt: null, releasable: false,
          }]));
        }
        if (url === '/system/resources') {
          return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
        }
        if (url === '/system/docker-df' || url === '/security/image-summaries') {
          return new Promise<Response>(() => {});
        }
        return Promise.resolve(jsonResponse({}));
      });

      const user = userEvent.setup();
      render(<ResourcesView />);
      await user.click(await screen.findByRole('tab', { name: /rollback/i }));

      expect(await screen.findByText('seerr')).toBeInTheDocument();
      // The Rollback count appears with its data, not before it.
      expect(screen.getByRole('tab', { name: 'Rollback1' })).toBeInTheDocument();
    });

    it('keeps the image table usable when the scan-summary read fails', async () => {
      mockedFetch.mockImplementation((url: string) => {
        if (url === '/system/resources') {
          return Promise.resolve(jsonResponse({ images: [image('keep:latest')], volumes: [], networks: [] }));
        }
        if (url === '/security/image-summaries') {
          return Promise.resolve(jsonResponse({ error: 'boom' }, { ok: false, status: 500 }));
        }
        return Promise.resolve(jsonResponse({}));
      });

      render(<ResourcesView />);

      expect(await screen.findByText('keep:latest')).toBeInTheDocument();
      expect(screen.queryByText('Could not load images.')).not.toBeInTheDocument();
    });

    it('gives a failed external-container read its own Retry, not a confirmed-empty state', async () => {
      mockedFetch.mockImplementation((url: string) => {
        if (url === '/system/resources') {
          return Promise.resolve(jsonResponse({ images: [image('images:fine')], volumes: [], networks: [] }));
        }
        if (url === '/system/orphans') {
          return Promise.resolve(jsonResponse({ error: 'boom' }, { ok: false, status: 500 }));
        }
        return Promise.resolve(jsonResponse({}));
      });

      const user = userEvent.setup();
      render(<ResourcesView />);
      expect(await screen.findByText('images:fine')).toBeInTheDocument();

      await user.click(screen.getByRole('tab', { name: /external/i }));

      expect(await screen.findByText('Could not load external containers.')).toBeInTheDocument();
      expect(screen.queryByText('No external containers')).not.toBeInTheDocument();
    });

    it('drops a late rollback response from the node the operator left', async () => {
      const rollbackResolvers: Array<(r: Response) => void> = [];
      mockedFetch.mockImplementation((url: string) => {
        if (url === '/system/rollback/generations') {
          return new Promise<Response>((resolve) => rollbackResolvers.push(resolve));
        }
        if (url === '/system/resources') {
          return Promise.resolve(jsonResponse({ images: [], volumes: [], networks: [] }));
        }
        return Promise.resolve(jsonResponse({}));
      });

      const { rerender } = render(<ResourcesView />);
      await waitFor(() => expect(rollbackResolvers).toHaveLength(1));

      nodesState.activeNode = { id: 2 };
      rerender(<ResourcesView />);
      await waitFor(() => expect(rollbackResolvers).toHaveLength(2));

      const generation = (stackName: string) => jsonResponse([{
        id: `gen-${stackName}`, shortId: 'abc123456789', stackName, status: 'active',
        isCurrent: true, phase: 'immediate_verified', createdAt: Date.now(), artifactExpiresAt: null, releasable: false,
      }]);

      rollbackResolvers[1](generation('node-2-stack'));
      const user = userEvent.setup();
      await user.click(await screen.findByRole('tab', { name: /rollback/i }));
      expect(await screen.findByText('node-2-stack')).toBeInTheDocument();

      // Node 1's read answers after the switch; it must not appear under node 2.
      rollbackResolvers[0](generation('ghost-stack'));
      await waitFor(() => expect(screen.getByText('node-2-stack')).toBeInTheDocument());
      expect(screen.queryByText('ghost-stack')).not.toBeInTheDocument();
    });
  });
});
