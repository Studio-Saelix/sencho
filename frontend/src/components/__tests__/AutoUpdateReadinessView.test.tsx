/**
 * MobileReadinessCard is the one-up phone card for the Updates readiness board.
 * Its Apply button must stay disabled when the update is blocked (major bump),
 * while in flight, or when no schedule covers the stack; enabled only when a
 * covering schedule exists and the preview loaded without a block.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), fetchForNode: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ nodes: [{ id: 1, name: 'Local', type: 'local', status: 'online' }] }),
}));

import { apiFetch } from '@/lib/api';
import AutoUpdateReadinessView, { MobileReadinessCard, CadenceStrip, type StackCard } from '../AutoUpdateReadinessView';

function card(over: Partial<StackCard> = {}): StackCard {
  return {
    stack: 'nextcloud',
    nodeId: 1,
    previewLoaded: true,
    applying: false,
    autoUpdateEnabled: true,
    scheduledTask: null,
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

it('enables Apply when a covering schedule exists and the update is not blocked', () => {
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

it('disables Apply when auto-update is off for the stack', () => {
  render(<MobileReadinessCard card={card({ autoUpdateEnabled: false })} onApply={vi.fn()} />);
  expect(apply()).toBeDisabled();
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
