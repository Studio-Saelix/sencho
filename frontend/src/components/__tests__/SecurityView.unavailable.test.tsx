/**
 * A Security page must name the cause the gateway established about the node.
 * The overview read and the image-summaries read each carry their own cause, so
 * a disconnected Pilot or an unconfigured target is never reported as a bare
 * 503 or as a generic "failed to load".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

const nodeState: { activeNode: { id: number; name: string; type: string } } = {
  activeNode: { id: 2, name: 'edge-2', type: 'remote' },
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
  OverviewTab: ({ loadError }: { loadError?: string | null }) => (
    <div data-testid="overview-load-error">{loadError ?? 'none'}</div>
  ),
}));
vi.mock('@/components/security/ImagesTab', () => ({
  ImagesTab: ({ errorReason }: { errorReason?: string | null }) => (
    <div data-testid="images-error-reason">{errorReason ?? 'none'}</div>
  ),
}));
vi.mock('@/components/security/FindingsTab', () => ({
  FindingsTab: ({ errorReason }: { errorReason?: string | null }) => (
    <div data-testid="findings-error-reason">{errorReason ?? 'none'}</div>
  ),
}));
vi.mock('@/components/security/ScanPolicyManager', () => ({ ScanPolicyManager: () => null }));
vi.mock('@/components/security/ScannerSetupTab', () => ({ ScannerSetupTab: () => null }));
vi.mock('@/components/security/HistoryTab', () => ({ HistoryTab: () => null }));
vi.mock('@/components/VulnerabilityScanSheet', () => ({ VulnerabilityScanSheet: () => null }));
vi.mock('@/components/settings/SuppressionsPanel', () => ({ SuppressionsPanel: () => null }));
vi.mock('@/components/settings/MisconfigAckPanel', () => ({ MisconfigAckPanel: () => null }));

import { SecurityView } from '../SecurityView';

function markedFailure(failure: string, status = 503): Response {
  return {
    ok: false,
    status,
    headers: new Headers({ 'x-sencho-read-failure': failure }),
    json: async () => ({ error: failure }),
  } as unknown as Response;
}

function jsonOk(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Response;
}

function mockReads(overview: Response, summaries: Response) {
  apiFetchMock.mockImplementation((url: string) => {
    if (url === '/security/overview') return Promise.resolve(overview);
    if (url === '/security/image-summaries') return Promise.resolve(summaries);
    return Promise.resolve(jsonOk([]));
  });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  nodeState.activeNode = { id: 2, name: 'edge-2', type: 'remote' };
});

describe('SecurityView named read failures', () => {
  it('names a disconnected Pilot on the overview', async () => {
    mockReads(
      markedFailure('pilot-disconnected'),
      markedFailure('pilot-disconnected'),
    );

    render(<SecurityView activeTab="overview" onTabChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('overview-load-error').textContent).toBe('pilot-disconnected'));
  });

  it('names a disconnected Pilot on the scan-result tabs', async () => {
    mockReads(markedFailure('pilot-disconnected'), markedFailure('pilot-disconnected'));

    const { unmount } = render(<SecurityView activeTab="images" onTabChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('images-error-reason').textContent).toMatch(/Pilot tunnel to "edge-2" is disconnected/i));
    unmount();

    render(<SecurityView activeTab="compose" onTabChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('findings-error-reason').textContent).toMatch(/Pilot tunnel to "edge-2" is disconnected/i));
  });

  it('keeps a plain server error generic rather than naming a cause it does not have', async () => {
    mockReads(
      { ok: false, status: 500, headers: new Headers(), json: async () => ({ error: 'boom' }) } as unknown as Response,
      jsonOk({}),
    );

    render(<SecurityView activeTab="overview" onTabChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('overview-load-error').textContent).toBe('failed'));
  });

  it('keeps an older node without the overview endpoint benign', async () => {
    mockReads(
      { ok: false, status: 404, headers: new Headers(), json: async () => ({ error: 'not found' }) } as unknown as Response,
      jsonOk({}),
    );

    render(<SecurityView activeTab="overview" onTabChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('overview-load-error').textContent).toBe('unsupported'));
  });
});
