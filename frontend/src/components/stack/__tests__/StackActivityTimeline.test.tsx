import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

const { toastFns } = vi.hoisted(() => ({
  toastFns: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));
vi.mock('@/components/ui/toast-store', () => ({ toast: toastFns }));

vi.mock('@/lib/relativeTime', () => ({
  formatTimeAgo: (ts: number) => `t-${ts}`,
}));

import { apiFetch } from '@/lib/api';
import { StackActivityTimeline } from '../StackActivityTimeline';

const mockFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

interface FakeEvent {
  id: number;
  level: string;
  category?: string;
  message: string;
  timestamp: number;
  stack_name?: string;
  actor_username?: string | null;
}

function evt(overrides: Partial<FakeEvent> = {}): FakeEvent {
  return {
    id: 1,
    level: 'info',
    category: 'deploy_success',
    message: 'deployed',
    timestamp: Date.now(),
    stack_name: 'web',
    actor_username: null,
    ...overrides,
  };
}

function jsonResponse(events: FakeEvent[]): Promise<Response> {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ events }),
  } as Response);
}

beforeEach(() => {
  mockFetch.mockReset();
  Object.values(toastFns).forEach(fn => (fn as ReturnType<typeof vi.fn>).mockReset());
});

afterEach(() => {
  vi.useRealTimers();
});

describe('StackActivityTimeline - loading and empty', () => {
  it('renders a spinner while the initial fetch is in flight', () => {
    mockFetch.mockReturnValueOnce(new Promise(() => { /* never resolves */ }));
    render(<StackActivityTimeline stackName="web" />);
    expect(document.querySelector('.animate-spin')).toBeTruthy();
  });

  it('renders empty state when no events are returned', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([]));
    render(<StackActivityTimeline stackName="web" />);
    await waitFor(() => expect(screen.getByText('No activity recorded yet')).toBeTruthy());
  });

  it('renders an error affordance with retry when fetch fails', async () => {
    mockFetch.mockReturnValueOnce(Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response));
    render(<StackActivityTimeline stackName="web" />);
    await waitFor(() => expect(screen.getByText('Activity unavailable')).toBeTruthy());
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('Retry re-issues the fetch', async () => {
    mockFetch
      .mockReturnValueOnce(Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response))
      .mockReturnValueOnce(jsonResponse([evt({ id: 1, message: 'recovered' })]));
    const user = userEvent.setup();
    render(<StackActivityTimeline stackName="web" />);
    await waitFor(() => expect(screen.getByText('Activity unavailable')).toBeTruthy());
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByText('recovered')).toBeTruthy());
  });
});

describe('StackActivityTimeline - pagination', () => {
  it('hides "Load more" when initial response is shorter than PAGE_SIZE + 1', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([evt({ id: 1, message: 'only' })]));
    render(<StackActivityTimeline stackName="web" />);
    await waitFor(() => expect(screen.getByText('only')).toBeTruthy());
    expect(screen.queryByText('Load more')).toBeNull();
  });

  it('shows "Load more" when initial response has PAGE_SIZE+1 events and trims one row', async () => {
    const page1 = Array.from({ length: 51 }, (_, i) => evt({ id: 100 - i, message: `e-${i}`, timestamp: 1000 - i }));
    mockFetch.mockReturnValueOnce(jsonResponse(page1));
    render(<StackActivityTimeline stackName="web" />);
    await waitFor(() => expect(screen.getByText('e-0')).toBeTruthy());
    expect(screen.queryByText('e-50')).toBeNull(); // 51st event was trimmed
    expect(screen.getByText('Load more')).toBeTruthy();
  });

  it('Load more requests both before and beforeId, dedupes against existing events', async () => {
    const page1 = Array.from({ length: 51 }, (_, i) => evt({ id: 100 - i, message: `e-${i}`, timestamp: 1000 - i }));
    const page2 = [evt({ id: 50, message: 'older', timestamp: 949 })];
    mockFetch
      .mockReturnValueOnce(jsonResponse(page1))
      .mockReturnValueOnce(jsonResponse(page2));
    const user = userEvent.setup();
    render(<StackActivityTimeline stackName="web" />);
    await waitFor(() => expect(screen.getByText('Load more')).toBeTruthy());

    await user.click(screen.getByText('Load more'));
    await waitFor(() => expect(screen.getByText('older')).toBeTruthy());

    // After trimming the 51st row, the oldest displayed event is { id: 51, ts: 951 },
    // so loadMore sends before=951, beforeId=51 as the composite cursor.
    const lastCall = mockFetch.mock.calls[1][0] as string;
    expect(lastCall).toContain('limit=51');
    expect(lastCall).toContain('before=951');
    expect(lastCall).toContain('beforeId=51');
  });

  it('toasts on loadMore failure and keeps existing rows', async () => {
    const page1 = Array.from({ length: 51 }, (_, i) => evt({ id: 100 - i, message: `e-${i}`, timestamp: 1000 - i }));
    mockFetch
      .mockReturnValueOnce(jsonResponse(page1))
      .mockReturnValueOnce(Promise.resolve({ ok: false, status: 500, json: async () => ({}) } as Response));
    const user = userEvent.setup();
    render(<StackActivityTimeline stackName="web" />);
    await waitFor(() => expect(screen.getByText('Load more')).toBeTruthy());
    await user.click(screen.getByText('Load more'));
    await waitFor(() => expect(toastFns.error).toHaveBeenCalledWith('Failed to load more activity'));
    expect(screen.getByText('e-0')).toBeTruthy();
  });
});

describe('StackActivityTimeline - liveEvents merge', () => {
  it('merges new live events into the timeline', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([evt({ id: 1, message: 'first', timestamp: 100 })]));
    const { rerender } = render(<StackActivityTimeline stackName="web" />);
    await waitFor(() => expect(screen.getByText('first')).toBeTruthy());

    rerender(<StackActivityTimeline stackName="web" liveEvents={[evt({ id: 2, message: 'live', timestamp: 200 }) as never]} />);
    await waitFor(() => expect(screen.getByText('live')).toBeTruthy());
  });

  it('dedupes live events that overlap an already-loaded id', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([evt({ id: 1, message: 'first', timestamp: 100 })]));
    const { rerender } = render(<StackActivityTimeline stackName="web" />);
    await waitFor(() => expect(screen.getByText('first')).toBeTruthy());

    rerender(<StackActivityTimeline stackName="web" liveEvents={[evt({ id: 1, message: 'first', timestamp: 100 }) as never]} />);
    // Still exactly one row.
    expect(screen.getAllByText('first')).toHaveLength(1);
  });

  it('drops malformed live events through the narrow guard but accepts well-formed siblings', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([evt({ id: 1, message: 'first', timestamp: 100 })]));
    const { rerender } = render(<StackActivityTimeline stackName="web" />);
    await waitFor(() => expect(screen.getByText('first')).toBeTruthy());

    // Mixed batch: one bad (id is a string, wrong level), one good. The guard
    // must reject the bad row and let the good one through.
    rerender(
      <StackActivityTimeline
        stackName="web"
        liveEvents={[
          { id: 'not-a-number', message: 'BAD', timestamp: 1, level: 'info' } as never,
          evt({ id: 99, message: 'GOOD', timestamp: 200 }) as never,
        ]}
      />,
    );
    await waitFor(() => expect(screen.getByText('GOOD')).toBeTruthy());
    expect(screen.queryByText('BAD')).toBeNull();
  });

  it('rejects an event whose level is outside the union', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([evt({ id: 1, message: 'first', timestamp: 100 })]));
    const { rerender } = render(<StackActivityTimeline stackName="web" />);
    await waitFor(() => expect(screen.getByText('first')).toBeTruthy());

    rerender(
      <StackActivityTimeline
        stackName="web"
        liveEvents={[{ id: 2, message: 'CRIT', timestamp: 200, level: 'critical' } as never]}
      />,
    );
    expect(screen.queryByText('CRIT')).toBeNull();
  });
});

describe('StackActivityTimeline - stackName change resets state', () => {
  it('refetches when stackName changes and clears prior events', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([evt({ id: 1, message: 'web-evt' })]));
    const { rerender } = render(<StackActivityTimeline stackName="web" />);
    await waitFor(() => expect(screen.getByText('web-evt')).toBeTruthy());

    mockFetch.mockReturnValueOnce(jsonResponse([evt({ id: 2, message: 'api-evt', stack_name: 'api' })]));
    rerender(<StackActivityTimeline stackName="api" />);
    await waitFor(() => expect(screen.getByText('api-evt')).toBeTruthy());
    expect(screen.queryByText('web-evt')).toBeNull();
  });
});

describe('StackActivityTimeline - actor rendering', () => {
  it('renders human actor with "by <name>" prefix', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([evt({ id: 1, message: 'deployed', actor_username: 'alice' })]));
    render(<StackActivityTimeline stackName="web" />);
    await waitFor(() => expect(screen.getByText(/by alice/)).toBeTruthy());
  });

  it('renders synthetic system actor with "via <Label>" prefix', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([evt({ id: 1, message: 'restarted', actor_username: 'system:autoheal' })]));
    render(<StackActivityTimeline stackName="web" />);
    await waitFor(() => expect(screen.getByText(/via Auto-Heal/)).toBeTruthy());
  });

  it('renders bare "system" actor as "via System"', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([evt({ id: 1, message: 'event', actor_username: 'system' })]));
    render(<StackActivityTimeline stackName="web" />);
    await waitFor(() => expect(screen.getByText(/via System/)).toBeTruthy());
  });

  it('omits actor line when actor_username is null', async () => {
    mockFetch.mockReturnValueOnce(jsonResponse([evt({ id: 1, message: 'event', actor_username: null })]));
    render(<StackActivityTimeline stackName="web" />);
    await waitFor(() => expect(screen.getByText('event')).toBeTruthy());
    expect(screen.queryByText(/^(by|via)\s/)).toBeNull();
  });
});

