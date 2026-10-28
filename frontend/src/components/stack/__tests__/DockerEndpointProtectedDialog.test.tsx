import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const apiFetchMock = vi.fn();
vi.mock('@/lib/api', () => ({ apiFetch: (...args: unknown[]) => apiFetchMock(...args) }));

import { DockerEndpointProtectedDialog } from '../DockerEndpointProtectedDialog';

function option(payload: unknown) {
  apiFetchMock.mockResolvedValue(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }));
}

function renderDialog(over: Partial<React.ComponentProps<typeof DockerEndpointProtectedDialog>> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    message: 'This deploy would recreate socket-proxy, which carries Sencho\'s Docker connection.',
    reason: 'provider' as const,
    service: 'socket-proxy',
    nodeId: 4,
    nodeName: 'edge-1',
    canRecreate: true,
    onRecreate: vi.fn(),
    ...over,
  };
  render(<DockerEndpointProtectedDialog {...props} />);
  return props;
}

beforeEach(() => { apiFetchMock.mockReset(); });

describe('DockerEndpointProtectedDialog', () => {
  it('names the provider and opens the safe preview for the same node and service', async () => {
    option({ state: 'available', service: 'socket-proxy', containerName: 'edge-socket-proxy-1', providerOnly: true, project: 'stack' });
    const props = renderDialog();
    expect(await screen.findByText(/Recreating socket-proxy in Compose project stack replaces only that container/)).toBeInTheDocument();
    expect(screen.getByText('KEEPS Sencho running')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Recreate endpoint/ }));
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
    expect(props.onRecreate).toHaveBeenCalledTimes(1);
  });

  it('offers nothing when the protected service is not the node\'s Docker endpoint', async () => {
    option({ state: 'available', service: 'socket-proxy', containerName: 'edge-socket-proxy-1', providerOnly: true, project: 'stack' });
    const props = renderDialog({ service: 'some-labeled-service' });
    expect(await screen.findByText(/recreating the Docker endpoint would not change it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(props.onRecreate).not.toHaveBeenCalled();
  });

  it('offers nothing when the node can only replace the endpoint together with Sencho', async () => {
    option({ state: 'available', service: 'socket-proxy', containerName: 'c', providerOnly: false, project: 'stack' });
    const props = renderDialog();
    expect(await screen.findByText(/can only recreate its Docker endpoint together with Sencho/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(props.onRecreate).not.toHaveBeenCalled();
  });

  it('offers nothing for Sencho itself and points at the reapply path', async () => {
    option({ state: 'available', service: 'socket-proxy', containerName: 'c', providerOnly: true, project: 'stack' });
    const props = renderDialog({ reason: 'sencho', service: 'sencho' });
    expect(await screen.findByText(/would stop the Sencho container itself/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
    expect(props.onRecreate).not.toHaveBeenCalled();
  });

  it('explains why an unavailable provider cannot be replaced', async () => {
    option({ state: 'unavailable', service: 'docker-proxy', reason: 'It is not a service of Sencho\'s own Compose project.' });
    renderDialog({ service: 'docker-proxy' });
    expect(await screen.findByText(/cannot be recreated from here: It is not a service/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument();
  });

  it('offers nothing to a caller who cannot reapply the node', async () => {
    option({ state: 'available', service: 'socket-proxy', containerName: 'c', providerOnly: true, project: 'stack' });
    renderDialog({ canRecreate: false, onRecreate: undefined });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalled());
    expect(screen.getByText(/An admin who can reapply/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Got it' })).toBeInTheDocument();
  });

  it('shows the guard\'s own message', () => {
    option({ state: 'none' });
    renderDialog({ message: 'Deploy refused: the proxy would be recreated.' });
    expect(screen.getByText('Deploy refused: the proxy would be recreated.')).toBeInTheDocument();
  });
});
