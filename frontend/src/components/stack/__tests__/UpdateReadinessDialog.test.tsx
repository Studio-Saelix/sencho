import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { UpdateReadinessDialog } from '../UpdateReadinessDialog';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const authState = { isAdmin: true };
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => authState,
}));

let nodeMetaMap = new Map<number, { version: string | null; capabilities: string[]; fetchedAt: number }>();
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({
    nodeMeta: nodeMetaMap,
    hasCapability: () => true,
    activeNodeMeta: null,
  }),
}));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';

type Verdict = 'ready' | 'ready_with_warnings' | 'review_required' | 'blocked' | 'unknown';

const report = (verdict: Verdict) => ({
  stack: 'web',
  computedAt: Date.now(),
  verdict,
  signals: [
    { id: 'preflight', status: 'ok', title: 'Compose Doctor', detail: 'The last preflight passed.', affectsVerdict: true },
  ],
});

function routeApi(over: {
  readiness?: () => Promise<Response>;
  coverage?: () => Promise<Response>;
  snapshot?: () => Promise<Response>;
  inventory?: () => Promise<Response>;
} = {}) {
  vi.mocked(apiFetch).mockImplementation((url: string, options?: { method?: string }) => {
    const u = String(url);
    if (u.includes('/update-readiness')) {
      return (over.readiness ?? (() => Promise.resolve(new Response(JSON.stringify(report('ready')), { status: 200 }))))();
    }
    if (u.includes('/label-inventory')) {
      return (over.inventory ?? (() => Promise.resolve(new Response(JSON.stringify({ services: [] }), { status: 200 }))))();
    }
    if (u.includes('/snapshots/coverage')) {
      return (over.coverage ?? (() => Promise.resolve(new Response(JSON.stringify({ latestAt: null }), { status: 200 }))))();
    }
    if (u.includes('/fleet/snapshots') && options?.method === 'POST') {
      return (over.snapshot ?? (() => Promise.resolve(new Response('{}', { status: 200 }))))();
    }
    return Promise.resolve(new Response('{}', { status: 200 }));
  });
}

function setup(props: Partial<Parameters<typeof UpdateReadinessDialog>[0]> = {}) {
  const base = {
    open: true,
    stackName: 'web',
    nodeId: 1,
    onCancel: vi.fn(),
    onProceed: vi.fn(),
    ...props,
  };
  render(<UpdateReadinessDialog {...base} />);
  return base;
}

describe('UpdateReadinessDialog', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.clearAllMocks();
    authState.isAdmin = true;
    nodeMetaMap = new Map();
  });

  const verdictCases: Array<{ verdict: Verdict; label: string }> = [
    { verdict: 'ready', label: 'ready' },
    { verdict: 'ready_with_warnings', label: 'ready with warnings' },
    { verdict: 'review_required', label: 'review required' },
    { verdict: 'blocked', label: 'blocked' },
    { verdict: 'unknown', label: 'unknown' },
  ];

  it.each(verdictCases)('renders the $verdict verdict with Proceed enabled', async ({ verdict, label }) => {
    routeApi({ readiness: () => Promise.resolve(new Response(JSON.stringify(report(verdict)), { status: 200 })) });
    setup();
    await waitFor(() => expect(screen.getByTestId('readiness-verdict')).toHaveAttribute('data-verdict', verdict));
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByTestId('readiness-proceed')).toBeEnabled();
  });

  it('fetches readiness and coverage against the captured node, not the active node', async () => {
    routeApi();
    setup({ nodeId: 7 });
    await waitFor(() => expect(screen.getByTestId('readiness-verdict')).toBeInTheDocument());
    const readinessCall = vi.mocked(apiFetch).mock.calls.find(c => String(c[0]).includes('/update-readiness'));
    expect(readinessCall).toBeDefined();
    expect((readinessCall![1] as { nodeId?: number | null } | undefined)?.nodeId).toBe(7);
    const coverageCall = vi.mocked(apiFetch).mock.calls.find(c => String(c[0]).includes('/snapshots/coverage'));
    expect(String(coverageCall?.[0])).toContain('nodeId=7');
  });

  it('degrades to unknown on a plain network failure, and stays non-blocking', async () => {
    routeApi({ readiness: () => Promise.reject(new Error('connection refused')) });
    const props = setup();
    await waitFor(() => expect(screen.getByTestId('readiness-verdict')).toHaveAttribute('data-verdict', 'unknown'));
    expect(screen.getByText(/could not be reached/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('readiness-proceed'));
    await waitFor(() => expect(props.onProceed).toHaveBeenCalledTimes(1));
  });

  it('reports a timed-out readiness check as unknown after the 4s timer aborts it', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(apiFetch).mockImplementation((url: string, options?: RequestInit) => {
        if (String(url).includes('/update-readiness')) {
          return new Promise((_, reject) => {
            options?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')));
          });
        }
        return Promise.resolve(new Response(JSON.stringify({ latestAt: null }), { status: 200 }));
      });
      render(<UpdateReadinessDialog open stackName="web" nodeId={1} onCancel={vi.fn()} onProceed={vi.fn()} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(4_100); });
      expect(screen.getByTestId('readiness-verdict')).toHaveAttribute('data-verdict', 'unknown');
      expect(screen.getByText(/did not respond in time/)).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not paint a stale fallback verdict after closing mid-fetch and reopening', async () => {
    let call = 0;
    vi.mocked(apiFetch).mockImplementation((url: string, options?: RequestInit) => {
      const u = String(url);
      if (u.includes('/update-readiness')) {
        call += 1;
        if (call === 1) {
          // Hangs until the cleanup abort rejects it.
          return new Promise((_, reject) => {
            options?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')));
          });
        }
        return Promise.resolve(new Response(JSON.stringify(report('ready')), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ latestAt: null }), { status: 200 }));
    });

    const props = { stackName: 'web', nodeId: 1, onCancel: vi.fn(), onProceed: vi.fn() };
    const { rerender } = render(<UpdateReadinessDialog open {...props} />);
    rerender(<UpdateReadinessDialog open={false} {...props} />);
    rerender(<UpdateReadinessDialog open {...props} />);
    await waitFor(() => expect(screen.getByTestId('readiness-verdict')).toHaveAttribute('data-verdict', 'ready'));
  });

  it('marks a remote 502 as unreachable and unknown', async () => {
    routeApi({ readiness: () => Promise.resolve(new Response('Bad Gateway', { status: 502 })) });
    setup();
    await waitFor(() => expect(screen.getByTestId('readiness-verdict')).toHaveAttribute('data-verdict', 'unknown'));
    expect(screen.getByText(/may be unreachable/)).toBeInTheDocument();
  });

  it('invokes onProceed without a snapshot when the checkbox is unchecked', async () => {
    routeApi();
    const props = setup();
    await waitFor(() => expect(screen.getByTestId('readiness-verdict')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('readiness-proceed'));
    await waitFor(() => expect(props.onProceed).toHaveBeenCalledTimes(1));
    const snapshotPosts = vi.mocked(apiFetch).mock.calls.filter(
      c => String(c[0]) === '/fleet/snapshots' && (c[1] as { method?: string } | undefined)?.method === 'POST',
    );
    expect(snapshotPosts).toHaveLength(0);
  });

  it('creates a snapshot before proceeding when checked', async () => {
    routeApi();
    const props = setup();
    await waitFor(() => expect(screen.getByTestId('readiness-verdict')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Create a fleet snapshot before updating'));
    fireEvent.click(screen.getByTestId('readiness-proceed'));
    await waitFor(() => expect(props.onProceed).toHaveBeenCalledTimes(1));
    const snapshotPosts = vi.mocked(apiFetch).mock.calls.filter(
      c => String(c[0]) === '/fleet/snapshots' && (c[1] as { method?: string } | undefined)?.method === 'POST',
    );
    expect(snapshotPosts).toHaveLength(1);
  });

  it('halts the update when the pre-update snapshot fails', async () => {
    routeApi({ snapshot: () => Promise.resolve(new Response('{"error":"boom"}', { status: 500 })) });
    const props = setup();
    await waitFor(() => expect(screen.getByTestId('readiness-verdict')).toBeInTheDocument());
    fireEvent.click(screen.getByLabelText('Create a fleet snapshot before updating'));
    fireEvent.click(screen.getByTestId('readiness-proceed'));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(props.onProceed).not.toHaveBeenCalled();
  });

  it('hides the snapshot checkbox and coverage row from non-admins', async () => {
    authState.isAdmin = false;
    routeApi();
    setup();
    await waitFor(() => expect(screen.getByTestId('readiness-verdict')).toBeInTheDocument());
    expect(screen.queryByLabelText('Create a fleet snapshot before updating')).not.toBeInTheDocument();
    expect(screen.queryByText('Fleet snapshot')).not.toBeInTheDocument();
    const coverageCalls = vi.mocked(apiFetch).mock.calls.filter(c => String(c[0]).includes('/snapshots/coverage'));
    expect(coverageCalls).toHaveLength(0);
  });

  it('shows the hub snapshot coverage row for admins', async () => {
    routeApi({ coverage: () => Promise.resolve(new Response(JSON.stringify({ latestAt: Date.now() - 60_000 }), { status: 200 })) });
    setup();
    await waitFor(() => expect(screen.getByText('Fleet snapshot')).toBeInTheDocument());
    expect(screen.getByText(/most recent fleet snapshot/)).toBeInTheDocument();
  });

  it('wires Cancel', async () => {
    routeApi();
    const props = setup();
    await waitFor(() => expect(screen.getByTestId('readiness-verdict')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Cancel'));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  const policyReport = (over: Record<string, unknown> = {}) => ({
    stack: 'web',
    computedAt: Date.now(),
    verdict: 'ready',
    signals: [
      { id: 'preflight', status: 'ok', title: 'Compose Doctor', detail: 'The last preflight passed.', affectsVerdict: true },
      { id: 'update_policy', status: 'attention', title: 'Update policy', detail: 'This update is refused by io.sencho.update: "db" is set to disabled.', affectsVerdict: false },
    ],
    updatePolicy: {
      evaluation: 'evaluated',
      services: [
        { service: 'db', policy: 'disabled', eligible: false, reason: 'The service is set to disabled.' },
        { service: 'api', policy: 'default', eligible: true },
      ],
      manualDecision: 'block',
      unattendedDecision: 'skip',
      reason: '"db" is set to disabled.',
      ...over,
    },
  });

  it('renders the update-policy signal with the other signals', async () => {
    routeApi({ readiness: () => Promise.resolve(new Response(JSON.stringify(policyReport()), { status: 200 })) });
    setup();
    await waitFor(() => expect(screen.getByText('Update policy')).toBeInTheDocument());
    expect(screen.getByText(/refused by io.sencho.update/)).toBeInTheDocument();
  });

  it('disables Update and explains why when the policy blocks a manual update', async () => {
    routeApi({ readiness: () => Promise.resolve(new Response(JSON.stringify(policyReport()), { status: 200 })) });
    const props = setup();
    await waitFor(() => expect(screen.getByTestId('update-policy-blocked')).toBeInTheDocument());
    const proceed = screen.getByTestId('readiness-proceed');
    expect(proceed).toBeDisabled();
    expect(proceed.getAttribute('title')).toContain('"db" is set to disabled');
    fireEvent.click(proceed);
    expect(props.onProceed).not.toHaveBeenCalled();
  });

  it('offers Update for the eligible services only, through the shared handler', async () => {
    routeApi({ readiness: () => Promise.resolve(new Response(JSON.stringify(policyReport()), { status: 200 })) });
    const onProceedService = vi.fn();
    setup({ onProceedService });
    await waitFor(() => expect(screen.getByTestId('update-policy-service-api')).toBeInTheDocument());
    expect(screen.queryByTestId('update-policy-service-db')).toBeNull();
    fireEvent.click(screen.getByTestId('update-policy-service-api'));
    expect(onProceedService).toHaveBeenCalledWith('api');
  });

  it('offers the Compose file inside the editor, and the editor outside it', async () => {
    routeApi({ readiness: () => Promise.resolve(new Response(JSON.stringify(policyReport()), { status: 200 })) });
    const onOpenComposeFile = vi.fn();
    const inside = setup({ onOpenComposeFile });
    await waitFor(() => expect(screen.getByTestId('update-policy-open-compose')).toBeInTheDocument());
    expect(screen.getByTestId('update-policy-open-compose')).toHaveTextContent('Open Compose file');
    fireEvent.click(screen.getByTestId('update-policy-open-compose'));
    expect(onOpenComposeFile).toHaveBeenCalledTimes(1);
    expect(inside.onCancel).toHaveBeenCalledTimes(1);
  });

  it('names the editor as the destination when no Compose-file handler is mounted', async () => {
    routeApi({ readiness: () => Promise.resolve(new Response(JSON.stringify(policyReport()), { status: 200 })) });
    const props = setup();
    await waitFor(() => expect(screen.getByTestId('update-policy-open-compose')).toBeInTheDocument());
    expect(screen.getByTestId('update-policy-open-compose')).toHaveTextContent('Open stack editor');
    fireEvent.click(screen.getByTestId('update-policy-open-compose'));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('keeps Update enabled when the policy allows the update', async () => {
    routeApi({ readiness: () => Promise.resolve(new Response(JSON.stringify(policyReport({ manualDecision: 'allow', reason: null })), { status: 200 })) });
    setup();
    await waitFor(() => expect(screen.getByTestId('readiness-verdict')).toBeInTheDocument());
    expect(screen.getByTestId('readiness-proceed')).toBeEnabled();
    expect(screen.queryByTestId('update-policy-blocked')).toBeNull();
  });

  it('notes a node that does not evaluate the label only when the stack declares it', async () => {
    nodeMetaMap = new Map([[1, { version: '0.90.0', capabilities: [], fetchedAt: Date.now() }]]);
    routeApi({
      readiness: () => Promise.resolve(new Response(JSON.stringify(report('ready')), { status: 200 })),
      inventory: () => Promise.resolve(new Response(JSON.stringify({
        services: [{ service: 'web', declaredLabels: [{ key: 'io.sencho.update', value: 'manual', source: 'compose' }] }],
      }), { status: 200 })),
    });
    setup();
    expect(await screen.findByTestId('update-policy-unsupported')).toHaveTextContent('does not evaluate this label');
  });

  it('omits the note on an older node when the stack declares no io.sencho.update', async () => {
    nodeMetaMap = new Map([[1, { version: '0.90.0', capabilities: [], fetchedAt: Date.now() }]]);
    routeApi({
      inventory: () => Promise.resolve(new Response(JSON.stringify({
        services: [{ service: 'web', declaredLabels: [{ key: 'io.sencho.url', value: 'https://x.example.com', source: 'compose' }] }],
      }), { status: 200 })),
    });
    setup();
    await waitFor(() => expect(screen.getByTestId('readiness-verdict')).toBeInTheDocument());
    await waitFor(() => {
      const calls = vi.mocked(apiFetch).mock.calls.filter(c => String(c[0]).includes('/label-inventory'));
      expect(calls).toHaveLength(1);
    });
    expect(screen.queryByTestId('update-policy-unsupported')).toBeNull();
  });

  it('does not read the label inventory on a node that evaluates the policy', async () => {
    nodeMetaMap = new Map([[1, { version: '1.0.0', capabilities: ['sencho-label-policy-v1'], fetchedAt: Date.now() }]]);
    routeApi();
    setup();
    await waitFor(() => expect(screen.getByTestId('readiness-verdict')).toBeInTheDocument());
    const calls = vi.mocked(apiFetch).mock.calls.filter(c => String(c[0]).includes('/label-inventory'));
    expect(calls).toHaveLength(0);
  });
});
