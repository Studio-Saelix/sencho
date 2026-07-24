/**
 * MobileReadinessCard is the one-up phone card for the Updates readiness board.
 * Its Apply button is disabled only when the update is blocked (major bump) or
 * already in flight; manual apply works regardless of schedule. The Auto: Off
 * pill still reflects the absence of a covering auto-update schedule.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), fetchForNode: vi.fn() }));
vi.mock('@/lib/serviceUpdate', () => ({
  requestServiceUpdate: vi.fn(),
}));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/context/DeployFeedbackContext', () => ({
  useDeployFeedback: () => ({
    runWithLog: async (_params: unknown, fn: (started: Promise<void>, ds: string) => Promise<unknown>) =>
      fn(Promise.resolve(), 'test-session'),
  }),
}));
// nodeMeta/refreshNodeMeta must be stable across renders (matching the real
// NodeContext), or a fresh Map/fn on every useNodes() call churns the
// loadReadiness useCallback identity and re-triggers its effect forever.
const mockNodeMeta = new Map();
const mockRefreshNodeMeta = vi.fn();
const mockNodes: Array<{ id: number; name: string; type: string; status: string }> = [
  { id: 1, name: 'Local', type: 'local', status: 'online' },
];
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({
    nodes: mockNodes,
    nodeMeta: mockNodeMeta,
    refreshNodeMeta: mockRefreshNodeMeta,
  }),
}));

import { apiFetch, fetchForNode } from '@/lib/api';
import { requestServiceUpdate } from '@/lib/serviceUpdate';
import { toast } from '@/components/ui/toast-store';
import AutoUpdateReadinessView, { MobileReadinessCard, CadenceStrip, type StackCard } from '../AutoUpdateReadinessView';

function card(over: Partial<StackCard> = {}): StackCard {
  return {
    stack: 'nextcloud',
    nodeId: 1,
    previewLoaded: true,
    applying: false,
    applyingService: null,
    autoUpdateEnabled: true,
    scheduledTask: null,
    verificationNote: null,
    preview: {
      stack_name: 'nextcloud',
      images: [],
      summary: {
        has_update: true,
        primary_image: 'nextcloud',
        current_tag: '27.1.4',
        next_tag: '27.1.5',
        semver_bump: 'patch',
        update_kind: 'tag',
        blocked: false,
        blocked_reason: null,
      },
      rollback_target: null,
      changelog: 'Fixes. Security patch.',
    },
    ...over,
  };
}

const apply = () => screen.getByRole('button', { name: /Apply now/i });

it('enables Apply for a safe, non-blocked update', () => {
  render(<MobileReadinessCard card={card()} onApply={vi.fn()} />);
  expect(apply()).toBeEnabled();
});

it('disables Apply when the update is blocked (major bump)', () => {
  render(
    <MobileReadinessCard
      card={card({
        preview: {
          stack_name: 'gitea', images: [], rollback_target: null, changelog: 'Breaking.',
          summary: {
            has_update: true, primary_image: 'gitea', current_tag: '1.21', next_tag: '1.22',
            semver_bump: 'major', update_kind: 'tag', blocked: true, blocked_reason: 'Major version bump',
          },
        },
      })}
      onApply={vi.fn()}
    />,
  );
  expect(apply()).toBeDisabled();
});

it('disables Apply while an update is in flight', () => {
  render(<MobileReadinessCard card={card({ applying: true })} onApply={vi.fn()} />);
  // While applying the button label switches to "Applying...".
  expect(screen.getByRole('button', { name: /Applying/i })).toBeDisabled();
});

it('enables Apply when no schedule covers the stack', () => {
  render(<MobileReadinessCard card={card({ autoUpdateEnabled: false })} onApply={vi.fn()} />);
  expect(apply()).toBeEnabled();
});

it('offers per-service Apply when build-only companions make the stack multi-service', () => {
  const onApplyService = vi.fn();
  render(
    <MobileReadinessCard
      canServiceUpdate
      onApply={vi.fn()}
      onApplyService={onApplyService}
      card={card({
        preview: {
          stack_name: 'nextcloud',
          images: [{
            service: 'app',
            image: 'nextcloud:27',
            current_tag: '27.1.4',
            next_tag: '27.1.5',
            has_update: true,
            semver_bump: 'patch',
          }],
          build_services: ['cron'],
          summary: {
            has_update: true,
            primary_image: 'nextcloud',
            current_tag: '27.1.4',
            next_tag: '27.1.5',
            semver_bump: 'patch',
            update_kind: 'tag',
            blocked: false,
            blocked_reason: null,
            has_build_services: true,
          },
          rollback_target: null,
          changelog: 'Fixes.',
        },
      })}
    />,
  );
  const serviceApply = screen.getByRole('button', { name: /^Apply$/i });
  expect(serviceApply).toBeEnabled();
  fireEvent.click(serviceApply);
  expect(onApplyService).toHaveBeenCalledWith('nextcloud', 1, 'app');
});

/**
 * The desktop StackReadinessCard is not exported, so its Apply-now gating is
 * covered through a full-view render (useIsMobile is mocked false). A safe
 * update with no covering schedule must still offer an enabled Apply now: the
 * button is manual and schedule-independent, while the Auto: Off pill keeps
 * reflecting the missing schedule.
 */
describe('AutoUpdateReadinessView desktop Apply now', () => {
  const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
  const mockedFetchForNode = fetchForNode as unknown as ReturnType<typeof vi.fn>;

  afterEach(() => {
    mockedFetch.mockReset();
    mockedFetchForNode.mockReset();
    mockNodeMeta.clear();
    vi.mocked(requestServiceUpdate).mockReset();
    vi.mocked(toast.info).mockReset();
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.error).mockReset();
    vi.mocked(toast.loading).mockReset();
    vi.mocked(toast.dismiss).mockReset();
    mockNodes.splice(0, mockNodes.length, { id: 1, name: 'Local', type: 'local', status: 'online' });
  });

  it('enables Apply for a safe update with no covering schedule', async () => {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') {
        return Promise.resolve({ ok: true, json: async () => ({ '1': { nextcloud: true } }) });
      }
      if (url.startsWith('/scheduled-tasks')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    mockedFetchForNode.mockResolvedValue({ ok: true, json: async () => card().preview });

    render(<AutoUpdateReadinessView />);

    const applyBtn = await screen.findByRole('button', { name: /Apply now/i });
    expect(applyBtn).toBeEnabled();
    // A non-blocked card carries no title at all; the old schedule tooltip is gone.
    expect(applyBtn).not.toHaveAttribute('title');
    expect(screen.getByText(/Auto: Off/)).toBeInTheDocument();
    // The stack is enabled to apply manually but must NOT count as "ready to
    // apply automatically": that still requires a covering schedule.
    expect(screen.getByText(/0 of 1 ready to apply automatically/)).toBeInTheDocument();
  });

  it('applies a single service and refreshes the authoritative update preview', async () => {
    mockNodeMeta.set(1, {
      version: '1.0.0',
      capabilities: ['service-scoped-update'],
      fetchedAt: Date.now(),
    });
    const multiPreview = {
      stack_name: 'nextcloud',
      images: [
        {
          service: 'app',
          image: 'nextcloud:27',
          current_tag: '27.1.4',
          next_tag: '27.1.5',
          has_update: true,
          semver_bump: 'patch' as const,
        },
        {
          service: 'redis',
          image: 'redis:7',
          current_tag: '7.2',
          next_tag: '7.2',
          has_update: false,
          semver_bump: 'none' as const,
        },
      ],
      summary: {
        has_update: true,
        primary_image: 'nextcloud',
        current_tag: '27.1.4',
        next_tag: '27.1.5',
        semver_bump: 'patch' as const,
        update_kind: 'tag' as const,
        blocked: false,
        blocked_reason: null,
      },
      rollback_target: null,
      changelog: 'Fixes.',
    };
    const refreshedPreview = {
      ...multiPreview,
      images: multiPreview.images.map((img) => (
        img.service === 'app' ? { ...img, has_update: false, current_tag: '27.1.5', next_tag: '27.1.5' } : img
      )),
      summary: { ...multiPreview.summary, has_update: false, current_tag: '27.1.5' },
    };
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') {
        return Promise.resolve({ ok: true, json: async () => ({ '1': { nextcloud: true } }) });
      }
      if (url.startsWith('/scheduled-tasks')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    mockedFetchForNode.mockImplementation((url: string) => {
      if (String(url).includes('/update-preview')) {
        const call = mockedFetchForNode.mock.calls.filter((c) => String(c[0]).includes('/update-preview')).length;
        return Promise.resolve({
          ok: true,
          json: async () => (call <= 1 ? multiPreview : refreshedPreview),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    vi.mocked(requestServiceUpdate).mockResolvedValue({
      ok: true,
      mode: 'update',
      serviceName: 'app',
      healthGateId: null,
      observing: false,
      recoveryId: null,
      recoveryAvailable: false,
    });

    render(<AutoUpdateReadinessView />);
    const serviceApply = await screen.findByRole('button', { name: /^Apply$/i });
    await act(async () => { fireEvent.click(serviceApply); });

    await waitFor(() => {
      expect(requestServiceUpdate).toHaveBeenCalledWith(expect.objectContaining({
        stackName: 'nextcloud',
        serviceName: 'app',
        mode: 'update',
      }));
    });
    await waitFor(() => {
      expect(mockedFetchForNode.mock.calls.filter((c) => String(c[0]).includes('/update-preview')).length).toBeGreaterThanOrEqual(2);
    });
  });

  const basePreview = {
    stack_name: 'nextcloud',
    images: [{
      service: 'app',
      image: 'nextcloud:27',
      current_tag: '27.1.4',
      next_tag: '27.1.5',
      has_update: true,
      semver_bump: 'patch' as const,
    }],
    summary: {
      has_update: true,
      primary_image: 'nextcloud',
      current_tag: '27.1.4',
      next_tag: '27.1.5',
      semver_bump: 'patch' as const,
      update_kind: 'tag' as const,
      blocked: false,
      blocked_reason: null,
    },
    rollback_target: null,
    changelog: 'Fixes.',
  };

  function mockFleetLoad(fleetMap: Record<string, Record<string, boolean>>) {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') {
        return Promise.resolve({ ok: true, json: async () => fleetMap });
      }
      if (url.startsWith('/scheduled-tasks')) {
        return Promise.resolve({ ok: true, json: async () => [] });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
  }

  it('removes the card only after a cleared preview with no recheckWarning', async () => {
    mockFleetLoad({ '1': { nextcloud: true } });
    const cleared = {
      ...basePreview,
      images: basePreview.images.map((img) => ({ ...img, has_update: false, current_tag: '27.1.5', next_tag: '27.1.5' })),
      summary: { ...basePreview.summary, has_update: false, current_tag: '27.1.5' },
    };
    mockedFetchForNode.mockImplementation((url: string, _nodeId?: number, init?: { method?: string }) => {
      if (String(url).includes('/update') && !String(url).includes('update-preview') && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ status: 'Update completed' }) });
      }
      if (String(url).includes('/update-preview')) {
        const previewCalls = mockedFetchForNode.mock.calls.filter((c) => String(c[0]).includes('/update-preview')).length;
        return Promise.resolve({
          ok: true,
          json: async () => (previewCalls <= 1 ? basePreview : cleared),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<AutoUpdateReadinessView />);
    const applyBtn = await screen.findByRole('button', { name: /Apply now/i });
    await act(async () => { fireEvent.click(applyBtn); });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Apply now/i })).not.toBeInTheDocument();
    });
    const postIdx = mockedFetchForNode.mock.calls.findIndex(
      (c) => String(c[0]).includes('/stacks/nextcloud/update') && !String(c[0]).includes('update-preview'),
    );
    const previewAfter = mockedFetchForNode.mock.calls.findIndex(
      (c, i) => i > postIdx && String(c[0]).includes('/update-preview'),
    );
    expect(postIdx).toBeGreaterThanOrEqual(0);
    expect(previewAfter).toBeGreaterThan(postIdx);
    expect(mockedFetchForNode.mock.calls[postIdx][1]).toBe(1);
    expect(mockedFetchForNode.mock.calls[previewAfter][1]).toBe(1);
  });

  it('retains the card and warns when the preview still reports an update', async () => {
    mockFleetLoad({ '1': { nextcloud: true } });
    mockedFetchForNode.mockImplementation((url: string, _nodeId?: number, init?: { method?: string }) => {
      if (String(url).includes('/update') && !String(url).includes('update-preview') && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ status: 'Update completed' }) });
      }
      if (String(url).includes('/update-preview')) {
        return Promise.resolve({ ok: true, json: async () => basePreview });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<AutoUpdateReadinessView />);
    const applyBtn = await screen.findByRole('button', { name: /Apply now/i });
    await act(async () => { fireEvent.click(applyBtn); });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Apply now/i })).toBeEnabled();
    });
    expect(toast.info).toHaveBeenCalledWith(
      'The update command completed, but Sencho still detects an available image update.',
    );
  });

  it('retains an unknown card when recheckWarning disagrees with a cleared preview', async () => {
    mockFleetLoad({ '1': { nextcloud: true } });
    const cleared = {
      ...basePreview,
      summary: { ...basePreview.summary, has_update: false, current_tag: '27.1.5' },
    };
    mockedFetchForNode.mockImplementation((url: string, _nodeId?: number, init?: { method?: string }) => {
      if (String(url).includes('/update') && !String(url).includes('update-preview') && init?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            status: 'Update completed',
            recheckWarning: 'The update command completed, but Sencho still detects an available image update.',
          }),
        });
      }
      if (String(url).includes('/update-preview')) {
        const previewCalls = mockedFetchForNode.mock.calls.filter((c) => String(c[0]).includes('/update-preview')).length;
        return Promise.resolve({
          ok: true,
          json: async () => (previewCalls <= 1 ? basePreview : cleared),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<AutoUpdateReadinessView />);
    const applyBtn = await screen.findByRole('button', { name: /Apply now/i });
    await act(async () => { fireEvent.click(applyBtn); });

    await waitFor(() => {
      expect(screen.getByText(
        'The update command completed, but Sencho still detects an available image update.',
      )).toBeInTheDocument();
    });
    expect(screen.getByText('nextcloud')).toBeInTheDocument();
    expect(screen.queryByText(/Preview failed/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply now/i })).not.toBeInTheDocument();
    expect(toast.info).toHaveBeenCalledWith(
      'The update command completed, but Sencho still detects an available image update.',
    );
  });

  it('retains an unknown card when the post-Apply preview request fails', async () => {
    mockFleetLoad({ '1': { nextcloud: true } });
    mockedFetchForNode.mockImplementation((url: string, _nodeId?: number, init?: { method?: string }) => {
      if (String(url).includes('/update') && !String(url).includes('update-preview') && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ status: 'Update completed' }) });
      }
      if (String(url).includes('/update-preview')) {
        const previewCalls = mockedFetchForNode.mock.calls.filter((c) => String(c[0]).includes('/update-preview')).length;
        if (previewCalls <= 1) {
          return Promise.resolve({ ok: true, json: async () => basePreview });
        }
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<AutoUpdateReadinessView />);
    const applyBtn = await screen.findByRole('button', { name: /Apply now/i });
    await act(async () => { fireEvent.click(applyBtn); });

    await waitFor(() => {
      expect(screen.getByText(/Preview failed/i)).toBeInTheDocument();
    });
    expect(screen.getByText('nextcloud')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply now/i })).not.toBeInTheDocument();
  });

  it('pins full-stack Apply POST and preview to a remote card nodeId', async () => {
    mockNodes.splice(0, mockNodes.length,
      { id: 1, name: 'Local', type: 'local', status: 'online' },
      { id: 2, name: 'Remote', type: 'remote', status: 'online' },
    );
    mockFleetLoad({ '2': { nextcloud: true } });
    const cleared = {
      ...basePreview,
      summary: { ...basePreview.summary, has_update: false, current_tag: '27.1.5' },
    };
    mockedFetchForNode.mockImplementation((url: string, _nodeId?: number, init?: { method?: string }) => {
      if (String(url).includes('/update') && !String(url).includes('update-preview') && init?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ status: 'Update completed' }) });
      }
      if (String(url).includes('/update-preview')) {
        const previewCalls = mockedFetchForNode.mock.calls.filter((c) => String(c[0]).includes('/update-preview')).length;
        return Promise.resolve({
          ok: true,
          json: async () => (previewCalls <= 1 ? basePreview : cleared),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<AutoUpdateReadinessView />);
    const applyBtn = await screen.findByRole('button', { name: /Apply now/i });
    await act(async () => { fireEvent.click(applyBtn); });

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /Apply now/i })).not.toBeInTheDocument();
    });
    const postCall = mockedFetchForNode.mock.calls.find(
      (c) => String(c[0]).includes('/stacks/nextcloud/update') && !String(c[0]).includes('update-preview'),
    );
    const postApplyPreview = mockedFetchForNode.mock.calls.filter(
      (c) => String(c[0]).includes('/update-preview') && c[1] === 2,
    );
    expect(postCall?.[1]).toBe(2);
    expect(postApplyPreview.length).toBeGreaterThanOrEqual(2);
    mockNodes.splice(0, mockNodes.length, { id: 1, name: 'Local', type: 'local', status: 'online' });
  });
});

/**
 * Local-node stacks whose latest check could not determine status never appear
 * in the card grid (which lists confirmed updates only), so the readiness view
 * surfaces them in a "could not be checked" advisory fed by a parallel local
 * /image-updates/detail fetch.
 */
describe('AutoUpdateReadinessView check-failed advisory', () => {
  const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
  const mockedFetchForNode = fetchForNode as unknown as ReturnType<typeof vi.fn>;

  afterEach(() => {
    mockedFetch.mockReset();
    mockedFetchForNode.mockReset();
  });

  it('lists local stacks whose check failed, with the reason', async () => {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') return Promise.resolve({ ok: true, json: async () => ({}) });
      if (url.startsWith('/scheduled-tasks')) return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/image-updates/detail') {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            grafana: { hasUpdate: false, checkStatus: 'failed', lastError: 'Registry unreachable for ghcr.io/acme/grafana:latest', checkedAt: 1 },
            web: { hasUpdate: false, checkStatus: 'ok', lastError: null, checkedAt: 1 },
          }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    mockedFetchForNode.mockResolvedValue({ ok: true, json: async () => null });

    render(<AutoUpdateReadinessView />);

    expect(await screen.findByText(/could not be checked/i)).toBeInTheDocument();
    expect(screen.getByText('grafana')).toBeInTheDocument();
    expect(screen.getByText(/Registry unreachable for ghcr.io\/acme\/grafana:latest/)).toBeInTheDocument();
    // An ok stack with no update must not appear in the advisory.
    expect(screen.queryByText('web')).toBeNull();
  });
});

/**
 * CadenceStrip surfaces the control instance's detection cadence by the
 * readiness card: a past last-check must read as an "ago" value (not the
 * future-oriented "due now"), null timestamps read as never/not-scheduled, and
 * the manual-recheck cooldown ticks down to "Recheck ready".
 */
describe('CadenceStrip', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a past last-check as an "ago" value, not "due now"', () => {
    const cadence = {
      checking: false,
      intervalMinutes: 120,
      lastCheckedAt: Date.now() - 10 * 60 * 1000,
      nextCheckAt: Date.now() + 110 * 60 * 1000,
      manualCooldownMinutes: 2,
      manualCooldownRemainingMs: 0,
      mode: 'interval' as const,
      cronExpression: null,
    };
    render(<CadenceStrip cadence={cadence} />);
    expect(screen.getByText(/Last checked 10m ago/)).toBeInTheDocument();
    expect(screen.queryByText(/due now/)).not.toBeInTheDocument();
    expect(screen.getByText(/Recheck ready/)).toBeInTheDocument();
  });

  it('renders null timestamps as never / not scheduled', () => {
    const cadence = {
      checking: false,
      intervalMinutes: 120,
      lastCheckedAt: null,
      nextCheckAt: null,
      manualCooldownMinutes: 2,
      manualCooldownRemainingMs: 0,
      mode: 'interval' as const,
      cronExpression: null,
    };
    render(<CadenceStrip cadence={cadence} />);
    expect(screen.getByText(/Last checked never/)).toBeInTheDocument();
    expect(screen.getByText(/Next check not scheduled/)).toBeInTheDocument();
  });

  it('counts the manual-recheck cooldown down to "Recheck ready"', () => {
    vi.useFakeTimers();
    const cadence = {
      checking: false,
      intervalMinutes: 120,
      lastCheckedAt: Date.now(),
      nextCheckAt: Date.now() + 7_200_000,
      manualCooldownMinutes: 2,
      manualCooldownRemainingMs: 3000,
      mode: 'interval' as const,
      cronExpression: null,
    };
    render(<CadenceStrip cadence={cadence} />);
    expect(screen.getByText(/Recheck available in 3s/)).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.getByText(/Recheck ready/)).toBeInTheDocument();
  });
});

/**
 * The cadence fetch runs on mount AND after a Recheck. A slow initial /status
 * response that resolves after the recheck-triggered one must not overwrite the
 * fresh cooldown the recheck just loaded.
 */
describe('AutoUpdateReadinessView cadence fetch race', () => {
  const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

  afterEach(() => {
    vi.clearAllMocks();
  });

  function statusDeferred() {
    let resolveWith!: (manualCooldownRemainingMs: number) => void;
    const promise = new Promise<{ ok: true; json: () => Promise<unknown> }>((resolve) => {
      resolveWith = (manualCooldownRemainingMs: number) =>
        resolve({
          ok: true,
          json: async () => ({
            checking: false,
            intervalMinutes: 120,
            lastCheckedAt: Date.now() - 60_000,
            nextCheckAt: Date.now() + 3_600_000,
            manualCooldownMinutes: 2,
            manualCooldownRemainingMs,
          }),
        });
    });
    return { promise, resolveWith };
  }

  it('drops a stale /status response so a recheck cooldown is not overwritten', async () => {
    const statusCalls: ReturnType<typeof statusDeferred>[] = [];
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') return Promise.resolve({ ok: true, json: async () => ({}) });
      if (url.startsWith('/scheduled-tasks')) return Promise.resolve({ ok: true, json: async () => [] });
      if (url === '/image-updates/fleet/refresh') {
        return Promise.resolve({ ok: true, json: async () => ({ triggered: [1], rateLimited: [], failed: [] }) });
      }
      if (url === '/image-updates/status') {
        const d = statusDeferred();
        statusCalls.push(d);
        return d.promise;
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<AutoUpdateReadinessView />);

    // Mount fired the first /status (A); it stays pending. The hero renders once
    // the readiness load settles.
    const recheck = await screen.findByRole('button', { name: /recheck registries/i });
    expect(statusCalls).toHaveLength(1);

    // Recheck fires a second /status (B); resolve it with an active cooldown.
    await act(async () => { fireEvent.click(recheck); });
    await waitFor(() => expect(statusCalls).toHaveLength(2));
    await act(async () => { statusCalls[1].resolveWith(120_000); });
    await screen.findByText(/Recheck available in/);

    // The slow initial load (A) resolves last with no cooldown. The token guard
    // must drop it so the strip keeps showing the recheck cooldown.
    await act(async () => {
      statusCalls[0].resolveWith(0);
      await Promise.resolve();
    });

    expect(screen.queryByText(/Recheck ready/)).toBeNull();
    expect(screen.getByText(/Recheck available in/)).toBeInTheDocument();
  });
});
