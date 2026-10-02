import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GitProviderHooksCard } from './GitProviderHooksCard';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
// The active node is 4; the card is hosted for node 9.
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ activeNode: { id: 4 } }) }));

const ENDPOINT = {
  id: 'ep-1',
  provider: 'github',
  enabled: true,
  event_scope: 'configured_ref',
  created_at: 1,
  updated_at: 1,
  deliveries: [],
};

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe('GitProviderHooksCard hosted for another node', () => {
  it('shows the webhook URL for that node and sends its requests there', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({ endpoints: [ENDPOINT], direct_source: true, secret: 's' }));
    render(<GitProviderHooksCard stackName="web" canEdit nodeId={9} />);

    expect(await screen.findByText(`${window.location.origin}/api/gitops/hooks/9/ep-1`)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /rotate/i }));
    await waitFor(() => {
      expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
        '/stacks/web/git-source/provider-hooks/ep-1/rotate',
        expect.objectContaining({ method: 'POST' }),
      );
    });
    for (const [url, options] of vi.mocked(apiFetch).mock.calls) {
      expect({ url, nodeId: (options as { nodeId?: number } | undefined)?.nodeId }).toEqual({ url, nodeId: 9 });
    }
  });
});
