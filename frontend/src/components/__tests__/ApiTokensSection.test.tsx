/**
 * Coverage for ApiTokensSection load behavior.
 *
 * Locks the fix where a non-ok token-list response was swallowed silently: the
 * section must surface an error toast and an error state with a retry, rather
 * than presenting the empty "No API tokens yet" state as if no tokens existed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

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

// Render CapabilityGate's children directly: the capability gate is not under test.
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({
    hasCapability: () => true,
    activeNode: { id: 1, name: 'local' },
    activeNodeMeta: { version: '1.0.0', capabilities: ['api-tokens'], fetchedAt: 0 },
  }),
}));

// The masthead stats hook depends on a provider that is not mounted here.
vi.mock('../settings/MastheadStatsContext', () => ({
  useMastheadStats: () => {},
}));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { ApiTokensSection } from '../ApiTokensSection';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedToast = toast as unknown as { error: ReturnType<typeof vi.fn> };

function tokenRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: 'ci-pipeline',
    scope: 'read-only',
    created_at: 1_700_000_000_000,
    last_used_at: null,
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

describe('ApiTokensSection load behavior', () => {
  beforeEach(() => {
    mockedFetch.mockReset();
    mockedToast.error.mockReset();
  });

  it('surfaces an error toast and an error state (not the empty state) when the list load fails', async () => {
    mockedFetch.mockResolvedValue({ ok: false, json: async () => ({ error: 'list blew up' }) });

    render(<ApiTokensSection />);

    await waitFor(() => expect(mockedToast.error).toHaveBeenCalledWith('list blew up'));
    expect(await screen.findByText("Couldn't load API tokens")).toBeInTheDocument();
    expect(screen.queryByText('No API tokens yet')).toBeNull();
  });

  it('shows the empty state and does not toast on a successful empty load', async () => {
    mockedFetch.mockResolvedValue({ ok: true, json: async () => [] });

    render(<ApiTokensSection />);

    expect(await screen.findByText('No API tokens yet')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load API tokens")).toBeNull();
    expect(mockedToast.error).not.toHaveBeenCalled();
  });

  it('renders the token list and does not toast on a successful load', async () => {
    mockedFetch.mockResolvedValue({ ok: true, json: async () => [tokenRow()] });

    render(<ApiTokensSection />);

    expect(await screen.findByText('ci-pipeline')).toBeInTheDocument();
    expect(mockedToast.error).not.toHaveBeenCalled();
  });

  it('recovers via Retry: a failed load then a successful one clears the error state', async () => {
    mockedFetch
      .mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'transient' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => [] });

    render(<ApiTokensSection />);

    const retry = await screen.findByRole('button', { name: /retry/i });
    fireEvent.click(retry);

    expect(await screen.findByText('No API tokens yet')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load API tokens")).toBeNull();
  });

  it('offers Observe Only with a required expiry and sends a 90-day one', async () => {
    mockedFetch.mockImplementation(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        return { ok: true, json: async () => ({ id: 7, token: 'sen_sk_generated' }) };
      }
      return { ok: true, json: async () => [] };
    });

    render(<ApiTokensSection />);
    fireEvent.click(screen.getByRole('button', { name: /Create token/ }));

    const [scopeCombobox, expiryCombobox] = screen.getAllByRole('combobox');
    await userEvent.click(scopeCombobox);
    await userEvent.click(await screen.findByRole('button', { name: /Observe Only/ }));

    // The scope cannot fall back to "no expiration", and the default expiry is
    // already chosen so a create click cannot send null.
    expect(expiryCombobox).toHaveTextContent('90 days');
    await userEvent.click(expiryCombobox);
    expect(screen.queryByRole('button', { name: 'No expiration' })).toBeNull();
    await userEvent.click(await screen.findByRole('button', { name: '60 days' }));
    await userEvent.keyboard('{Escape}');

    fireEvent.change(screen.getByPlaceholderText('CI deploy pipeline'), { target: { value: 'claude-desktop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      const post = mockedFetch.mock.calls.find(([, init]) => (init as { method?: string } | undefined)?.method === 'POST');
      expect(post).toBeDefined();
      expect(JSON.parse((post![1] as { body: string }).body)).toEqual({
        name: 'claude-desktop',
        scope: 'observe-only',
        expires_in: 60,
      });
    });
  });

  it('labels an Observe Only row with its own badge', async () => {
    mockedFetch.mockResolvedValue({
      ok: true,
      json: async () => [tokenRow({ id: 9, name: 'agent', scope: 'observe-only', expires_at: Date.now() + 86_400_000 })],
    });

    render(<ApiTokensSection />);

    expect(await screen.findByText('agent')).toBeInTheDocument();
    expect(screen.getByText('Observe Only')).toBeInTheDocument();
  });
});
