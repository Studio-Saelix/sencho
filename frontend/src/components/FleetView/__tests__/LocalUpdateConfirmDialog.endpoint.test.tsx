import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
vi.mock('@/components/ui/modal', () => ({
  ConfirmModal: ({ open, title, children, kicker, onConfirm, onOpenChange }: {
    open: boolean; title: string; children: React.ReactNode; kicker: string;
    onConfirm: () => void; onOpenChange: (open: boolean) => void;
  }) => open ? (
    <div>
      <span>{kicker}</span>
      <h2>{title}</h2>
      {children}
      <button type="button" onClick={onConfirm}>confirm</button>
      <button type="button" onClick={() => onOpenChange(false)}>cancel</button>
    </div>
  ) : null,
}));

import { LocalUpdateConfirmDialog } from '../LocalUpdateConfirmDialog';

function answer(payload: unknown) {
  apiFetchMock.mockResolvedValue(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

beforeEach(() => { apiFetchMock.mockReset(); });

describe('LocalUpdateConfirmDialog Docker endpoint option', () => {
  it('offers the provider and passes the choice to the confirm', async () => {
    answer({ state: 'available', service: 'socket-proxy', containerName: 'stack-socket-proxy-1' });
    const onConfirm = vi.fn();
    render(<LocalUpdateConfirmDialog open mode="reapply" nodeId={4} onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    const checkbox = await screen.findByRole('checkbox', { name: /Also recreate the Docker endpoint/i });
    expect(apiFetchMock).toHaveBeenCalledWith('/fleet/nodes/4/endpoint-provider', { localOnly: true });
    expect(screen.getByText('socket-proxy')).toBeInTheDocument();
    await userEvent.click(checkbox);
    await userEvent.click(screen.getByText('confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ replaceEndpointProvider: true });
  });

  it('confirms without the provider when the box stays unchecked', async () => {
    answer({ state: 'available', service: 'socket-proxy', containerName: 'c' });
    const onConfirm = vi.fn();
    render(<LocalUpdateConfirmDialog open nodeId={1} onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    await screen.findByRole('checkbox');
    await userEvent.click(screen.getByText('confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ replaceEndpointProvider: false });
  });

  it('forgets the choice when the dialog is cancelled', async () => {
    answer({ state: 'available', service: 'socket-proxy', containerName: 'c' });
    const onConfirm = vi.fn();
    const { rerender } = render(<LocalUpdateConfirmDialog open nodeId={1} onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    await userEvent.click(await screen.findByRole('checkbox'));
    await userEvent.click(screen.getByText('cancel'));
    rerender(<LocalUpdateConfirmDialog open={false} nodeId={1} onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    rerender(<LocalUpdateConfirmDialog open nodeId={1} onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    expect(await screen.findByRole('checkbox')).not.toBeChecked();
  });

  it('names a provider it cannot replace, with the reason, and offers no box', async () => {
    answer({ state: 'unavailable', service: 'docker-proxy', reason: 'It is not a service of Sencho\'s own Compose project.' });
    const onConfirm = vi.fn();
    render(<LocalUpdateConfirmDialog open mode="reapply" nodeId={2} onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    expect(await screen.findByText(/left running: It is not a service/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ replaceEndpointProvider: false });
  });

  it.each([
    [{ state: 'none' }],
    [{ state: 'unsupported' }],
  ])('shows nothing for %o', async (payload) => {
    answer(payload);
    render(<LocalUpdateConfirmDialog open nodeId={2} onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/Docker endpoint/)).not.toBeInTheDocument();
  });

  it('offers nothing when the check fails', async () => {
    apiFetchMock.mockResolvedValue(new Response('{}', { status: 502 }));
    render(<LocalUpdateConfirmDialog open nodeId={2} onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('does not ask without a node', () => {
    render(<LocalUpdateConfirmDialog open onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it('uses remote copy for a remote update', () => {
    answer({ state: 'none' });
    render(<LocalUpdateConfirmDialog open nodeType="remote" nodeId={2} targetVersion="0.99.0" onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText('REMOTE · UPDATE')).toBeInTheDocument();
    expect(screen.getByText('Update node')).toBeInTheDocument();
    expect(screen.getByText(/on this node and restarts it/)).toBeInTheDocument();
  });
});
