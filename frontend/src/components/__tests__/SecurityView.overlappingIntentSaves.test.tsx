/**
 * Saves that overlap: the server applies a save when the request reaches it, and
 * its reply carries the stack as it was left then. Saves to one stack are sent
 * one at a time, so a delayed save is applied before the next is sent and no
 * reply can hold fewer saves than the one before it. Once a save is sent, node
 * 1's summary reread fails, so its rows show only what the saves themselves
 * proved. A reply for a node the operator has since left is not theirs to apply.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
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
vi.mock('@/components/security/OverviewTab', () => ({
  OverviewTab: ({ onNavigate }: { onNavigate: (tab: string, filter?: undefined, targeting?: unknown) => void }) => (
    <button
      type="button"
      onClick={() => onNavigate('images', undefined, {
        kind: 'public_exposure',
        label: 'Network exposed images',
        imageRefs: ['exp:1'],
        targets: ['hidden1', 'hidden2'].map((serviceName) => ({
          imageRef: 'exp:1',
          stackName: 'web',
          serviceName,
          exposureReason: 'published-port',
          intentStatus: 'unset',
        })),
      })}
    >
      go to hidden images
    </button>
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

/** Set by a test that goes back to node 1 and needs its summaries to load. */
const rereadsHealed = { value: false };

interface PendingPut { stack: string; service: string; release: () => void }

/**
 * Summaries per node, and PUTs the test settles by hand. A held PUT is not
 * applied by the server until the test releases it, and its reply carries the
 * stack as it was then. `applied` lists the saves in the order the server took
 * them. Once any PUT has been sent, node 1's summaries reread answers 503, so
 * its rows show only the saves.
 */
function mockApi(
  summariesByNode: Record<number, ScanSummary[]>,
  hold: (stack: string, service: string) => boolean,
  seed: Record<string, Intents> = {},
) {
  const puts: PendingPut[] = [];
  const applied: string[] = [];
  // Each node keeps its own rows, as the servers do; the seed belongs to node 1.
  const server = new Map<string, Map<string, string>>(
    Object.entries(seed).map(([stack, rows]) => [`1\0${stack}`, new Map(rows.map((row) => [row.service, row.intent]))]),
  );
  let saved = false;
  apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/security/overview') return jsonOk(overview);
    if (url === '/security/image-summaries') {
      if (saved && nodeState.id === 1 && !rereadsHealed.value) {
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
      const rowsKey = `${(init as { nodeId?: number }).nodeId ?? nodeState.id}\0${stack}`;
      const apply = () => {
        const rows = server.get(rowsKey) ?? new Map<string, string>();
        rows.set(service, intent);
        server.set(rowsKey, rows);
        applied.push(`${stack}/${service}`);
        const intents: Intents = [...rows].map(([name, value]) => ({ service: name, intent: value }));
        return { ok: true, status: 200, headers: new Headers(), json: async () => ({ intents }) } as unknown as Response;
      };
      if (!hold(stack, service)) return Promise.resolve(apply());
      return new Promise((resolve) => {
        puts.push({ stack, service, release: () => resolve(apply()) });
      });
    }
    if (stack !== undefined) return jsonOk({ intents: [] });
    return Promise.resolve({ ok: false, status: 404, json: async () => ({}) } as unknown as Response);
  });
  return Object.assign(puts, { applied });
}

beforeEach(() => {
  viewport.mobile = false;
  nodeState.id = 1;
  rereadsHealed.value = false;
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

  it('does not hold a save to another stack behind one still in flight', async () => {
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

  it('sends a later save of a stack only after the delayed earlier one is applied', async () => {
    const puts = mockApi(
      { 1: [unclassified('app:1', 'web', 'api'), unclassified('app:2', 'web', 'worker')] },
      (_stack, service) => service === 'api',
    );
    render(<SecurityView activeTab="images" onTabChange={vi.fn()} />);
    expect(await screen.findAllByText('Intent: not classified')).toHaveLength(2);

    // The first save is held before the server applies it.
    await chooseLan('Network exposed: set intent for web/api');
    await waitFor(() => expect(puts).toHaveLength(1));
    await userEvent.keyboard('{Escape}');

    await chooseLan('Network exposed: set intent for web/worker');
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    // The worker save waits its turn: it cannot be applied ahead of the api save.
    const putsSent = () => apiFetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
    expect(putsSent()).toHaveLength(1);
    expect(puts.applied).toEqual([]);
    expect(toasts.success).not.toHaveBeenCalled();

    puts[0]!.release();
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(2));
    expect(puts.applied).toEqual(['web/api', 'web/worker']);

    await waitFor(() => expect(screen.getAllByText('Intent: LAN')).toHaveLength(2));
    expect(screen.queryByText('Intent: not classified')).not.toBeInTheDocument();
  });

  it.each([
    ['public', 'Intent: public'],
    ['internal', 'Intent mismatch: internal'],
    ['unknown', 'Intent: not classified'],
  ])('keeps %s on the delayed save while a later save of the stack waits', async (intent, evidence) => {
    const puts = mockApi(
      { 1: [unclassified('app:1', 'web', 'api'), unclassified('app:2', 'web', 'worker')] },
      (_stack, service) => service === 'api',
    );
    render(<SecurityView activeTab="images" onTabChange={vi.fn()} />);
    expect(await screen.findAllByText('Intent: not classified')).toHaveLength(2);

    await userEvent.click(screen.getByRole('button', { name: 'Network exposed: set intent for web/api' }));
    await userEvent.click(await screen.findByRole('button', { name: intent }));
    await waitFor(() => expect(puts).toHaveLength(1));
    await userEvent.keyboard('{Escape}');
    await chooseLan('Network exposed: set intent for web/worker');

    puts[0]!.release();
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(2));
    expect(puts.applied).toEqual([`web/api`, 'web/worker']);

    // Both rows show their own save, and the reread that would correct them failed.
    await waitFor(() => expect(screen.getByText('Intent: LAN')).toBeInTheDocument());
    expect(screen.getAllByText(evidence)).toHaveLength(1);
  });

  it('sends a later save of a stack even when the earlier one was refused', async () => {
    const puts = mockApi(
      { 1: [unclassified('app:1', 'web', 'api'), unclassified('app:2', 'web', 'worker')] },
      (_stack, service) => service === 'api',
    );
    // The api save is held, then refused.
    const answer = apiFetchMock.getMockImplementation()!;
    apiFetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT' && JSON.parse(init.body as string).service === 'api') {
        return new Promise((resolve) => {
          puts.push({
            stack: 'web',
            service: 'api',
            release: () => resolve({ ok: false, status: 500, headers: new Headers(), json: async () => ({ error: 'boom' }) } as unknown as Response),
          });
        });
      }
      return answer(url, init);
    });
    render(<SecurityView activeTab="images" onTabChange={vi.fn()} />);
    expect(await screen.findAllByText('Intent: not classified')).toHaveLength(2);

    await chooseLan('Network exposed: set intent for web/api');
    await waitFor(() => expect(puts).toHaveLength(1));
    await userEvent.keyboard('{Escape}');
    await chooseLan('Network exposed: set intent for web/worker');

    puts[0]!.release();
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('boom'));
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(1));
    expect(puts.applied).toEqual(['web/worker']);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Network exposed: change intent for web/worker' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Network exposed: set intent for web/api' })).toBeInTheDocument();
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
    // Give a reread, had one been started, the chance to be issued.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    // The save belongs to node 1: node 2 keeps its row and is not reread for it.
    expect(screen.getByText('Intent: not classified')).toBeInTheDocument();
    expect(screen.queryByText('Intent: LAN')).not.toBeInTheDocument();
    expect(summaryReads()).toBe(readsBefore);
  });

  it('does not read another node\'s save after the operator goes there and back', async () => {
    const puts = mockApi(
      {
        1: [unclassified('app:1', 'web', 'api'), unclassified('app:2', 'web', 'worker')],
        2: [unclassified('app:1', 'web', 'api'), unclassified('app:2', 'web', 'worker')],
      },
      (_stack, service) => service === 'api',
    );
    const { rerender } = render(<SecurityView activeTab="images" onTabChange={vi.fn()} />);
    expect(await screen.findAllByText('Intent: not classified')).toHaveLength(2);

    await chooseLan('Network exposed: set intent for web/api');
    await waitFor(() => expect(puts).toHaveLength(1));

    // Node 2 saves a different service of a stack with the same name.
    nodeState.id = 2;
    rerender(<SecurityView activeTab="images" onTabChange={vi.fn()} />);
    expect(await screen.findAllByText('Intent: not classified')).toHaveLength(2);
    await chooseLan('Network exposed: set intent for web/worker');
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(1));

    // Back on node 1, whose first reply is still on its way.
    rereadsHealed.value = true;
    nodeState.id = 1;
    rerender(<SecurityView activeTab="images" onTabChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Network exposed: set intent for web/api' })).toBeInTheDocument());
    rereadsHealed.value = false;
    puts[0]!.release();
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(2));

    // Node 1 saved web/api only; node 2's worker save is not its own.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Network exposed: change intent for web/api' })).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Network exposed: set intent for web/worker' })).toBeInTheDocument();
  });

  it('keeps a hidden service saved while a later save of the stack waits behind it', async () => {
    // Twenty classified services and two the cap hides, reached through targeting.
    const capped: ScanSummary = {
      ...unclassified('exp:1', 'web', 'svc0'),
      exposure_contexts: Array.from({ length: 20 }, (_, index) => ({
        stackName: 'web',
        serviceName: `svc${index}`,
        exposureReason: 'published-port' as const,
        intentStatus: 'set' as const,
        exposureIntent: 'public' as const,
      })),
      exposure_context_count: 22,
      exposure_contexts_truncated: true,
      exposure_context_summary: {
        hasConflict: false, hasUnclassified: false, hasUnavailable: false, allKnownIntentional: true,
      },
    };
    const seed = { web: Array.from({ length: 20 }, (_, index) => ({ service: `svc${index}`, intent: 'public' })) };
    const puts = mockApi({ 1: [capped] }, (_stack, service) => service === 'hidden1', seed);
    const { rerender } = render(<SecurityView activeTab="overview" onTabChange={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'go to hidden images' }));
    rerender(<SecurityView activeTab="images" onTabChange={vi.fn()} />);

    const openList = async () => {
      if (screen.queryAllByRole('button', { name: /^(Set|Change) intent for web\// }).length === 0) {
        await userEvent.click(await screen.findByRole('button', { name: 'Network exposed: choose a service' }));
      }
    };
    await openList();
    await userEvent.click(await screen.findByRole('button', { name: 'Set intent for web/hidden1' }));
    await userEvent.click(await screen.findByRole('button', { name: 'lan' }));
    await waitFor(() => expect(puts).toHaveLength(1));
    await userEvent.keyboard('{Escape}');

    await openList();
    await userEvent.click(await screen.findByRole('button', { name: 'Set intent for web/hidden2' }));
    await userEvent.click(await screen.findByRole('button', { name: 'lan' }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    expect(puts.applied).toEqual([]);
    expect(toasts.success).not.toHaveBeenCalled();

    // The first save is applied, then the second: its reply holds both services.
    puts[0]!.release();
    await waitFor(() => expect(toasts.success).toHaveBeenCalledTimes(2));
    expect(puts.applied).toEqual(['web/hidden1', 'web/hidden2']);
    await waitFor(() => expect(screen.queryByText(/not classified/)).not.toBeInTheDocument());

    await openList();
    expect(await screen.findByRole('button', { name: 'Change intent for web/hidden1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change intent for web/hidden2' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change intent for web/svc0' })).toBeInTheDocument();
  });
});
