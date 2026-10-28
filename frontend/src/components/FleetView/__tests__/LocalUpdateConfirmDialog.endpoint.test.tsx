import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));
vi.mock('@/components/ui/modal', () => ({
  ConfirmModal: ({ open, title, children, kicker, onConfirm, onOpenChange, confirmDisabled, hint }: {
    open: boolean; title: string; children: React.ReactNode; kicker: string;
    onConfirm: () => void; onOpenChange: (open: boolean) => void;
    confirmDisabled?: boolean; hint?: React.ReactNode;
  }) => open ? (
    <div>
      <span>{kicker}</span>
      <h2>{title}</h2>
      {hint ? <span>{hint}</span> : null}
      {children}
      <button type="button" onClick={onConfirm} disabled={confirmDisabled}>confirm</button>
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
  it('offers the provider with Sencho on Reapply and passes the choice to the confirm', async () => {
    answer({ state: 'available', service: 'socket-proxy', containerName: 'stack-socket-proxy-1', providerOnly: true, project: 'stack' });
    const onConfirm = vi.fn();
    render(<LocalUpdateConfirmDialog open mode="reapply" nodeId={4} onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    expect(apiFetchMock).toHaveBeenCalledWith('/fleet/nodes/4/endpoint-provider', { localOnly: true });
    await userEvent.click(await screen.findByRole('radio', { name: 'Sencho + endpoint' }));
    await userEvent.click(screen.getByText('confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ replaceEndpointProvider: true, endpointProviderOnly: false });
  });

  it('offers endpoint-only when the caller allows it, and keeps Sencho running', async () => {
    answer({ state: 'available', service: 'socket-proxy', containerName: 'c', providerOnly: true, project: 'stack' });
    const onConfirm = vi.fn();
    render(<LocalUpdateConfirmDialog open mode="reapply" nodeId={4} nodeName="edge-1" allowEndpointProviderOnly onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    await userEvent.click(await screen.findByRole('radio', { name: 'Endpoint only' }));
    expect(screen.getByText(/Recreates only/)).toBeInTheDocument();
    expect(screen.getByText(/Sencho keeps running and reconnects/)).toBeInTheDocument();
    expect(screen.getByText('KEEPS Sencho running')).toBeInTheDocument();
    await userEvent.click(screen.getByText('confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ replaceEndpointProvider: true, endpointProviderOnly: true });
  });

  it('does not offer endpoint-only on a node whose build cannot leave Sencho running', async () => {
    answer({ state: 'available', service: 'socket-proxy', containerName: 'c', providerOnly: false, project: 'stack' });
    render(<LocalUpdateConfirmDialog open mode="reapply" nodeId={4} allowEndpointProviderOnly onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    await screen.findByRole('radio', { name: 'Sencho + endpoint' });
    expect(screen.queryByRole('radio', { name: 'Endpoint only' })).not.toBeInTheDocument();
  });

  it('does not offer endpoint-only for a Fleet reapply that recreates Sencho', async () => {
    answer({ state: 'available', service: 'socket-proxy', containerName: 'c', providerOnly: true, project: 'stack' });
    render(<LocalUpdateConfirmDialog open mode="reapply" nodeId={4} onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    await screen.findByRole('radio', { name: 'Sencho + endpoint' });
    expect(screen.queryByRole('radio', { name: 'Endpoint only' })).not.toBeInTheDocument();
  });

  it('preselects endpoint-only for a handoff and blocks confirm until the option is known', async () => {
    let release: (value: Response) => void = () => {};
    apiFetchMock.mockReturnValue(new Promise<Response>(resolve => { release = resolve; }));
    const onConfirm = vi.fn();
    render(<LocalUpdateConfirmDialog open mode="reapply" nodeId={4} allowEndpointProviderOnly initialScope="only" onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    expect(screen.getByText('confirm')).toBeDisabled();
    release(new Response(JSON.stringify({ state: 'available', service: 'socket-proxy', containerName: 'c', providerOnly: true, project: 'stack' }), { status: 200 }));
    await waitFor(() => expect(screen.getByText('confirm')).toBeEnabled());
    await userEvent.click(screen.getByText('confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ replaceEndpointProvider: true, endpointProviderOnly: true });
  });

  it('confirms without the provider when the scope stays on Sencho', async () => {
    answer({ state: 'available', service: 'socket-proxy', containerName: 'c', providerOnly: true, project: 'stack' });
    const onConfirm = vi.fn();
    render(<LocalUpdateConfirmDialog open nodeId={1} onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    await screen.findByRole('checkbox');
    await userEvent.click(screen.getByText('confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ replaceEndpointProvider: false, endpointProviderOnly: false });
  });

  it.each([
    ['local', undefined],
    ['remote', 'remote'],
  ] as Array<[string, 'remote' | undefined]>)('submits a checked Update checkbox for the %s node', async (_label, nodeType) => {
    answer({ state: 'available', service: 'socket-proxy', containerName: 'c', providerOnly: true, project: 'stack' });
    const onConfirm = vi.fn();
    render(<LocalUpdateConfirmDialog open nodeType={nodeType} nodeId={1} onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    await userEvent.click(await screen.findByRole('checkbox'));
    await userEvent.click(screen.getByText('confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ replaceEndpointProvider: true, endpointProviderOnly: false });
  });

  it('submits an unchecked remote Update without the provider', async () => {
    answer({ state: 'available', service: 'socket-proxy', containerName: 'c', providerOnly: true, project: 'stack' });
    const onConfirm = vi.fn();
    render(<LocalUpdateConfirmDialog open nodeType="remote" nodeId={1} onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    await screen.findByRole('checkbox');
    await userEvent.click(screen.getByText('confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ replaceEndpointProvider: false, endpointProviderOnly: false });
  });

  it('forgets the choice when the dialog is cancelled', async () => {
    answer({ state: 'available', service: 'socket-proxy', containerName: 'c', providerOnly: true, project: 'stack' });
    const onConfirm = vi.fn();
    const { rerender } = render(<LocalUpdateConfirmDialog open nodeId={1} onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    await userEvent.click(await screen.findByRole('checkbox'));
    await userEvent.click(screen.getByText('cancel'));
    rerender(<LocalUpdateConfirmDialog open={false} nodeId={1} onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    rerender(<LocalUpdateConfirmDialog open nodeId={1} onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    expect(await screen.findByRole('checkbox')).not.toBeChecked();
  });

  it('names a provider it cannot replace, with the reason, and offers no choice', async () => {
    answer({ state: 'unavailable', service: 'docker-proxy', reason: 'It is not a service of Sencho\'s own Compose project.' });
    const onConfirm = vi.fn();
    render(<LocalUpdateConfirmDialog open mode="reapply" nodeId={2} allowEndpointProviderOnly onOpenChange={vi.fn()} onConfirm={onConfirm} />);
    expect(await screen.findByText(/left running: It is not a service/)).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    await userEvent.click(screen.getByText('confirm'));
    expect(onConfirm).toHaveBeenCalledWith({ replaceEndpointProvider: false, endpointProviderOnly: false });
  });

  it.each([
    [{ state: 'none' }],
    [{ state: 'unsupported' }],
  ])('shows no choice for %o on an update', async (payload) => {
    answer(payload);
    render(<LocalUpdateConfirmDialog open nodeId={2} onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
  });

  it('explains that there is no endpoint to recreate when the handoff node has none', async () => {
    answer({ state: 'none' });
    render(<LocalUpdateConfirmDialog open mode="reapply" nodeId={2} allowEndpointProviderOnly initialScope="only" onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    expect(await screen.findByText(/reaches Docker without a container/)).toBeInTheDocument();
    expect(screen.getByText('confirm')).toBeDisabled();
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

  it('uses endpoint-only copy for a remote Reapply instead of claiming a restart', async () => {
    answer({ state: 'available', service: 'socket-proxy', containerName: 'c', providerOnly: true, project: 'stack' });
    render(<LocalUpdateConfirmDialog open mode="reapply" nodeType="remote" nodeId={4} nodeName="edge-1" allowEndpointProviderOnly onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    await userEvent.click(await screen.findByRole('radio', { name: 'Endpoint only' }));
    const body = screen.getByText(/Recreates only/);
    expect(body.textContent).toContain('socket-proxy');
    expect(body.textContent).toContain('edge-1');
    expect(body.textContent).toContain('Sencho keeps running');
    expect(body.textContent).not.toMatch(/restart/i);
    expect(screen.getByText('KEEPS Sencho running')).toBeInTheDocument();
  });

  it('uses remote copy for a remote update', () => {
    answer({ state: 'none' });
    render(<LocalUpdateConfirmDialog open nodeType="remote" nodeId={2} targetVersion="0.99.0" onOpenChange={vi.fn()} onConfirm={vi.fn()} />);
    expect(screen.getByText('REMOTE · UPDATE')).toBeInTheDocument();
    expect(screen.getByText('Update node')).toBeInTheDocument();
    expect(screen.getByText(/on this node and restarts it/)).toBeInTheDocument();
  });
});
