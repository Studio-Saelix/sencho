/**
 * Loading and Recheck feedback on the Update page: the first load shows a
 * layout-matched skeleton only after the visual-busy delay, and Recheck locks
 * at once but turns its icon and changes its label only after that same delay.
 * The skeleton belongs to the first load only (later slow reloads keep what is
 * shown), and the desktop hero holds the busy label's width in an inert copy.
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
type MockNode = { id: number; name: string; type: 'local' | 'remote'; status: string };
const LOCAL_ONLY: MockNode[] = [{ id: 1, name: 'Local', type: 'local', status: 'online' }];
const nodeState = vi.hoisted(() => ({ list: [] as MockNode[] }));
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ nodes: nodeState.list, nodeMeta: mockNodeMeta, refreshNodeMeta: mockRefreshNodeMeta }),
}));

import { apiFetch, fetchForNode } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { DURATION_BASE_MS } from '@/hooks/useVisualBusy';
import AutoUpdateReadinessView from '../AutoUpdateReadinessView';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedFetchForNode = fetchForNode as unknown as ReturnType<typeof vi.fn>;

type JsonResponse = { ok: boolean; json: () => Promise<unknown> };

function deferred() {
  let resolve!: (value: JsonResponse) => void;
  const promise = new Promise<JsonResponse>(r => { resolve = r; });
  return { promise, resolve };
}

const IDLE_LABEL = /^Recheck$/;
const BUSY_LABEL = /^Rechecking\.\.\.$/;
const EMPTY_STATE = 'All stacks on current builds';
// handleRefresh reloads the list this long after a Recheck request.
const RELOAD_AFTER_RECHECK_MS = 2500;

const json = (body: unknown): JsonResponse => ({ ok: true, json: async () => body });

async function settle(ms = 0) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

describe('AutoUpdateReadinessView loading and recheck feedback', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    window.localStorage.clear();
    viewport.mobile = false;
    nodeState.list = LOCAL_ONLY;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  let fleetCalls = () => 0;

  // `fleet` is one answer for every call, or one answer per call (the last repeats).
  function route(
    fleet: Promise<JsonResponse> | Promise<JsonResponse>[],
    refresh?: Promise<JsonResponse>,
    cadence: unknown = {},
  ) {
    const fleets = Array.isArray(fleet) ? fleet : [fleet];
    let calls = 0;
    fleetCalls = () => calls;
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') return fleets[Math.min(calls++, fleets.length - 1)];
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
    expect(recheck).toHaveTextContent(IDLE_LABEL);

    await settle(DURATION_BASE_MS);
    expect(icon).toHaveClass('animate-spin');
    expect(recheck).toHaveTextContent(BUSY_LABEL);

    await act(async () => {
      refresh.resolve(json({ triggered: [1], rateLimited: [], failed: [] }));
    });
    await settle();
    expect(recheck).not.toBeDisabled();
    expect(recheck).not.toHaveAttribute('aria-busy');
    expect(icon).not.toHaveClass('animate-spin');
    expect(recheck).toHaveTextContent(IDLE_LABEL);
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
    expect(recheck).toHaveTextContent(IDLE_LABEL);
    await act(async () => {
      refresh.resolve(json({ triggered: [1], rateLimited: [], failed: [] }));
    });
    await settle(DURATION_BASE_MS * 2);
    expect(icon).not.toHaveClass('animate-spin');
    expect(recheck).toHaveTextContent(IDLE_LABEL);
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

  it('keeps the idle desktop Recheck at its natural size and holds the busy width in an inert copy', async () => {
    route(Promise.resolve(json({})));
    render(<AutoUpdateReadinessView />);
    await settle();

    const recheck = screen.getByRole('button', { name: 'Recheck registries' });
    // The button itself carries only the current label (jsdom has no layout, so this pins the
    // structure: the idle button holds no hidden busy label that would widen it).
    expect(recheck).toHaveTextContent(IDLE_LABEL);
    expect(recheck.textContent).not.toContain('Rechecking');
    // The busy label's width is held beside it by a copy nobody can reach or hear.
    const holder = screen.getByTestId('recheck-width-holder');
    expect(holder).toHaveTextContent(BUSY_LABEL);
    expect(holder).toHaveAttribute('aria-hidden', 'true');
    expect(holder).toBeDisabled();
    expect(holder).toHaveAttribute('tabindex', '-1');
    expect(holder).toHaveClass('invisible');
    expect(screen.getAllByRole('button', { name: /recheck/i })).toEqual([recheck]);
    // Both sit in one grid cell, the button at the end, so the row keeps the busy width.
    expect(recheck.parentElement).toBe(holder.parentElement);
    expect(holder.parentElement).toHaveClass('inline-grid');
    expect(holder).toHaveClass('col-start-1', 'row-start-1');
    expect(recheck).toHaveClass('col-start-1', 'row-start-1', 'justify-self-end');
  });

  it('shows no skeleton on a slow reload after the first load settled empty', async () => {
    const reload = deferred();
    const refresh = deferred();
    route([Promise.resolve(json({})), reload.promise], refresh.promise);
    render(<AutoUpdateReadinessView />);
    await settle();
    expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Recheck registries' })); });
    await act(async () => {
      refresh.resolve(json({ triggered: [1], rateLimited: [], failed: [] }));
    });
    // The reload is in flight and slower than the delay: the settled empty state stays.
    await settle(RELOAD_AFTER_RECHECK_MS + DURATION_BASE_MS * 3);
    expect(fleetCalls()).toBe(2);
    expect(screen.queryByTestId('readiness-skeleton')).toBeNull();
    expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument();

    await act(async () => { reload.resolve(json({})); });
    await settle();
    expect(screen.queryByTestId('readiness-skeleton')).toBeNull();
    expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument();
  });

  it('shows no skeleton on a slow reload after the first load failed', async () => {
    const reload = deferred();
    const refresh = deferred();
    route([Promise.resolve({ ok: false, json: async () => ({}) }), reload.promise], refresh.promise);
    render(<AutoUpdateReadinessView />);
    await settle();
    expect(toast.error).toHaveBeenCalledWith('Failed to load fleet update status');
    expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Recheck registries' })); });
    await act(async () => {
      refresh.resolve(json({ triggered: [1], rateLimited: [], failed: [] }));
    });
    await settle(RELOAD_AFTER_RECHECK_MS + DURATION_BASE_MS * 3);
    expect(fleetCalls()).toBe(2);
    expect(screen.queryByTestId('readiness-skeleton')).toBeNull();
    expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument();
  });

  it('keeps the skeleton off while rows wait for their previews on the first load', async () => {
    const preview = deferred();
    mockedFetchForNode.mockReturnValue(preview.promise);
    route(Promise.resolve(json({ '1': { web: true } })));
    render(<AutoUpdateReadinessView />);
    await settle(DURATION_BASE_MS * 3);
    // The first load has not settled (previews pending), but the rows are already on screen.
    expect(screen.queryByTestId('readiness-skeleton')).toBeNull();
    expect(screen.getByText('web')).toBeInTheDocument();
  });

  it('keeps the skeleton until the latest first load settles when a newer load supersedes it', async () => {
    const first = deferred();
    const second = deferred();
    route([first.promise, second.promise]);
    const { rerender } = render(<AutoUpdateReadinessView />);
    await settle(DURATION_BASE_MS * 2);
    expect(screen.getByTestId('readiness-skeleton')).toBeInTheDocument();

    nodeState.list = [...LOCAL_ONLY, { id: 2, name: 'Second', type: 'remote', status: 'online' }];
    rerender(<AutoUpdateReadinessView />);
    // The superseded answer must not mark the load as done.
    await act(async () => { first.resolve(json({})); });
    await settle(DURATION_BASE_MS * 2);
    expect(screen.getByTestId('readiness-skeleton')).toBeInTheDocument();
    expect(screen.queryByText(EMPTY_STATE)).toBeNull();

    await act(async () => { second.resolve(json({})); });
    await settle();
    expect(screen.queryByTestId('readiness-skeleton')).toBeNull();
    expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument();
  });

  it('shows no skeleton when a node membership change reloads over an empty list', async () => {
    const reload = deferred();
    route([Promise.resolve(json({})), reload.promise]);
    const { rerender } = render(<AutoUpdateReadinessView />);
    await settle();
    expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument();

    nodeState.list = [...LOCAL_ONLY, { id: 2, name: 'Second', type: 'remote', status: 'online' }];
    rerender(<AutoUpdateReadinessView />);
    await settle(DURATION_BASE_MS * 3);
    expect(fleetCalls()).toBe(2);
    expect(screen.queryByTestId('readiness-skeleton')).toBeNull();
    expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument();
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
      expect(recheck).toHaveTextContent(IDLE_LABEL);

      await settle(DURATION_BASE_MS);
      expect(icon).toHaveClass('animate-spin');
      expect(recheck).toHaveTextContent(BUSY_LABEL);
    });

    it('keeps the phone Recheck free of any width holder', async () => {
      route(Promise.resolve(json({})));
      render(<AutoUpdateReadinessView />);
      await settle();

      expect(screen.queryByTestId('recheck-width-holder')).toBeNull();
      expect(screen.getByRole('button', { name: 'Recheck registries' })).toHaveTextContent(IDLE_LABEL);
    });

    it('shows no skeleton on a slow reload over the settled empty phone list', async () => {
      const reload = deferred();
      const refresh = deferred();
      route([Promise.resolve(json({})), reload.promise], refresh.promise);
      render(<AutoUpdateReadinessView />);
      await settle();
      expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument();

      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Recheck registries' })); });
      await act(async () => {
        refresh.resolve(json({ triggered: [1], rateLimited: [], failed: [] }));
      });
      await settle(RELOAD_AFTER_RECHECK_MS + DURATION_BASE_MS * 3);
    expect(fleetCalls()).toBe(2);
      expect(screen.queryByTestId('readiness-skeleton')).toBeNull();
      expect(screen.getByText(EMPTY_STATE)).toBeInTheDocument();
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
