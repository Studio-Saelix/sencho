/**
 * Coverage for ApiTokensSection load behavior.
 *
 * Locks the fix where a non-ok token-list response was swallowed silently: the
 * section must surface an error toast and an error state with a retry, rather
 * than presenting the empty "No API tokens yet" state as if no tokens existed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

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
});
