/**
 * Loading and Recheck feedback on the Update page: the first load shows a
 * layout-matched skeleton only after the visual-busy delay, and Recheck locks
 * at once but turns its icon and changes its label only after that same delay.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), fetchForNode: vi.fn() }));
vi.mock('@/lib/serviceUpdate', () => ({ requestServiceUpdate: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => viewport.mobile }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('@/context/DeployFeedbackContext', () => ({
  useDeployFeedback: () => ({
    runWithLog: async (_params: unknown, fn: (started: Promise<void>, ds: string) => Promise<unknown>) =>
      fn(Promise.resolve(), 'test-session'),
  }),
}));
const mockNodeMeta = new Map<number, { capabilities: string[] }>();
const mockRefreshNodeMeta = vi.fn();
const mockNodes: { id: number; name: string; type: 'local' | 'remote'; status: string }[] = [
  { id: 1, name: 'Local', type: 'local', status: 'online' },
];
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ nodes: mockNodes, nodeMeta: mockNodeMeta, refreshNodeMeta: mockRefreshNodeMeta }),
}));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { DURATION_BASE_MS } from '@/hooks/useVisualBusy';
import AutoUpdateReadinessView from '../AutoUpdateReadinessView';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

type JsonResponse = { ok: boolean; json: () => Promise<unknown> };

function deferred() {
  let resolve!: (value: JsonResponse) => void;
  const promise = new Promise<JsonResponse>(r => { resolve = r; });
  return { promise, resolve };
}

const json = (body: unknown): JsonResponse => ({ ok: true, json: async () => body });

async function settle(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe('AutoUpdateReadinessView loading and recheck feedback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    viewport.mobile = false;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function route(
    fleet: Promise<JsonResponse>,
    refresh?: Promise<JsonResponse>,
    cadence: unknown = {},
  ) {
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') return fleet;
      if (url === '/image-updates/fleet/refresh' && refresh) return refresh;
      if (url === '/image-updates/status') return Promise.resolve(json(cadence));
      if (url.startsWith('/scheduled-tasks')) return Promise.resolve(json([]));
      return Promise.resolve(json({}));
    });
  }

  it('shows the skeleton only after the delay and removes it when the data lands', async () => {
    const fleet = deferred();
    route(fleet.promise);
    render(<AutoUpdateReadinessView />);

    await settle(DURATION_BASE_MS - 1);
    expect(screen.queryByTestId('readiness-skeleton')).toBeNull();

    await settle(1);
    const skeleton = screen.getByTestId('readiness-skeleton');
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status', { name: 'Loading readiness' })).toBe(skeleton);
    // The persisted default is the table, so the placeholder carries its column heads.
    expect(within(skeleton).getAllByRole('columnheader')).toHaveLength(8);
    expect(within(skeleton).getByText('Schedule')).toBeInTheDocument();
    expect(screen.queryByText(/Loading readiness\.\.\./)).toBeNull();

    await act(async () => { fleet.resolve(json({})); });
    await settle();
    expect(screen.queryByTestId('readiness-skeleton')).toBeNull();
  });

  it('never flashes the skeleton when the first answer is fast', async () => {
    const fleet = deferred();
    route(fleet.promise);
    render(<AutoUpdateReadinessView />);

    await settle(DURATION_BASE_MS - 1);
    await act(async () => { fleet.resolve(json({})); });
    await settle(DURATION_BASE_MS * 2);
    expect(screen.queryByTestId('readiness-skeleton')).toBeNull();
  });

  it('matches the card board when that view is the saved choice', async () => {
    window.localStorage.setItem('sencho-readiness-view', 'cards');
    route(deferred().promise);
    render(<AutoUpdateReadinessView />);

    await settle(DURATION_BASE_MS);
    const skeleton = screen.getByTestId('readiness-skeleton');
    expect(within(skeleton).queryByRole('columnheader')).toBeNull();
    expect(skeleton.querySelectorAll('.lg\\:grid-cols-2')).toHaveLength(1);
  });

  it('locks Recheck at once and turns its icon and label only after the delay', async () => {
    const refresh = deferred();
    route(Promise.resolve(json({})), refresh.promise);
    render(<AutoUpdateReadinessView />);
    await settle();

    const recheck = screen.getByRole('button', { name: 'Recheck registries' });
    const icon = recheck.querySelector('svg');
    expect(recheck).not.toHaveAttribute('aria-busy');
    expect(icon).not.toHaveClass('animate-spin');

    await act(async () => { fireEvent.click(recheck); });
    expect(recheck).toBeDisabled();
    expect(recheck).toHaveAttribute('aria-busy', 'true');
    expect(icon).not.toHaveClass('animate-spin');
    expect(screen.getByText('Recheck')).not.toHaveClass('invisible');
    expect(screen.getByText('Rechecking...')).toHaveClass('invisible');

    await settle(DURATION_BASE_MS);
    expect(icon).toHaveClass('animate-spin');
    const busyLabel = screen.getByText('Rechecking...');
    expect(busyLabel).not.toHaveClass('invisible');
    expect(screen.getByText('Recheck')).toHaveClass('invisible');

    await act(async () => {
      refresh.resolve(json({ triggered: [1], rateLimited: [], failed: [] }));
    });
    await settle();
    expect(recheck).not.toBeDisabled();
    expect(recheck).not.toHaveAttribute('aria-busy');
    expect(icon).not.toHaveClass('animate-spin');
    expect(screen.getByText('Rechecking...')).toHaveClass('invisible');
  });

  it('does not flash busy chrome when the recheck request is fast', async () => {
    const refresh = deferred();
    route(Promise.resolve(json({})), refresh.promise);
    render(<AutoUpdateReadinessView />);
    await settle();

    const recheck = screen.getByRole('button', { name: 'Recheck registries' });
    const icon = recheck.querySelector('svg');
    await act(async () => { fireEvent.click(recheck); });
    await settle(DURATION_BASE_MS - 1);
    expect(icon).not.toHaveClass('animate-spin');
    expect(screen.getByText('Recheck')).not.toHaveClass('invisible');
    expect(screen.getByText('Rechecking...')).toHaveClass('invisible');
    await act(async () => {
      refresh.resolve(json({ triggered: [1], rateLimited: [], failed: [] }));
    });
    await settle(DURATION_BASE_MS * 2);
    expect(icon).not.toHaveClass('animate-spin');
    expect(screen.getByText('Rechecking...')).toHaveClass('invisible');
  });

  it('unlocks Recheck and clears the busy chrome when the request is refused', async () => {
    const refresh = deferred();
    route(Promise.resolve(json({})), refresh.promise);
    render(<AutoUpdateReadinessView />);
    await settle();

    const recheck = screen.getByRole('button', { name: 'Recheck registries' });
    const icon = recheck.querySelector('svg');
    await act(async () => { fireEvent.click(recheck); });
    await settle(DURATION_BASE_MS);
    expect(icon).toHaveClass('animate-spin');

    await act(async () => { refresh.resolve({ ok: false, json: async () => ({}) }); });
    await settle();
    expect(toast.error).toHaveBeenCalledWith('Failed to trigger refresh');
    expect(recheck).not.toBeDisabled();
    expect(recheck).not.toHaveAttribute('aria-busy');
    expect(icon).not.toHaveClass('animate-spin');
  });

  describe('on a phone', () => {
    beforeEach(() => { viewport.mobile = true; });

    it('shows the phone card skeleton only after the delay', async () => {
      const fleet = deferred();
      route(fleet.promise);
      render(<AutoUpdateReadinessView />);

      await settle(DURATION_BASE_MS - 1);
      expect(screen.queryByTestId('readiness-skeleton')).toBeNull();

      await settle(1);
      const skeleton = screen.getByRole('status', { name: 'Loading readiness' });
      expect(within(skeleton).queryByRole('columnheader')).toBeNull();
      expect(skeleton.querySelectorAll('.lg\\:grid-cols-2')).toHaveLength(0);

      await act(async () => { fleet.resolve(json({})); });
      await settle();
      expect(screen.queryByTestId('readiness-skeleton')).toBeNull();
    });

    it('keeps the compact Recheck locked at once and busy only after the delay', async () => {
      const refresh = deferred();
      route(Promise.resolve(json({})), refresh.promise);
      render(<AutoUpdateReadinessView />);
      await settle();

      const recheck = screen.getByRole('button', { name: 'Recheck registries' });
      const icon = recheck.querySelector('svg');
      expect(icon).toHaveClass('h-3.5');
      await act(async () => { fireEvent.click(recheck); });
      expect(recheck).toBeDisabled();
      expect(icon).not.toHaveClass('animate-spin');
      expect(screen.getByText('Recheck')).not.toHaveClass('invisible');
      expect(screen.getByText('Rechecking...')).toHaveClass('invisible');

      await settle(DURATION_BASE_MS);
      expect(icon).toHaveClass('animate-spin');
      expect(screen.getByText('Rechecking...')).not.toHaveClass('invisible');
    });

    it('leaves Recheck disabled while image update detection is off', async () => {
      route(Promise.resolve(json({})), undefined, {
        enabled: false,
        checking: false,
        intervalMinutes: 120,
        lastCheckedAt: null,
        nextCheckAt: null,
        manualCooldownMinutes: 2,
        manualCooldownRemainingMs: 0,
      });
      render(<AutoUpdateReadinessView />);
      await settle();

      expect(screen.getByRole('button', { name: 'Recheck registries' })).toBeDisabled();
    });
  });
});
