/**
 * Security reads belong to the node they were started for. A node switch must
 * abort the in-flight requests and drop their late answers, so the overview of
 * the previous node can never be written under the new one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

const nodeState: { activeNode: { id: number; name: string; type: string } } = {
  activeNode: { id: 1, name: 'local', type: 'local' },
};
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ activeNode: nodeState.activeNode, hasCapability: () => true, activeNodeMeta: { version: '0.98.0', capabilities: [] } }),
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('@/hooks/useImageScan', () => ({ useImageScan: () => ({ scanningRef: null, scanImage: vi.fn() }) }));
vi.mock('@/context/DeployFeedbackContext', () => ({ useDeployFeedback: () => ({ runWithLog: vi.fn() }) }));
vi.mock('@/hooks/useNodeDismissals', () => ({
  useNodeDismissals: () => ({ dismissals: [], dismiss: vi.fn(), restore: vi.fn(), isPending: () => false }),
}));
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/components/security/OverviewTab', () => ({
  OverviewTab: ({ overview }: { overview: { scannedImages?: number } | null }) => (
    <div data-testid="overview-images">{overview?.scannedImages ?? 'none'}</div>
  ),
}));
vi.mock('@/components/security/ImagesTab', () => ({ ImagesTab: () => null }));
vi.mock('@/components/security/FindingsTab', () => ({ FindingsTab: () => null }));
vi.mock('@/components/security/ScanPolicyManager', () => ({ ScanPolicyManager: () => null }));
vi.mock('@/components/security/ScannerSetupTab', () => ({ ScannerSetupTab: () => null }));
vi.mock('@/components/security/HistoryTab', () => ({ HistoryTab: () => null }));
vi.mock('@/components/VulnerabilityScanSheet', () => ({ VulnerabilityScanSheet: () => null }));
vi.mock('@/components/settings/SuppressionsPanel', () => ({ SuppressionsPanel: () => null }));
vi.mock('@/components/settings/MisconfigAckPanel', () => ({ MisconfigAckPanel: () => null }));

import { SecurityView } from '../SecurityView';

type PendingOverview = {
  signal: AbortSignal | undefined;
  resolve: (body: { scannedImages: number }) => void;
};

function overviewBody(scannedImages: number) {
  return {
    scannedImages,
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
    updateChecksDisabled: false,
  };
}

function jsonOk(body: unknown) {
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response);
}

beforeEach(() => {
  apiFetchMock.mockReset();
  nodeState.activeNode = { id: 1, name: 'local', type: 'local' };
});

describe('SecurityView node switch', () => {
  it('aborts the previous node’s reads and ignores their late overview', async () => {
    const pending: PendingOverview[] = [];
    apiFetchMock.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/security/overview') {
        return new Promise<Response>((resolve) => {
          pending.push({
            signal: opts?.signal ?? undefined,
            resolve: (body) => resolve({
              ok: true,
              status: 200,
              headers: new Headers(),
              json: async () => overviewBody(body.scannedImages),
            } as unknown as Response),
          });
        });
      }
      if (url === '/security/image-summaries') return jsonOk({});
      if (url === '/security/overview/trend') return jsonOk([]);
      if (url === '/security/overview/exploit-intel') return jsonOk({ items: [], truncated: false });
      if (url === '/fleet/role') return jsonOk({ role: 'control' });
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);
    });

    const { rerender } = render(<SecurityView activeTab="overview" onTabChange={vi.fn()} />);
    await waitFor(() => expect(pending).toHaveLength(1));

    nodeState.activeNode = { id: 2, name: 'edge', type: 'remote' };
    rerender(<SecurityView activeTab="overview" onTabChange={vi.fn()} />);
    await waitFor(() => expect(pending).toHaveLength(2));

    expect(pending[0].signal?.aborted).toBe(true);
    expect(pending[1].signal?.aborted).toBe(false);

    pending[1].resolve({ scannedImages: 2 });
    expect(await screen.findByText('2')).toBeInTheDocument();

    // The previous node's slow answer must not replace the new node's data.
    pending[0].resolve({ scannedImages: 1 });
    await waitFor(() => expect(screen.getByTestId('overview-images')).toHaveTextContent('2'));
    expect(screen.queryByText('1')).toBeNull();
  });
});
