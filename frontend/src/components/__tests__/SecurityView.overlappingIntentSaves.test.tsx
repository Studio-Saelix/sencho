/**
 * Saves that overlap: a reply lands whenever it lands, and must not undo a
 * confirmed save the operator made after it began. The follow-up summary reread
 * fails throughout, so every row shows only what the saves themselves proved.
 * A reply for a node the operator has since left is not theirs to apply.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: toasts }));

const nodeState = vi.hoisted(() => ({ id: 1 }));
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({
    activeNode: { id: nodeState.id, name: `node ${nodeState.id}`, type: 'local' },
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
const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => viewport.mobile }));
vi.mock('@/components/security/OverviewTab', () => ({ OverviewTab: () => null }));
vi.mock('@/components/security/FindingsTab', () => ({ FindingsTab: () => null }));
vi.mock('@/components/security/ScanPolicyManager', () => ({ ScanPolicyManager: () => null }));
vi.mock('@/components/security/ScannerSetupTab', () => ({ ScannerSetupTab: () => null }));
vi.mock('@/components/security/HistoryTab', () => ({ HistoryTab: () => null }));
vi.mock('@/components/VulnerabilityScanSheet', () => ({ VulnerabilityScanSheet: () => null }));
vi.mock('@/components/settings/SuppressionsPanel', () => ({ SuppressionsPanel: () => null }));
vi.mock('@/components/settings/MisconfigAckPanel', () => ({ MisconfigAckPanel: () => null }));

import { SecurityView } from '../SecurityView';
import type { ScanSummary } from '@/types/security';

type Intents = Array<{ service: string; intent: string }>;

function jsonOk(body: unknown) {
  return Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: async () => body } as unknown as Response);
}

const overview = {
  scannedImages: 2, critical: 0, high: 0, fixable: 0, secrets: 0, misconfigs: 0, staleScans: 0, failedScans: 0,
  lastSuccessfulScanAt: Date.now(),
  scanner: { available: true, version: '0.50.0', source: 'managed', autoUpdate: true },
  deployEnforcement: { honorSuppressionsOnDeploy: true, eligibleBlockPolicies: 0 },
  posture: 'Secure', postureReasons: [], primaryAction: null, updateChecksDisabled: false,
};

/** An image exposed through one unclassified service. */
function unclassified(imageRef: string, stackName: string, serviceName: string): ScanSummary {
  return {
    image_ref: imageRef,
    scan_id: 1,
    highest_severity: null,
    scanned_at: Date.now(),
    total: 0, critical: 0, high: 0, medium: 0, low: 0, unknown: 0, fixable: 0,
    secret_count: 0, misconfig_count: 0,
    publicly_exposed: true,
    exposure_contexts: [{ stackName, serviceName, exposureReason: 'published-port', intentStatus: 'unset' }],
    exposure_context_count: 1,
    exposure_context_summary: {
      hasConflict: false, hasUnclassified: true, hasUnavailable: false, allKnownIntentional: false,
    },
  };
}

interface PendingPut { stack: string; service: string; release: () => void }

/**
 * Summaries per node, and PUTs the test settles by hand. A PUT takes effect on
 * the server when it arrives and its reply carries the stack as it was then, so
 * a held reply is older than a save that arrives after it. Once any PUT has
 * been sent, node 1's summaries reread answers 503, so its rows show only the
 * saves.
 */
function mockApi(summariesByNode: Record<number, ScanSummary[]>, hold: (stack: string, service: string) => boolean) {
  const puts: PendingPut[] = [];
  const server = new Map<string, Map<string, string>>();
  let saved = false;
  apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/security/overview') return jsonOk(overview);
    if (url === '/security/image-summaries') {
      if (saved && nodeState.id === 1) {
        return Promise.resolve({ ok: false, status: 503, headers: new Headers(), json: async () => ({ error: 'unavailable' }) } as unknown as Response);
      }
      return jsonOk(Object.fromEntries((summariesByNode[nodeState.id] ?? []).map((s) => [s.image_ref, s])));
    }
    if (url === '/security/overview/trend') return jsonOk([]);
    if (url === '/security/overview/exploit-intel') return jsonOk({ items: [], truncated: false });
    if (url === '/fleet/role') return jsonOk({ role: 'control' });
    const stack = /^\/stacks\/([^/]+)\/exposure$/.exec(url)?.[1];
    if (stack !== undefined && init?.method === 'PUT') {
      saved = true;
      const { service, intent } = JSON.parse(init.body as string) as { service: string; intent: string };
      const rows = server.get(stack) ?? new Map<string, string>();
      rows.set(service, intent);
      server.set(stack, rows);
      const intents: Intents = [...rows].map(([name, value]) => ({ service: name, intent: value }));
      const reply = { ok: true, status: 200, headers: new Headers(), json: async () => ({ intents }) } as unknown as Response;
      if (!hold(stack, service)) return Promise.resolve(reply);
      return new Promise((resolve) => {
        puts.push({ stack, service, release: () => resolve(reply) });
      });
    }
    if (stack !== undefined) return jsonOk({ intents: [] });
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);
  });
  return puts;
}

beforeEach(() => {
  viewport.mobile = false;
  nodeState.id = 1;
  apiFetchMock.mockReset();
  toasts.error.mockReset();
  toasts.success.mockReset();
});

async function chooseLan(trigger: string) {
  await userEvent.click(screen.getByRole('button', { name: trigger }));
  await userEvent.click(await screen.findByRole('button', { name: 'lan' }));
}

describe.each([['desktop', false], ['phone', true]])('overlapping intent saves on %s', (_name, mobile) => {
  beforeEach(() => { viewport.mobile = mobile; });

  it('keeps a confirmed save on another stack when an earlier save replies after it', async () => {
    const puts = mockApi(
      { 1: [unclassified('app:1', 'web', 'api'), unclassified('app:2', 'other', 'api')] },
      (stack) => stack === 'web',
    );
    render(<SecurityView activeTab="images" onTabChange={vi.fn()} />);
    expect(await screen.findAllByText('Intent: not classified')).toHaveLength(2);

    // The first save is still in flight when its picker is dismissed.
    await chooseLan('Network exposed: set intent for web/api');
    await waitFor(() => expect(puts).toHaveLength(1));
    await userEvent.keyboard('{Escape}');

    await chooseLan('Network exposed: set intent for other/api');
    await waitFor(() => expect(screen.getAllByText('Intent: LAN')).toHaveLength(1));

    puts[0]!.release();
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(2));

    // The late reply knew only its own stack, so the other save stands.
    await waitFor(() => expect(screen.getAllByText('Intent: LAN')).toHaveLength(2));
    expect(screen.queryByText('Intent: not classified')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Network exposed: change intent for other/api' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Network exposed: change intent for web/api' })).toBeInTheDocument();
  });

  it('keeps the later save of a stack when the earlier one replies after it', async () => {
    const puts = mockApi(
      { 1: [unclassified('app:1', 'web', 'api'), unclassified('app:2', 'web', 'worker')] },
      (_stack, service) => service === 'api',
    );
    render(<SecurityView activeTab="images" onTabChange={vi.fn()} />);
    expect(await screen.findAllByText('Intent: not classified')).toHaveLength(2);

    await chooseLan('Network exposed: set intent for web/api');
    await waitFor(() => expect(puts).toHaveLength(1));
    await userEvent.keyboard('{Escape}');

    await chooseLan('Network exposed: set intent for web/worker');
    // The server applied both saves, so this reply already carries both rows.
    await waitFor(() => expect(screen.getAllByText('Intent: LAN')).toHaveLength(2));

    // The earlier reply holds the stack as it was before the worker save.
    puts[0]!.release();
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(2));

    await waitFor(() => expect(screen.getAllByText('Intent: LAN')).toHaveLength(2));
    expect(screen.queryByText('Intent: not classified')).not.toBeInTheDocument();
  });

  it('does not apply a reply to the node the operator moved to', async () => {
    const puts = mockApi(
      { 1: [unclassified('app:1', 'web', 'api')], 2: [unclassified('app:1', 'web', 'api')] },
      () => true,
    );
    const { rerender } = render(<SecurityView activeTab="images" onTabChange={vi.fn()} />);
    expect(await screen.findByText('Intent: not classified')).toBeInTheDocument();

    await chooseLan('Network exposed: set intent for web/api');
    await waitFor(() => expect(puts).toHaveLength(1));

    // Node 2 has the same image and stack, and its first read lands.
    nodeState.id = 2;
    rerender(<SecurityView activeTab="images" onTabChange={vi.fn()} />);
    expect(await screen.findByText('Intent: not classified')).toBeInTheDocument();
    const summaryReads = () => apiFetchMock.mock.calls.filter(([url]) => url === '/security/image-summaries').length;
    const readsBefore = summaryReads();

    puts[0]!.release();
    await waitFor(() => expect(toasts.success).toHaveBeenCalled());

    // The save belongs to node 1: node 2 keeps its row and is not reread for it.
    expect(screen.getByText('Intent: not classified')).toBeInTheDocument();
    expect(screen.queryByText('Intent: LAN')).not.toBeInTheDocument();
    expect(summaryReads()).toBe(readsBefore);
  });
});
