/**
 * SecurityView must refetch overview when image-update checks are toggled
 * so Check again and the uncertain-row disabled-checks description are not
 * stale until a full page reload.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ can: () => true }),
}));
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({
    activeNode: { id: 1, name: 'local', type: 'local' },
    hasCapability: () => true,
    activeNodeMeta: { version: '0.98.0' },
  }),
}));
vi.mock('@/hooks/useImageScan', () => ({
  useImageScan: () => ({ scanningRef: null, scanImage: vi.fn() }),
}));
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/components/security/OverviewTab', () => ({
  OverviewTab: ({ overview }: { overview: { updateChecksDisabled?: boolean } | null }) => {
    let label = 'loading';
    if (overview != null) {
      label = overview.updateChecksDisabled ? 'disabled' : 'enabled';
    }
    return <div data-testid="checks-state">{label}</div>;
  },
}));
vi.mock('@/components/security/ImagesTab', () => ({ ImagesTab: () => null }));
vi.mock('@/components/security/FindingsTab', () => ({ FindingsTab: () => null }));
vi.mock('@/components/security/ScanPolicyManager', () => ({ ScanPolicyManager: () => null }));
vi.mock('@/components/security/ScannerSetupTab', () => ({ ScannerSetupTab: () => null }));
vi.mock('@/components/security/HistoryTab', () => ({ HistoryTab: () => null }));
vi.mock('@/components/VulnerabilityScanSheet', () => ({ VulnerabilityScanSheet: () => null }));
vi.mock('@/components/settings/SuppressionsPanel', () => ({ SuppressionsPanel: () => null }));
vi.mock('@/components/settings/MisconfigAckPanel', () => ({ MisconfigAckPanel: () => null }));

import { apiFetch } from '@/lib/api';
import { SENCHO_SETTINGS_CHANGED } from '@/lib/events';
import { SecurityView } from '../SecurityView';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

function overviewBody(updateChecksDisabled: boolean) {
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
    updateChecksDisabled,
  };
}

function jsonOk(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

beforeEach(() => {
  mockedFetch.mockReset();
  let overviewCalls = 0;
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/security/overview') {
      overviewCalls += 1;
      return jsonOk(overviewBody(overviewCalls > 1));
    }
    if (url === '/security/image-summaries') return jsonOk({});
    if (url === '/security/overview/trend') return jsonOk([]);
    if (url === '/security/overview/exploit-intel') return jsonOk({ items: [], truncated: false });
    if (url === '/fleet/role') return jsonOk({ role: 'control' });
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
  });
});

describe('SecurityView settings refresh', () => {
  it('refetches overview when SENCHO_SETTINGS_CHANGED includes image_update_checks_enabled', async () => {
    render(<SecurityView activeTab="overview" onTabChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByTestId('checks-state')).toHaveTextContent('enabled'));
    const overviewCallsBefore = mockedFetch.mock.calls.filter((c) => c[0] === '/security/overview').length;

    await act(async () => {
      window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED, {
        detail: { changedKeys: ['image_update_checks_enabled'] },
      }));
    });

    await waitFor(() => expect(screen.getByTestId('checks-state')).toHaveTextContent('disabled'));
    const overviewCalls = mockedFetch.mock.calls.filter((c) => c[0] === '/security/overview');
    const summaryCalls = mockedFetch.mock.calls.filter((c) => c[0] === '/security/image-summaries');
    expect(overviewCalls.length).toBeGreaterThan(overviewCallsBefore);
    for (const call of [...overviewCalls, ...summaryCalls]) {
      expect(call[1]).toEqual(expect.objectContaining({ cache: 'no-store' }));
    }
  });

  it('does not refetch overview for an unrelated settings key', async () => {
    render(<SecurityView activeTab="overview" onTabChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId('checks-state')).toHaveTextContent('enabled'));
    const before = mockedFetch.mock.calls.filter((c) => c[0] === '/security/overview').length;

    await act(async () => {
      window.dispatchEvent(new CustomEvent(SENCHO_SETTINGS_CHANGED, {
        detail: { changedKeys: ['developer_mode'] },
      }));
    });

    await waitFor(() => expect(screen.getByTestId('checks-state')).toHaveTextContent('enabled'));
    expect(mockedFetch.mock.calls.filter((c) => c[0] === '/security/overview').length).toBe(before);
  });
});
