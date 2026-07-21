/**
 * NotificationSuppressionSection stack pattern chips and weekly schedule UI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}));
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({
    nodes: [{ id: 1, type: 'local', name: 'Local' }],
    hasCapability: () => true,
    activeNode: { id: 1, type: 'local', name: 'Local' },
    activeNodeMeta: { version: '1.0.0' },
  }),
}));
vi.mock('@/components/CapabilityGate', () => ({
  CapabilityGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../MastheadStatsContext', () => ({
  useMastheadStats: () => {},
}));
vi.mock('@/hooks/useMuteRulesRefresh', () => ({
  useMuteRulesRefresh: () => {},
}));
vi.mock('@/lib/muteRules', () => ({
  emitMuteRulesChanged: vi.fn(),
}));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { NotificationSuppressionSection } from '../NotificationSuppressionSection';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

const scheduledRule = {
  id: 42,
  name: 'Weekend mute',
  node_id: null,
  stack_patterns: ['prod-*'],
  label_ids: null,
  categories: null,
  levels: null,
  applies_to: 'both',
  enabled: true,
  expires_at: null,
  schedule: {
    days: [6],
    start_minute: 120,
    end_minute: 360,
    tz: 'UTC',
  },
  created_at: 1,
  updated_at: 1,
};

function mockListRules(rules: unknown[] = []) {
  mockedFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
    if (url === '/notification-suppression-rules' && !opts?.method) {
      return { ok: true, json: async () => rules };
    }
    if (url === '/stacks') return { ok: true, json: async () => ['staging'] };
    if (url === '/labels') return { ok: true, json: async () => [] };
    if (url === '/notification-suppression-rules' && opts?.method === 'POST') {
      return { ok: true, json: async () => ({ id: 1 }) };
    }
    if (typeof url === 'string' && url.startsWith('/notification-suppression-rules/') && opts?.method === 'PUT') {
      return { ok: true, json: async () => ({ id: 42 }) };
    }
    return { ok: true, json: async () => ([]) };
  });
}

async function openMuteForm() {
  render(<NotificationSuppressionSection />);
  await waitFor(() => expect(screen.getByRole('button', { name: /Add mute rule|Add rule/i })).toBeInTheDocument());
  await userEvent.click(screen.getByRole('button', { name: /Add mute rule|Add rule/i }));
  await waitFor(() => expect(screen.getByRole('dialog', { name: /New mute rule/i })).toBeInTheDocument());
}

async function enableWeeklyWindow() {
  await userEvent.click(screen.getByLabelText(/Weekly window \(UTC\)/i));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Sat' })).toBeInTheDocument());
}

describe('NotificationSuppressionSection', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    vi.mocked(toast.error).mockClear();
    mockListRules([]);
  });

  it('posts normalized stack patterns and null levels', async () => {
    await openMuteForm();

    const nameInput = screen.getByPlaceholderText(/Mute staging/i);
    await userEvent.type(nameInput, 'Mute prod');
    await userEvent.type(screen.getByPlaceholderText(/Type a pattern/i), 'prod-*,prod-*{Enter}');

    await userEvent.click(screen.getByRole('button', { name: /Create|Update/i }));
    await waitFor(() => {
      const post = mockedFetch.mock.calls.find(
        ([url, opts]) => url === '/notification-suppression-rules' && (opts as { method?: string })?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as { body: string }).body);
      expect(body.stack_patterns).toEqual(['prod-*']);
      expect(body.levels).toBeNull();
    });
  });

  it('includes a pending pattern that was never committed with Enter', async () => {
    await openMuteForm();

    await userEvent.type(screen.getByPlaceholderText(/Mute staging/i), 'Pending mute');
    await userEvent.type(screen.getByPlaceholderText(/Type a pattern/i), 'prod-*');
    await userEvent.click(screen.getByRole('button', { name: /Create|Update/i }));
    await waitFor(() => {
      const post = mockedFetch.mock.calls.find(
        ([url, opts]) => url === '/notification-suppression-rules' && (opts as { method?: string })?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as { body: string }).body);
      expect(body.stack_patterns).toEqual(['prod-*']);
    });
  });

  it('accumulates multi-pattern comma input into the create body', async () => {
    await openMuteForm();

    await userEvent.type(screen.getByPlaceholderText(/Mute staging/i), 'Paste mute');
    await userEvent.type(screen.getByPlaceholderText(/Type a pattern/i), 'alpha-*,beta-*');
    await userEvent.click(screen.getByRole('button', { name: /Create|Update/i }));
    await waitFor(() => {
      const post = mockedFetch.mock.calls.find(
        ([url, opts]) => url === '/notification-suppression-rules' && (opts as { method?: string })?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as { body: string }).body);
      expect(body.stack_patterns).toEqual(['alpha-*', 'beta-*']);
    });
  });

  it('blocks create when a stack pattern is invalid', async () => {
    await openMuteForm();

    await userEvent.type(screen.getByPlaceholderText(/Mute staging/i), 'Bad mute');
    await userEvent.type(screen.getByPlaceholderText(/Type a pattern/i), '****');
    await userEvent.click(screen.getByRole('button', { name: /Create|Update/i }));
    await waitFor(() => {
      const posts = mockedFetch.mock.calls.filter(
        ([url, opts]) => url === '/notification-suppression-rules' && (opts as { method?: string })?.method === 'POST',
      );
      expect(posts).toHaveLength(0);
    });
  });

  it('posts a weekly UTC schedule with accessible day and time controls', async () => {
    await openMuteForm();

    await userEvent.type(screen.getByPlaceholderText(/Mute staging/i), 'Sat window');
    await userEvent.type(screen.getByPlaceholderText(/Type a pattern/i), 'prod-*{Enter}');
    await enableWeeklyWindow();

    const sat = screen.getByRole('button', { name: 'Sat' });
    expect(sat).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(sat);
    expect(sat).toHaveAttribute('aria-pressed', 'true');

    expect(screen.getByLabelText('Start (UTC)')).toHaveAttribute('id', 'mute-schedule-start');
    expect(screen.getByLabelText('End (UTC)')).toHaveAttribute('id', 'mute-schedule-end');
    fireEvent.change(screen.getByLabelText('Start (UTC)'), { target: { value: '02:00' } });
    fireEvent.change(screen.getByLabelText('End (UTC)'), { target: { value: '06:00' } });

    await userEvent.click(screen.getByRole('button', { name: /Create|Update/i }));
    await waitFor(() => {
      const post = mockedFetch.mock.calls.find(
        ([url, opts]) => url === '/notification-suppression-rules' && (opts as { method?: string })?.method === 'POST',
      );
      expect(post).toBeTruthy();
      const body = JSON.parse((post![1] as { body: string }).body);
      expect(body.schedule).toEqual({
        days: [6],
        start_minute: 120,
        end_minute: 360,
        tz: 'UTC',
      });
    });
  });

  it('blocks scheduled create when no weekday is selected', async () => {
    await openMuteForm();

    await userEvent.type(screen.getByPlaceholderText(/Mute staging/i), 'No days');
    await userEvent.type(screen.getByPlaceholderText(/Type a pattern/i), 'prod-*{Enter}');
    await enableWeeklyWindow();
    await userEvent.click(screen.getByRole('button', { name: /Create|Update/i }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Select at least one day for the weekly window.');
    });
    const posts = mockedFetch.mock.calls.filter(
      ([url, opts]) => url === '/notification-suppression-rules' && (opts as { method?: string })?.method === 'POST',
    );
    expect(posts).toHaveLength(0);
  });

  it('hydrates edit form from an existing schedule and keeps it on PUT', async () => {
    mockListRules([scheduledRule]);
    render(<NotificationSuppressionSection />);
    await waitFor(() => expect(screen.getByText('Weekend mute')).toBeInTheDocument());
    expect(screen.getByText(/UTC Sat 02:00-06:00/)).toBeInTheDocument();

    await userEvent.click(screen.getByTitle('Edit'));
    await waitFor(() => expect(screen.getByRole('dialog', { name: /Edit mute rule/i })).toBeInTheDocument());

    expect(screen.getByLabelText(/Weekly window \(UTC\)/i)).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'Sat' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Start (UTC)')).toHaveValue('02:00');
    expect(screen.getByLabelText('End (UTC)')).toHaveValue('06:00');

    await userEvent.click(screen.getByRole('button', { name: /Create|Update/i }));
    await waitFor(() => {
      const put = mockedFetch.mock.calls.find(
        ([url, opts]) =>
          url === '/notification-suppression-rules/42' && (opts as { method?: string })?.method === 'PUT',
      );
      expect(put).toBeTruthy();
      const body = JSON.parse((put![1] as { body: string }).body);
      expect(body.schedule).toEqual({
        days: [6],
        start_minute: 120,
        end_minute: 360,
        tz: 'UTC',
      });
    });
  });

  it('clears schedule to null when weekly window is turned off on edit', async () => {
    mockListRules([scheduledRule]);
    render(<NotificationSuppressionSection />);
    await waitFor(() => expect(screen.getByText('Weekend mute')).toBeInTheDocument());

    await userEvent.click(screen.getByTitle('Edit'));
    await waitFor(() => expect(screen.getByRole('dialog', { name: /Edit mute rule/i })).toBeInTheDocument());
    await userEvent.click(screen.getByLabelText(/Weekly window \(UTC\)/i));
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Sat' })).not.toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /Create|Update/i }));
    await waitFor(() => {
      const put = mockedFetch.mock.calls.find(
        ([url, opts]) =>
          url === '/notification-suppression-rules/42' && (opts as { method?: string })?.method === 'PUT',
      );
      expect(put).toBeTruthy();
      const body = JSON.parse((put![1] as { body: string }).body);
      expect(body.schedule).toBeNull();
    });
  });
});
