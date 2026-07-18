/**
 * NotificationSuppressionSection stack pattern chips.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
import { NotificationSuppressionSection } from '../NotificationSuppressionSection';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

describe('NotificationSuppressionSection', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === '/notification-suppression-rules' && !opts?.method) {
        return { ok: true, json: async () => [] };
      }
      if (url === '/stacks') return { ok: true, json: async () => ['staging'] };
      if (url === '/labels') return { ok: true, json: async () => [] };
      if (url === '/notification-suppression-rules' && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ id: 1 }) };
      }
      return { ok: true, json: async () => ([]) };
    });
  });

  it('posts normalized stack patterns and levels; blocks invalid patterns', async () => {
    render(<NotificationSuppressionSection />);
    await waitFor(() => expect(screen.getByRole('button', { name: /Add mute rule|Add rule/i })).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /Add mute rule|Add rule/i }));

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

    mockedFetch.mockClear();
    await userEvent.click(screen.getByRole('button', { name: /Add mute rule/i }));
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
});
