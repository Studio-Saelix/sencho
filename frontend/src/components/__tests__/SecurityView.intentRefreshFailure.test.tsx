/**
 * A confirmed exposure-intent save is adopted into the Images evidence before
 * the dependent summary reread. When that reread fails, the row must show the
 * saved intent and action instead of presenting the pre-save evidence it
 * replaced as current. An unverified tunnel reach taken at the operator's word
 * is the exception: it stops counting as exposed, as it does on the server.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: toasts }));

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
          targets: [{
            imageRef: 'exp:1',
            stackName: 'web',
            serviceName: 'api',
            intentStatus: 'set',
            exposureIntent: 'internal',
            intentConflict: true,
          }],
        })}
      >
        go to images
      </button>
      <button
        type="button"
        onClick={() => onNavigate('images', undefined, {
          kind: 'public_exposure',
          label: 'Network exposed images',
          imageRefs: ['exp:1'],
          targets: [{
            imageRef: 'exp:1',
            stackName: 'web',
            serviceName: 'api',
            exposureReason: 'tunnel',
            tunnel: {
              connector: 'edge',
              provider: 'cloudflared',
              scope: 'public-edge',
              path: 'shared-network',
            },
            intentStatus: 'unset',
          }],
        })}
      >
        go to tunnel images
      </button>
    </>
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
import { applySavedIntents } from '../security/imagesTargeting';
import type { ScanSummary } from '@/types/security';

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

function summary(overrides: Partial<ScanSummary>): ScanSummary {
  return {
    image_ref: 'exp:1',
    scan_id: 1,
    highest_severity: null,
    scanned_at: Date.now(),
    total: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    unknown: 0,
    fixable: 0,
    secret_count: 0,
    misconfig_count: 0,
    ...overrides,
  };
}

const unclassifiedSummary = summary({
  publicly_exposed: true,
  exposure_contexts: [{
    stackName: 'web',
    serviceName: 'api',
    exposureReason: 'published-port',
    intentStatus: 'unset',
  }],
  exposure_context_count: 1,
  exposure_context_summary: {
    hasConflict: false,
    hasUnclassified: true,
    hasUnavailable: false,
    allKnownIntentional: false,
  },
});

const conflictSummary = summary({
  publicly_exposed: true,
  exposure_contexts: [{
    stackName: 'web',
    serviceName: 'api',
    exposureReason: 'published-port',
    intentStatus: 'set',
    exposureIntent: 'internal',
    intentConflict: true,
  }],
  exposure_context_count: 1,
  exposure_context_summary: {
    hasConflict: true,
    hasUnclassified: false,
    hasUnavailable: false,
    allKnownIntentional: false,
  },
});

const unverifiedTunnelSummary = summary({
  publicly_exposed: true,
  exposure_contexts: [{
    stackName: 'web',
    serviceName: 'api',
    exposureReason: 'tunnel',
    tunnel: {
      connector: 'edge',
      provider: 'cloudflared',
      scope: 'public-edge',
      path: 'shared-network',
    },
    intentStatus: 'unset',
  }],
  exposure_context_count: 1,
  exposure_context_summary: {
    hasConflict: false,
    hasUnclassified: true,
    hasUnavailable: false,
    allKnownIntentional: false,
  },
});

const certainTunnelSummary = summary({
  publicly_exposed: true,
  exposure_contexts: [{
    stackName: 'web',
    serviceName: 'api',
    exposureReason: 'tunnel',
    tunnel: {
      connector: 'edge',
      provider: 'tailscale',
      scope: 'private-overlay',
      path: 'shared-namespace',
    },
    intentStatus: 'unset',
  }],
  exposure_context_count: 1,
  exposure_context_summary: {
    hasConflict: false,
    hasUnclassified: true,
    hasUnavailable: false,
    allKnownIntentional: false,
  },
});

function mockApi(options: {
  summaries: ScanSummary;
  failSummariesAfterSave: boolean;
  savedIntents?: Array<{ service: string; intent: string }>;
  savedIntentsFor?: (putNumber: number) => Array<{ service: string; intent: string }>;
}) {
  let saved = false;
  let puts = 0;
  apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/security/overview') return jsonOk(overview);
    if (url === '/security/image-summaries') {
      if (saved && options.failSummariesAfterSave) {
        return Promise.resolve({ ok: false, status: 503, headers: new Headers(), json: async () => ({ error: 'unavailable' }) } as unknown as Response);
      }
      return jsonOk({ [options.summaries.image_ref]: options.summaries });
    }
    if (url === '/security/overview/trend') return jsonOk([]);
    if (url === '/security/overview/exploit-intel') return jsonOk({ items: [], truncated: false });
    if (url === '/fleet/role') return jsonOk({ role: 'control' });
    if (url === '/stacks/web/exposure' && init?.method === 'PUT') {
      saved = true;
      puts += 1;
      return jsonOk({
        intents: options.savedIntentsFor?.(puts)
          ?? options.savedIntents
          ?? [{ service: 'api', intent: 'public' }],
      });
    }
    if (url === '/stacks/web/exposure') return jsonOk({ intents: [] });
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);
  });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  toasts.error.mockReset();
  toasts.success.mockReset();
});

describe('SecurityView after a save whose summary reread fails', () => {
  it('shows the saved intent and action on the standing row instead of the pre-save classification', async () => {
    mockApi({ summaries: unclassifiedSummary, failSummariesAfterSave: true });
    render(<SecurityView activeTab="images" onTabChange={vi.fn()} />);

    expect(await screen.findByText('Intent: not classified')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Network exposed: set intent for web/api' }));
    await userEvent.click(await screen.findByRole('button', { name: 'public' }));

    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Could not refresh security data'));
    expect(screen.getByText('Intent: public')).toBeInTheDocument();
    expect(screen.queryByText('Intent: not classified')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Network exposed: change intent for web/api' })).toBeInTheDocument();
  });

  it('shows the saved intent and action on a targeted row instead of the conflict evidence', async () => {
    mockApi({ summaries: conflictSummary, failSummariesAfterSave: true });
    const { rerender } = render(<SecurityView activeTab="overview" onTabChange={vi.fn()} />);

    await userEvent.click(await screen.findByRole('button', { name: 'go to images' }));
    rerender(<SecurityView activeTab="images" onTabChange={vi.fn()} />);

    expect(await screen.findByText('Exposure conflicts with declared intent')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Change intent' })[0]!);
    await userEvent.click(await screen.findByRole('button', { name: 'public' }));

    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Could not refresh security data'));
    expect(screen.getByText('Intent: public')).toBeInTheDocument();
    expect(screen.queryByText(/Intent mismatch/)).not.toBeInTheDocument();
    expect(screen.queryByText('Exposure conflicts with declared intent')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Network exposed: change intent for web/api' })).toBeInTheDocument();
  });

  it('stops counting an unverified tunnel service instead of inventing a mismatch', async () => {
    mockApi({
      summaries: unverifiedTunnelSummary,
      failSummariesAfterSave: true,
      savedIntents: [{ service: 'api', intent: 'internal' }],
    });
    render(<SecurityView activeTab="images" onTabChange={vi.fn()} />);

    expect(await screen.findByText('Intent: not classified')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Network exposed: set intent for web\/api/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'internal' }));

    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Could not refresh security data'));
    // The server takes an unverified tunnel reach at the operator's word, so
    // the row stops showing exposure evidence and its action.
    expect(screen.queryByText(/Intent mismatch/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Network exposed/ })).not.toBeInTheDocument();
    expect(screen.getByText('exp:1')).toBeInTheDocument();
  });

  it('settles an unverified tunnel row reached from targeting', async () => {
    mockApi({
      summaries: unverifiedTunnelSummary,
      failSummariesAfterSave: true,
      savedIntents: [{ service: 'api', intent: 'internal' }],
    });
    const { rerender } = render(<SecurityView activeTab="overview" onTabChange={vi.fn()} />);

    await userEvent.click(await screen.findByRole('button', { name: 'go to tunnel images' }));
    rerender(<SecurityView activeTab="images" onTabChange={vi.fn()} />);

    expect(await screen.findByText('Intent: not classified')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Network exposed: set intent for web\/api/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'internal' }));

    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Could not refresh security data'));
    expect(screen.queryByText(/Intent mismatch/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Network exposed/ })).not.toBeInTheDocument();
    expect(screen.getByText('exp:1')).toBeInTheDocument();
  });

  it('keeps a hidden capped warning across two saves whose rereads fail', async () => {
    const baseIntents = Array.from({ length: 20 }, (_, index) => ({
      service: `svc${index}`,
      intent: 'public',
    }));
    const visible = Array.from({ length: 20 }, (_, index) => ({
      stackName: 'web',
      serviceName: `svc${index}`,
      exposureReason: 'published-port' as const,
      intentStatus: 'unset' as const,
    }));
    let projected: Record<string, ScanSummary> = {
      'exp:1': summary({
        publicly_exposed: true,
        exposure_contexts: visible,
        exposure_context_count: 21,
        exposure_contexts_truncated: true,
        exposure_context_summary: {
          hasConflict: false,
          hasUnclassified: true,
          hasUnavailable: false,
          allKnownIntentional: false,
        },
      }),
    };
    // The state the row keeps after twenty earlier confirmed saves whose
    // rereads failed: every displayed context is intentional, the hidden one
    // may still be unclassified.
    const earlier: Array<{ service: string; intent: 'public' }> = [];
    for (let index = 0; index < 20; index += 1) {
      earlier.push({ service: `svc${index}`, intent: 'public' });
      projected = applySavedIntents(projected, 'web', earlier);
    }

    mockApi({
      summaries: projected['exp:1']!,
      failSummariesAfterSave: true,
      savedIntentsFor: (put) => baseIntents.map((entry, index) => {
        if (index === 0) return { ...entry, intent: 'lan' };
        if (index === 1 && put >= 2) return { ...entry, intent: 'temporary' };
        return entry;
      }),
    });
    render(<SecurityView activeTab="images" onTabChange={vi.fn()} />);
    expect(await screen.findByText('Intent: not classified (+20)')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Network exposed: choose a service' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Change intent for web/svc0' }));
    await userEvent.click(await screen.findByRole('button', { name: 'lan' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Could not refresh security data'));

    // The service list stays open through the save and the failed reread.
    await userEvent.click(await screen.findByRole('button', { name: 'Change intent for web/svc1' }));
    await userEvent.click(await screen.findByRole('button', { name: 'temporary' }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledTimes(2));

    expect(screen.getByText('Intent: not classified (+20)')).toBeInTheDocument();
    expect(screen.queryByText(/Intent mismatch/)).not.toBeInTheDocument();
  });

  it('keeps a certain tunnel reach conflicting after a restrictive save', async () => {
    mockApi({
      summaries: certainTunnelSummary,
      failSummariesAfterSave: true,
      savedIntents: [{ service: 'api', intent: 'internal' }],
    });
    render(<SecurityView activeTab="images" onTabChange={vi.fn()} />);

    expect(await screen.findByText('Intent: not classified')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Network exposed: set intent for web\/api/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'internal' }));

    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Could not refresh security data'));
    expect(screen.getByText('Intent mismatch: internal')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Network exposed: change intent for web\/api/ })).toBeInTheDocument();
  });
});
