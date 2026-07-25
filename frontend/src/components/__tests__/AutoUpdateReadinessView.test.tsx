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
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({
    nodes: [{ id: 1, name: 'Local', type: 'local', status: 'online' }],
    nodeMeta: mockNodeMeta,
    refreshNodeMeta: mockRefreshNodeMeta,
  }),
}));

import { apiFetch, fetchForNode } from '@/lib/api';
import { requestServiceUpdate } from '@/lib/serviceUpdate';
import AutoUpdateReadinessView, { MobileReadinessCard, CadenceStrip, type StackCard } from '../AutoUpdateReadinessView';
import { isAuthoritativeNegativePreview } from '@/types/imageUpdates';

function card(over: Partial<StackCard> = {}): StackCard {
  return {
    stack: 'nextcloud',
    nodeId: 1,
    previewLoaded: true,
    applying: false,
    applyingService: null,
    autoUpdateEnabled: true,
    scheduledTask: null,
    preview: {
      stack_name: 'nextcloud',
      images: [{
        service: 'app', image: 'nextcloud:27.1.4', current_tag: '27.1.4', next_tag: '27.1.4',
        has_update: true, digest_update: true, tag_update: false, semver_bump: 'patch', check_status: 'ok',
      }],
      summary: {
        has_update: true,
        primary_image: 'nextcloud',
        current_tag: '27.1.4',
        next_tag: '27.1.4',
        semver_bump: 'patch',
        update_kind: 'digest',
        blocked: false,
        blocked_reason: null,
        check_status: 'ok',
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

it('disables Apply for tag-only advisory updates', () => {
  render(
    <MobileReadinessCard
      card={card({
        preview: {
          stack_name: 'nextcloud',
          images: [{
            service: 'app', image: 'nextcloud:27.1.4', current_tag: '27.1.4', next_tag: '27.1.5',
            has_update: true, digest_update: false, tag_update: true, semver_bump: 'patch', check_status: 'ok',
          }],
          summary: {
            has_update: true,
            primary_image: 'nextcloud',
            current_tag: '27.1.4',
            next_tag: '27.1.5',
            semver_bump: 'patch',
            update_kind: 'tag',
            blocked: false,
            blocked_reason: null,
            check_status: 'ok',
          },
          rollback_target: null,
          changelog: 'Fixes.',
        },
      })}
      onApply={vi.fn()}
    />,
  );
  expect(screen.getByText(/Newer tag/i)).toBeInTheDocument();
  expect(apply()).toBeDisabled();
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
            next_tag: '27.1.4',
            has_update: true,
            digest_update: true,
            tag_update: false,
            semver_bump: 'patch',
            check_status: 'ok',
          }],
          build_services: ['cron'],
          summary: {
            has_update: true,
            primary_image: 'nextcloud',
            current_tag: '27.1.4',
            next_tag: '27.1.5',
            semver_bump: 'patch',
            update_kind: 'digest',
            blocked: false,
            blocked_reason: null,
            has_build_services: true,
            check_status: 'ok',
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
          next_tag: '27.1.4',
          has_update: true,
          digest_update: true,
          tag_update: false,
          semver_bump: 'patch' as const,
          check_status: 'ok' as const,
        },
        {
          service: 'redis',
          image: 'redis:7',
          current_tag: '7.2',
          next_tag: '7.2',
          has_update: false,
          digest_update: false,
          tag_update: false,
          semver_bump: 'none' as const,
          check_status: 'ok' as const,
        },
      ],
      summary: {
        has_update: true,
        primary_image: 'nextcloud',
        current_tag: '27.1.4',
        next_tag: '27.1.4',
        semver_bump: 'patch' as const,
        update_kind: 'digest' as const,
        blocked: false,
        blocked_reason: null,
        check_status: 'ok' as const,
      },
      rollback_target: null,
      changelog: 'Fixes.',
    };
    const refreshedPreview = {
      ...multiPreview,
      images: multiPreview.images.map((img) => (
        img.service === 'app' ? { ...img, has_update: false, digest_update: false, current_tag: '27.1.4', next_tag: '27.1.4' } : img
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

describe('isAuthoritativeNegativePreview (Fleet card drop parity)', () => {
  it('drops when a checkable image has ok + no update', () => {
    expect(isAuthoritativeNegativePreview({
      images: [{ check_status: 'ok' }],
      summary: { has_update: false, check_status: 'ok' },
    })).toBe(true);
  });

  it('retains not_checkable-only negative previews', () => {
    expect(isAuthoritativeNegativePreview({
      images: [{ check_status: 'not_checkable' }],
      summary: { has_update: false, check_status: 'ok' },
    })).toBe(false);
  });

  it('clears when every image is ok even if summary check_status is omitted', () => {
    expect(isAuthoritativeNegativePreview({
      images: [{ check_status: 'ok' }],
      summary: { has_update: false },
    })).toBe(true);
  });

  it('retains when image check_status is missing', () => {
    expect(isAuthoritativeNegativePreview({
      images: [{}],
      summary: { has_update: false, check_status: 'ok' },
    })).toBe(false);
  });

  it('retains empty image lists even with ok summary', () => {
    expect(isAuthoritativeNegativePreview({
      images: [],
      summary: { has_update: false, check_status: 'ok' },
    })).toBe(false);
  });
});
