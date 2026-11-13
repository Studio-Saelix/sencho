/**
 * An unknown state must not read as all clear. Before the first readiness load
 * answers, the desktop hero and the phone masthead say they are checking; only
 * a settled load with nothing pending shows the all-clear wording.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

// useIsMobile is module-mocked, so the flag has to be hoisted above the factory.
const { mobile } = vi.hoisted(() => ({ mobile: { value: false } }));

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  fetchForNode: vi.fn(),
  withDeploySession: (_id: string, options: object = {}) => options,
}));
vi.mock('@/lib/serviceUpdate', () => ({ requestServiceUpdate: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => mobile.value }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('@/context/DeployFeedbackContext', () => ({
  useDeployFeedback: () => ({
    runWithLog: async (_params: unknown, fn: (started: Promise<void>, ds: string) => Promise<unknown>) =>
      fn(Promise.resolve(), 'test-session'),
  }),
}));
const mockNodeMeta = new Map();
const mockRefreshNodeMeta = vi.fn();
const mockNodes: { id: number; name: string; type: 'local' | 'remote'; status: string }[] = [
  { id: 1, name: 'Local', type: 'local', status: 'online' },
];
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ nodes: mockNodes, nodeMeta: mockNodeMeta, refreshNodeMeta: mockRefreshNodeMeta }),
}));

import { apiFetch, fetchForNode } from '@/lib/api';
import AutoUpdateReadinessView from '../AutoUpdateReadinessView';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedFetchForNode = fetchForNode as unknown as ReturnType<typeof vi.fn>;

function ok(body: unknown) {
  return { ok: true, json: async () => body };
}

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((res) => { resolve = res; });
  return { promise, resolve };
}

/** Only /image-updates/fleet comes from the caller; the rest of the load settles at once. */
function seedReadiness(fleet: Promise<unknown> | (() => Promise<unknown>)) {
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/image-updates/fleet') {
      return typeof fleet === 'function' ? fleet() : fleet;
    }
    if (url === '/image-updates/fleet/refresh') {
      return Promise.resolve(ok({ triggered: [1], rateLimited: [], failed: [] }));
    }
    if (url === '/image-updates/fleet/detail') return Promise.resolve(ok({}));
    if (url.startsWith('/scheduled-tasks')) return Promise.resolve(ok([]));
    if (url === '/image-updates/status') return Promise.resolve(ok({ enabled: true }));
    return Promise.resolve(ok({}));
  });
}

afterEach(() => {
  vi.useRealTimers();
  mobile.value = false;
  mockedFetch.mockReset();
  mockedFetchForNode.mockReset();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('AutoUpdateReadinessView first load', () => {
  it('says Checking for updates on the desktop, then the all-clear only once the load settles', async () => {
    const fleet = deferred();
    seedReadiness(fleet.promise);

    render(<AutoUpdateReadinessView />);

    // Nothing has been counted yet, so the hero must not claim an all-clear.
    expect(await screen.findByText('Checking for updates')).toBeInTheDocument();
    expect(screen.queryByText('Everything is up to date')).toBeNull();
    expect(screen.queryByText(/All stacks on current builds/)).toBeNull();

    await act(async () => { fleet.resolve(ok({})); });

    expect(await screen.findByText('Everything is up to date')).toBeInTheDocument();
    expect(screen.queryByText('Checking for updates')).toBeNull();
    expect(screen.getByText(/All stacks on current builds/)).toBeInTheDocument();
  });

  it('says Checking on the phone masthead, then Up to date once the load settles', async () => {
    mobile.value = true;
    const fleet = deferred();
    seedReadiness(fleet.promise);

    render(<AutoUpdateReadinessView />);

    expect(await screen.findByText('Checking')).toBeInTheDocument();
    expect(screen.queryByText('Up to date')).toBeNull();
    expect(screen.queryByText('all stacks current')).toBeNull();

    await act(async () => { fleet.resolve(ok({})); });

    expect(await screen.findByText('Up to date')).toBeInTheDocument();
    expect(screen.getByText('all stacks current')).toBeInTheDocument();
    expect(screen.queryByText('Checking')).toBeNull();
  });

  it.each([
    { layout: 'desktop', phone: false, settled: 'Everything is up to date', checking: 'Checking for updates' },
    { layout: 'phone', phone: true, settled: 'Up to date', checking: 'Checking' },
  ])('keeps the settled $layout all-clear while a later Recheck reload is in flight', async ({ phone, settled, checking }) => {
    mobile.value = phone;
    let reloading = false;
    seedReadiness(() => (reloading ? new Promise(() => {}) : Promise.resolve(ok({}))));
    const fleetLoads = () => mockedFetch.mock.calls.filter((call) => call[0] === '/image-updates/fleet').length;

    render(<AutoUpdateReadinessView />);
    expect(await screen.findByText(settled)).toBeInTheDocument();
    expect(fleetLoads()).toBe(1);

    // The Recheck reload is timer-delayed; drive that timer instead of waiting it out.
    vi.useFakeTimers();
    reloading = true;
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Recheck registries/i }));
    });
    act(() => { vi.advanceTimersByTime(2600); });
    await act(async () => { await Promise.resolve(); });
    // The timer really started a reload over the settled state.
    expect(fleetLoads()).toBe(2);

    // An already-settled page keeps its verdict while the reload runs.
    expect(screen.getByText(settled)).toBeInTheDocument();
    expect(screen.queryByText(checking)).toBeNull();
  });

  it.each([
    {
      layout: 'desktop',
      phone: false,
      headline: '1 update pending',
      absent: ['Checking for updates', 'Could not check for updates', 'Everything is up to date'],
    },
    {
      layout: 'phone',
      phone: true,
      headline: '1 pending',
      absent: ['Checking', 'Unavailable', 'Up to date', 'all stacks current'],
    },
  ])('keeps the $layout pending count while the row previews are still loading', async ({ phone, headline, absent }) => {
    mobile.value = phone;
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') return Promise.resolve(ok({ '1': { web: true } }));
      if (url === '/image-updates/fleet/detail') return Promise.resolve(ok({}));
      if (url.startsWith('/scheduled-tasks')) return Promise.resolve(ok([]));
      if (url === '/image-updates/status') return Promise.resolve(ok({ enabled: true }));
      return Promise.resolve(ok({}));
    });
    // The fleet answer carries the count; the per-row previews land later.
    mockedFetchForNode.mockReturnValue(new Promise(() => {}));

    render(<AutoUpdateReadinessView />);

    expect(await screen.findByText('web')).toBeInTheDocument();
    expect(screen.getByText(headline)).toBeInTheDocument();
    for (const text of absent) expect(screen.queryByText(text)).toBeNull();
  });

  it.each([
    {
      layout: 'desktop',
      phone: false,
      headline: 'Could not check for updates',
      absent: ['Everything is up to date', 'All stacks on current builds', 'Checking for updates'],
    },
    {
      layout: 'phone',
      phone: true,
      headline: 'Unavailable',
      absent: ['Up to date', 'all stacks current', 'Checking'],
    },
  ])('does not claim an all-clear when the first load fails on $layout', async ({ phone, headline, absent }) => {
    mobile.value = phone;
    mockedFetch.mockImplementation((url: string) => {
      if (url === '/image-updates/fleet') {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) });
      }
      if (url === '/image-updates/status') return Promise.resolve(ok({ enabled: true }));
      return Promise.resolve(ok({}));
    });

    render(<AutoUpdateReadinessView />);

    expect(await screen.findByText(headline)).toBeInTheDocument();
    for (const text of absent) expect(screen.queryByText(text)).toBeNull();
    // The body carries the same unknown state and names it, instead of the empty list.
    expect(screen.getByText('Update readiness unavailable')).toBeInTheDocument();
    expect(screen.getByText('The fleet update status could not be loaded.')).toBeInTheDocument();
  });
});

