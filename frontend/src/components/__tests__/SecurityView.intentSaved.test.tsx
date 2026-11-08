/**
 * Setting an exposure intent from the Images tab makes the per-service intent in
 * the posture targeting the operator arrived with stale (it is a snapshot), so
 * SecurityView sheds it, keeps the listed images and rereads the scan summaries.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({
    activeNode: { id: 1, name: 'local', type: 'local' },
    hasCapability: () => true,
    activeNodeMeta: { version: '0.98.0', capabilities: [] },
  }),
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('@/hooks/useImageScan', () => ({ useImageScan: () => ({ scanningRef: null, scanImage: vi.fn() }) }));
vi.mock('@/context/DeployFeedbackContext', () => ({ useDeployFeedback: () => ({ runWithLog: vi.fn() }) }));
vi.mock('@/hooks/useNodeDismissals', () => ({
  useNodeDismissals: () => ({ dismissals: [], dismiss: vi.fn(), restore: vi.fn(), isPending: () => false }),
}));
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/components/security/OverviewTab', () => ({
  OverviewTab: ({ onNavigate }: { onNavigate: (tab: string, filter?: undefined, targeting?: unknown) => void }) => (
    <>
      <button
        type="button"
        onClick={() => onNavigate('images', undefined, {
          kind: 'public_exposure',
          label: 'Exposure conflicts with declared intent',
          imageRefs: ['exp:1'],
          targets: [{ imageRef: 'exp:1', intentStatus: 'set' }],
        })}
      >
        go to images
      </button>
      <button
        type="button"
        onClick={() => onNavigate('images', undefined, {
          kind: 'elevated_exploit_risk',
          label: 'Elevated exploit risk',
          imageRefs: ['exp:1'],
          targets: [{ imageRef: 'exp:1', stackName: 'web', serviceName: 'api', intentStatus: 'unset' }],
        })}
      >
        go to drivers
      </button>
    </>
  ),
}));
vi.mock('@/components/security/ImagesTab', () => ({
  ImagesTab: ({ targeting, onIntentSaved }: { targeting?: { kind: string; targets: object[] } | null; onIntentSaved: (stackName: string, intents: Array<{ service: string; intent: string }>) => void }) => (
    <div>
      <span data-testid="targeting">{targeting?.kind ?? 'none'}</span>
      <span data-testid="snapshot">{JSON.stringify(targeting?.targets ?? [])}</span>
      <button type="button" onClick={() => onIntentSaved('web', [{ service: 'api', intent: 'public' }])}>intent saved</button>
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

import { SecurityView } from '../SecurityView';

function jsonOk(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response);
}

const overview = {
  scannedImages: 1, critical: 0, high: 0, fixable: 0, secrets: 0, misconfigs: 0, staleScans: 0, failedScans: 0,
  lastSuccessfulScanAt: Date.now(),
  scanner: { available: true, version: '0.50.0', source: 'managed', autoUpdate: true },
  deployEnforcement: { honorSuppressionsOnDeploy: true, eligibleBlockPolicies: 0 },
  posture: 'Secure', postureReasons: [], primaryAction: null, updateChecksDisabled: false,
};

const summaryReads = () => apiFetchMock.mock.calls.filter(([url]) => url === '/security/image-summaries').length;

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockImplementation((url: string) => {
    if (url === '/security/overview') return jsonOk(overview);
    if (url === '/security/image-summaries') return jsonOk({});
    if (url === '/security/overview/trend') return jsonOk([]);
    if (url === '/security/overview/exploit-intel') return jsonOk({ items: [], truncated: false });
    if (url === '/fleet/role') return jsonOk({ role: 'control' });
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);
  });
});

describe('SecurityView intent saved', () => {
  it('keeps the listed images, drops the snapshot and rereads the summaries', async () => {
    const { rerender } = render(<SecurityView activeTab="overview" onTabChange={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'go to images' }));
    rerender(<SecurityView activeTab="images" onTabChange={vi.fn()} />);
    expect(await screen.findByTestId('targeting')).toHaveTextContent('public_exposure');
    await waitFor(() => expect(summaryReads()).toBeGreaterThanOrEqual(1));
    const before = summaryReads();

    await userEvent.click(screen.getByRole('button', { name: 'intent saved' }));

    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('[{"imageRef":"exp:1"}]'));
    expect(screen.getByTestId('targeting')).toHaveTextContent('public_exposure');
    await waitFor(() => expect(summaryReads()).toBeGreaterThan(before));
  });

  it('keeps another reason but sheds its per-service intent snapshot', async () => {
    const { rerender } = render(<SecurityView activeTab="overview" onTabChange={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'go to drivers' }));
    rerender(<SecurityView activeTab="images" onTabChange={vi.fn()} />);
    expect(await screen.findByTestId('snapshot')).toHaveTextContent('"stackName":"web"');

    await userEvent.click(screen.getByRole('button', { name: 'intent saved' }));

    await waitFor(() => expect(screen.getByTestId('snapshot')).toHaveTextContent('[{"imageRef":"exp:1"}]'));
    expect(screen.getByTestId('targeting')).toHaveTextContent('elevated_exploit_risk');
  });
});
