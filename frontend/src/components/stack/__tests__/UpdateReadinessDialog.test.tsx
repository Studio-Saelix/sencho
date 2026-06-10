import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { UpdateReadinessDialog } from '../UpdateReadinessDialog';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const nodesState = { activeNode: { id: 1, type: 'local', name: 'local' } };
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => nodesState,
}));

const authState = { isAdmin: true };
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => authState,
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
} = {}) {
  vi.mocked(apiFetch).mockImplementation((url: string, options?: { method?: string }) => {
    const u = String(url);
    if (u.includes('/update-readiness')) {
      return (over.readiness ?? (() => Promise.resolve(new Response(JSON.stringify(report('ready')), { status: 200 }))))();
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
      render(<UpdateReadinessDialog open stackName="web" onCancel={vi.fn()} onProceed={vi.fn()} />);
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

    const props = { stackName: 'web', onCancel: vi.fn(), onProceed: vi.fn() };
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
});
