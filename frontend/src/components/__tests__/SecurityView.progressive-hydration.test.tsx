/**
 * Security hydrates four independent regions: the overview rollup, image
 * summaries, the risk trend, and exploit intel. These lock the loading
 * ownership: a slow or failed image-summary inventory never holds the overview,
 * each degraded read stays local to its region, and a late response from a node
 * the operator left never lands under the new one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));

const nodesState: { activeNode: { id: number; name: string; type: string } } = {
  activeNode: { id: 1, name: 'local', type: 'local' },
};
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({
    activeNode: nodesState.activeNode,
    hasCapability: () => true,
    activeNodeMeta: { version: '0.98.0', capabilities: [] },
  }),
}));
vi.mock('@/hooks/useImageScan', () => ({ useImageScan: () => ({ scanningRef: null, scanImage: vi.fn() }) }));
vi.mock('@/context/DeployFeedbackContext', () => ({ useDeployFeedback: () => ({ runWithLog: vi.fn() }) }));
vi.mock('@/hooks/useNodeDismissals', () => ({
  useNodeDismissals: () => ({ dismissals: [], dismiss: vi.fn(), restore: vi.fn(), isPending: () => false }),
}));
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => false }));

vi.mock('@/components/security/OverviewTab', () => ({
  OverviewTab: ({
    overview,
    trendState,
    exploitIntelState,
  }: {
    overview: { scannedImages: number } | null;
    trendState: string;
    exploitIntelState: string;
  }) => (
    <div>
      <div data-testid="overview-state">{overview ? 'ready' : 'loading'}</div>
      <div data-testid="trend-state">{trendState}</div>
      <div data-testid="intel-state">{exploitIntelState}</div>
    </div>
  ),
}));
vi.mock('@/components/security/ImagesTab', () => ({
  ImagesTab: ({
    summaries,
    loading,
    error,
  }: {
    summaries: Record<string, unknown>;
    loading: boolean;
    error: boolean;
  }) => (
    <div>
      <div data-testid="images-state">{loading ? 'loading' : error ? 'error' : 'ready'}</div>
      <div data-testid="summary-count">{Object.keys(summaries).length}</div>
    </div>
  ),
}));
vi.mock('@/components/security/FindingsTab', () => ({ FindingsTab: () => null }));
vi.mock('@/components/security/ScanPolicyManager', () => ({ ScanPolicyManager: () => null }));
vi.mock('@/components/security/ScannerSetupTab', () => ({ ScannerSetupTab: () => null }));
vi.mock('@/components/security/HistoryTab', () => ({ HistoryTab: () => null }));
vi.mock('@/components/VulnerabilityScanSheet', () => ({ VulnerabilityScanSheet: () => null }));
vi.mock('@/components/settings/SuppressionsPanel', () => ({ SuppressionsPanel: () => null }));
vi.mock('@/components/settings/MisconfigAckPanel', () => ({ MisconfigAckPanel: () => null }));

import { apiFetch } from '@/lib/api';
import { SecurityView } from '../SecurityView';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

function overviewBody() {
  return {
    scannedImages: 1,
    critical: 0,
    high: 0,
    fixable: 0,
    secrets: 0,
    misconfigs: 0,
    staleScans: 0,
    failedScans: 0,
    lastSuccessfulScanAt: Date.now(),
    scanner: { available: true, version: '0.50.0', source: 'managed', autoUpdate: true },
    deployEnforcement: { honorSuppressionsOnDeploy: true, eligibleBlockPolicies: 0 },
    posture: 'Secure',
    postureReasons: [],
    primaryAction: null,
  };
}

function summary(imageRef: string) {
  return { image_ref: imageRef, scan_id: 1, critical: 0, high: 0, medium: 0, low: 0 };
}

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function jsonOk(body: unknown) {
  return Promise.resolve(response(body));
}

function jsonFail(status = 500) {
  return Promise.resolve({ ok: false, status, json: async () => ({ error: 'boom' }) } as unknown as Response);
}

beforeEach(() => {
  mockedFetch.mockReset();
  nodesState.activeNode = { id: 1, name: 'local', type: 'local' };
});

describe('SecurityView progressive hydration', () => {
  it('renders the overview while the image summaries and charts are still pending', async () => {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/security/overview') return jsonOk(overviewBody());
      if (url === '/fleet/role') return jsonOk({ role: 'control' });
      // Image summaries, trend, and exploit intel stay in flight.
      return new Promise<Response>(() => {});
    });

    render(<SecurityView activeTab="overview" onTabChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('overview-state')).toHaveTextContent('ready'));
    expect(screen.getByTestId('trend-state')).toHaveTextContent('loading');
    expect(screen.getByTestId('intel-state')).toHaveTextContent('loading');
  });

  it('keeps an image-summary failure inside the Images tab', async () => {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/security/overview') return jsonOk(overviewBody());
      if (url === '/security/image-summaries') return jsonFail(500);
      if (url === '/fleet/role') return jsonOk({ role: 'control' });
      return jsonOk([]);
    });

    render(<SecurityView activeTab="images" onTabChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('images-state')).toHaveTextContent('error'));
    expect(screen.getByTestId('summary-count')).toHaveTextContent('0');
  });

  it('treats a malformed summaries body as an error, never as no findings', async () => {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/security/overview') return jsonOk(overviewBody());
      if (url === '/security/image-summaries') return jsonOk({ not: 'a summary map' });
      if (url === '/fleet/role') return jsonOk({ role: 'control' });
      return jsonOk([]);
    });

    render(<SecurityView activeTab="images" onTabChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('images-state')).toHaveTextContent('error'));
  });

  it('marks a failed trend and exploit-intel read as unavailable, not as no history', async () => {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/security/overview') return jsonOk(overviewBody());
      if (url === '/security/image-summaries') return jsonOk({});
      if (url === '/security/overview/trend' || url === '/security/overview/exploit-intel') return jsonFail(500);
      if (url === '/fleet/role') return jsonOk({ role: 'control' });
      return jsonOk([]);
    });

    render(<SecurityView activeTab="overview" onTabChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('trend-state')).toHaveTextContent('unavailable'));
    expect(screen.getByTestId('intel-state')).toHaveTextContent('unavailable');
    expect(screen.getByTestId('overview-state')).toHaveTextContent('ready');
  });

  it('drops a late image-summary response from the node the operator left', async () => {
    const summaryResolvers: Array<(r: Response) => void> = [];
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/security/overview') return jsonOk(overviewBody());
      if (url === '/security/image-summaries') {
        return new Promise<Response>((resolve) => summaryResolvers.push(resolve));
      }
      if (url === '/fleet/role') return jsonOk({ role: 'control' });
      return jsonOk([]);
    });

    const { rerender } = render(<SecurityView activeTab="images" onTabChange={vi.fn()} />);
    await waitFor(() => expect(summaryResolvers).toHaveLength(1));

    nodesState.activeNode = { id: 2, name: 'edge', type: 'remote' };
    rerender(<SecurityView activeTab="images" onTabChange={vi.fn()} />);
    await waitFor(() => expect(summaryResolvers).toHaveLength(2));

    const body = (...refs: string[]) => response(Object.fromEntries(refs.map((ref) => [ref, summary(ref)])));
    summaryResolvers[1](body('node-2:a', 'node-2:b'));
    await waitFor(() => expect(screen.getByTestId('summary-count')).toHaveTextContent('2'));

    // Node 1 answers late; its summaries must not be written under node 2.
    summaryResolvers[0](body('ghost:a', 'ghost:b', 'ghost:c'));
    await waitFor(() => expect(screen.getByTestId('summary-count')).toHaveTextContent('2'));
  });

  it('keeps the loaded summaries visible while a refresh is in flight', async () => {
    let releaseSummaryRefresh: ((r: Response) => void) | undefined;
    let summaryCalls = 0;
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/security/overview') return jsonOk(overviewBody());
      if (url === '/security/image-summaries') {
        summaryCalls += 1;
        if (summaryCalls === 1) return jsonOk({ 'app:a': summary('app:a') });
        return new Promise<Response>((resolve) => { releaseSummaryRefresh = resolve; });
      }
      if (url === '/fleet/role') return jsonOk({ role: 'control' });
      return jsonOk([]);
    });

    const { rerender } = render(<SecurityView activeTab="images" onTabChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('summary-count')).toHaveTextContent('1'));

    // A node-identity change on the same node is a refresh, not a different scope.
    nodesState.activeNode = { id: 1, name: 'local', type: 'local' };
    rerender(<SecurityView activeTab="images" onTabChange={vi.fn()} />);

    expect(screen.getByTestId('summary-count')).toHaveTextContent('1');
    expect(screen.getByTestId('images-state')).toHaveTextContent('ready');

    releaseSummaryRefresh?.(response({ 'app:a': summary('app:a'), 'app:b': summary('app:b') }));
  });
});
