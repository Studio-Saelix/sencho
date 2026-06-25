/**
 * Covers the Networking panel: rendering facts (networks, service membership,
 * port binding badges), setting an exposure intent (PUT), the read-only state
 * when the user cannot edit, the runtime-unavailable note, and the unrenderable
 * banner.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ activeNode: { id: 1 } }) }));

import { apiFetch } from '@/lib/api';
import StackNetworkingPanel from './StackNetworkingPanel';

function jsonRes(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => '' } as unknown as Response;
}

function facts(partial: Record<string, unknown> = {}) {
  return {
    stack: 'web', renderable: true, renderError: null, runtime: 'available',
    networks: [{ key: 'backend', name: 'web_backend', external: false, internal: true, createdByStack: true }],
    services: [{
      name: 'api',
      networks: [{ key: 'backend', aliases: ['db'] }],
      publishedPorts: [
        { hostIp: '0.0.0.0', startPort: 8080, endPort: 8080, protocol: 'tcp', allInterfaces: true, loopbackOnly: false },
        { hostIp: '127.0.0.1', startPort: 9000, endPort: 9000, protocol: 'tcp', allInterfaces: false, loopbackOnly: true },
      ],
      extraHosts: [],
    }],
    drift: { runtimeOnlyAttachments: [], declaredButUnused: [], missingFromRuntime: [], foreignNetworkAttachments: [] },
    ...partial,
  };
}

/** Route apiFetch by URL + method; a PUT echoes its request into the response. */
function mockApi(factsBody: Record<string, unknown>, intents: unknown[] = [], factsOk = true) {
  vi.mocked(apiFetch).mockImplementation((url: string, opts?: RequestInit) => {
    if (url.endsWith('/networking')) return Promise.resolve(jsonRes(factsBody, factsOk));
    if (url.endsWith('/exposure') && opts?.method === 'PUT') {
      const body = JSON.parse(opts.body as string);
      return Promise.resolve(jsonRes({ intents: body.intent === null ? [] : [{ service: body.service, intent: body.intent }] }));
    }
    if (url.endsWith('/exposure')) return Promise.resolve(jsonRes({ intents }));
    return Promise.resolve(jsonRes({}));
  });
}

const putBodies = () => vi.mocked(apiFetch).mock.calls.filter(c => c[1]?.method === 'PUT').map(c => JSON.parse(c[1]!.body as string));

beforeEach(() => { vi.clearAllMocks(); });

describe('StackNetworkingPanel', () => {
  it('renders networks, service membership, and both binding badges', async () => {
    mockApi(facts());
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    expect(await screen.findByText('web_backend')).toBeInTheDocument();
    expect(screen.getByText(/\(db\)/)).toBeInTheDocument(); // network alias in parens
    expect(screen.getByText('all interfaces')).toBeInTheDocument();
    expect(screen.getByText('loopback')).toBeInTheDocument();
    expect(screen.getByText(/runtime matches compose/i)).toBeInTheDocument(); // no-drift success card
  });

  it('marks a host-network service as host-exposed', async () => {
    mockApi(facts({
      services: [{ name: 'app', networks: [], publishedPorts: [], networkMode: 'host', extraHosts: [] }],
    }));
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    await screen.findByText('web_backend');
    expect(screen.getByText('host-exposed')).toBeInTheDocument();
    expect(screen.getByText('all container ports')).toBeInTheDocument();
  });

  it('saves a stack-level exposure intent on click', async () => {
    mockApi(facts());
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    await screen.findByText('web_backend');
    fireEvent.click(screen.getAllByRole('button', { name: 'internal' })[0]);
    await waitFor(() => expect(putBodies()).toContainEqual({ service: '', intent: 'internal' }));
  });

  it('saves a per-service intent under the service name', async () => {
    mockApi(facts());
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    await screen.findByText('web_backend');
    // [0] is the stack row, [1] is the 'api' service row.
    fireEvent.click(screen.getAllByRole('button', { name: 'internal' })[1]);
    await waitFor(() => expect(putBodies()).toContainEqual({ service: 'api', intent: 'internal' }));
  });

  it('clears a service intent (inherit) by sending intent null', async () => {
    mockApi(facts());
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    await screen.findByText('web_backend');
    // The stack row shows "unset"; the service row shows "inherit".
    expect(screen.getByRole('button', { name: 'unset' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'inherit' }));
    await waitFor(() => expect(putBodies()).toContainEqual({ service: 'api', intent: null }));
  });

  it('disables the intent controls when the user cannot edit', async () => {
    mockApi(facts());
    render(<StackNetworkingPanel stackName="web" canEdit={false} doctorEnabled />);
    await screen.findByText('web_backend');
    const internalPills = screen.getAllByRole('button', { name: 'internal' });
    expect(internalPills[0]).toBeDisabled();
    fireEvent.click(internalPills[0]);
    expect(vi.mocked(apiFetch).mock.calls.some(c => c[1]?.method === 'PUT')).toBe(false);
  });

  it('shows a runtime-unavailable note instead of computing drift', async () => {
    mockApi(facts({ runtime: 'unavailable' }));
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    expect(await screen.findByText(/runtime unavailable/i)).toBeInTheDocument();
  });

  it('shows the unrenderable banner when the model cannot render', async () => {
    mockApi(facts({ renderable: false, renderError: 'bad compose', networks: [], services: [] }));
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    expect(await screen.findByText(/cannot render/i)).toBeInTheDocument();
    expect(screen.getByText('bad compose')).toBeInTheDocument();
  });

  it('renders runtime drift rows', async () => {
    mockApi(facts({
      drift: {
        runtimeOnlyAttachments: [{ container: 'api-1', service: 'api', network: 'web_rogue' }],
        foreignNetworkAttachments: [{ container: 'api-1', network: 'other_net' }],
        declaredButUnused: ['web_idle'],
        missingFromRuntime: ['web_gone'],
      },
    }));
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    await screen.findByText('web_backend');
    expect(screen.getByText('web_rogue')).toBeInTheDocument();
    expect(screen.getByText('other_net')).toBeInTheDocument();
    expect(screen.getByText('web_idle')).toBeInTheDocument();
    expect(screen.getByText('web_gone')).toBeInTheDocument();
  });

  it('shows an error with retry when the facts fetch fails, and retry refetches', async () => {
    mockApi(facts(), [], false);
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    expect(await screen.findByText(/Could not load the networking view/i)).toBeInTheDocument();
    const before = vi.mocked(apiFetch).mock.calls.filter(c => String(c[0]).endsWith('/networking')).length;
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    await waitFor(() => {
      const after = vi.mocked(apiFetch).mock.calls.filter(c => String(c[0]).endsWith('/networking')).length;
      expect(after).toBeGreaterThan(before);
    });
  });
});
