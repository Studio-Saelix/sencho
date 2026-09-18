import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitProviderHooksCard } from '../GitProviderHooksCard';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({
    activeNode: { id: 1, name: 'Local' },
  }),
}));

vi.mock('@/lib/clipboard', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(undefined),
}));

describe('GitProviderHooksCard', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('renders endpoints and hides mutate controls when canEdit is false', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        direct_source: true,
        endpoints: [{
          id: 'ep-1',
          provider: 'github',
          enabled: true,
          event_scope: 'configured_ref',
          created_at: 1,
          updated_at: 1,
          deliveries: [],
        }],
      }),
    } as Response);

    render(<GitProviderHooksCard stackName="web" canEdit={false} />);

    await waitFor(() => {
      expect(screen.getByText('GitHub')).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /create/i })).not.toBeInTheDocument();
  });

  it('shows one-time secret after create', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ direct_source: true, endpoints: [] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 'ep-new', secret: 'shown-once-secret' }),
      } as Response)
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          direct_source: true,
          endpoints: [{
            id: 'ep-new',
            provider: 'github',
            enabled: true,
            event_scope: 'configured_ref',
            created_at: 1,
            updated_at: 1,
            deliveries: [],
          }],
        }),
      } as Response);

    render(<GitProviderHooksCard stackName="web" canEdit />);

    await waitFor(() => {
      expect(screen.getByText(/add provider hook/i)).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /add provider hook/i }));
    await userEvent.click(screen.getByRole('button', { name: /^create$/i }));

    await waitFor(() => {
      expect(screen.getByText('shown-once-secret')).toBeInTheDocument();
    });
  });
});
