import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GitPollingControl } from '../GitPollingControl';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

const nodeCtl = vi.hoisted(() => ({
  activeNode: { id: 1 } as { id: number } | null,
  activeNodeMeta: { capabilities: ['gitops-source-controller'] } as { capabilities: string[] } | null,
  hasCapability: vi.fn(() => true),
}));
const authCtl = vi.hoisted(() => ({
  canManage: true,
}));
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({
    activeNode: nodeCtl.activeNode,
    activeNodeMeta: nodeCtl.activeNodeMeta,
    hasCapability: nodeCtl.hasCapability,
  }),
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({
    can: (action: string) => (action === 'node:manage' ? authCtl.canManage : true),
  }),
}));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';

function jsonRes(body: unknown, ok = true) {
  return { ok, json: async () => body, text: async () => '' } as unknown as Response;
}

describe('GitPollingControl', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    nodeCtl.activeNode = { id: 1 };
    nodeCtl.activeNodeMeta = { capabilities: ['gitops-source-controller'] };
    nodeCtl.hasCapability.mockReturnValue(true);
    authCtl.canManage = true;
  });

  it('renders off when GET returns poll_interval_mins 0', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({ poll_interval_mins: 0 }));
    render(<GitPollingControl />);
    const toggle = await screen.findByRole('switch', { name: /poll git sources/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByText('Poll interval')).not.toBeInTheDocument();
  });

  it('does not treat a null interval as on', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({ poll_interval_mins: null }));
    render(<GitPollingControl />);
    const toggle = await screen.findByRole('switch', { name: /poll git sources/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('saves 5 minutes when polling is turned on from off', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonRes({ poll_interval_mins: 0 }))
      .mockResolvedValueOnce(jsonRes({ poll_interval_mins: 5 }));
    render(<GitPollingControl />);
    const toggle = await screen.findByRole('switch', { name: /poll git sources/i });
    fireEvent.click(toggle);
    await waitFor(() => {
      const patch = vi.mocked(apiFetch).mock.calls.find((call) => call[1]?.method === 'PATCH');
      expect(patch?.[0]).toBe('/git-sources/polling');
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ poll_interval_mins: 5 });
    });
  });

  it('saves 0 when polling is turned off', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonRes({ poll_interval_mins: 15 }))
      .mockResolvedValueOnce(jsonRes({ poll_interval_mins: 0 }));
    render(<GitPollingControl />);
    const toggle = await screen.findByRole('switch', { name: /poll git sources/i });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(toggle);
    await waitFor(() => {
      const patch = vi.mocked(apiFetch).mock.calls.find((call) => call[1]?.method === 'PATCH');
      expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ poll_interval_mins: 0 });
    });
  });

  it('hides when the source-controller capability is missing', async () => {
    nodeCtl.hasCapability.mockReturnValue(false);
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({ poll_interval_mins: 0 }));
    render(<GitPollingControl />);
    expect(screen.queryByRole('switch', { name: /poll git sources/i })).not.toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('does not fetch until node meta has loaded', () => {
    nodeCtl.activeNodeMeta = null;
    render(<GitPollingControl />);
    expect(screen.queryByRole('switch', { name: /poll git sources/i })).not.toBeInTheDocument();
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('does not fetch polling settings without node:manage', async () => {
    authCtl.canManage = false;
    render(<GitPollingControl />);
    const toggle = await screen.findByRole('switch', { name: /poll git sources/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(toggle).toBeDisabled();
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
