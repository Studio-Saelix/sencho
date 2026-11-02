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
const nodeState = vi.hoisted(() => ({ id: 1 }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ activeNode: { id: nodeState.id } }) }));

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

beforeEach(() => { vi.clearAllMocks(); nodeState.id = 1; });

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

  it('labels a port Docker assigns as auto-assigned instead of port 0', async () => {
    mockApi(facts({
      services: [{
        name: 'vpn', networks: [], extraHosts: [],
        publishedPorts: [{ hostIp: '', startPort: 0, endPort: 0, protocol: 'udp', dynamic: true, allInterfaces: true, loopbackOnly: false }],
      }],
    }));
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    expect(await screen.findByText('auto-assigned/udp')).toBeInTheDocument();
    expect(screen.getByText('all interfaces')).toBeInTheDocument();
    expect(screen.queryByText('0/udp')).not.toBeInTheDocument();
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

  it('names the tunnel connector and the tunnel that reaches each service', async () => {
    const tunnelCf = { connector: 'cloudflared', provider: 'cloudflared', scope: 'public-edge', path: 'shared-network' };
    const tunnelTs = { connector: 'tailscale', provider: 'tailscale', scope: 'private-overlay', path: 'shared-namespace' };
    mockApi(facts({
      services: [
        { name: 'cloudflared', networks: [], publishedPorts: [], extraHosts: [] },
        { name: 'tailscale', networks: [], publishedPorts: [], extraHosts: [] },
        { name: 'app', networks: [], publishedPorts: [], extraHosts: [], tunnel: tunnelCf },
        { name: 'admin', networks: [], publishedPorts: [], networkMode: 'service:tailscale', extraHosts: [], tunnel: tunnelTs },
      ],
      tunnels: [
        { service: 'cloudflared', provider: 'cloudflared', scope: 'public-edge', attachment: 'networks', signals: ['image'], localConfig: false, serveConfig: false, meshAttached: false, externalNetworks: [], reaches: [{ service: 'app', path: 'shared-network', networks: ['default'] }] },
        { service: 'tailscale', provider: 'tailscale', scope: 'private-overlay', attachment: 'networks', signals: ['image'], localConfig: false, serveConfig: false, meshAttached: false, externalNetworks: [], reaches: [{ service: 'admin', path: 'shared-namespace', networks: [] }] },
      ],
    }));
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    await screen.findByText('web_backend');
    expect(screen.getByText('Cloudflare Tunnel connector · public edge')).toBeInTheDocument();
    expect(screen.getByText('Tailscale connector · private overlay')).toBeInTheDocument();
    expect(screen.getByText('via Cloudflare Tunnel (cloudflared) · public edge')).toBeInTheDocument();
    expect(screen.getByText('via Tailscale (tailscale) · private overlay')).toBeInTheDocument();
    // Only the shared-network reach is unverified; the namespace reach is certain.
    expect(screen.getAllByText('routing unverified')).toHaveLength(1);
  });

  it('renders facts from a node that predates tunnel detection', async () => {
    mockApi(facts());
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    await screen.findByText('web_backend');
    expect(screen.queryByText(/connector ·/)).not.toBeInTheDocument();
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

  it('dispatches the node-navigate event to open the Networking page', async () => {
    mockApi(facts());
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    await screen.findByText('web_backend');
    const handler = vi.fn();
    window.addEventListener('sencho-navigate', handler);
    fireEvent.click(screen.getByText(/view node networking/i));
    expect(handler).toHaveBeenCalledTimes(1);
    const detail = (handler.mock.calls[0][0] as CustomEvent).detail;
    expect(detail).toEqual({ view: 'networking' });
    window.removeEventListener('sencho-navigate', handler);
  });
});

/** A detected exposure value with every field the panel reads. */
function detected(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: 'paths',
    paths: [{ kind: 'host-port', scope: 'host-published', bind: 'all-interfaces', hostIp: '0.0.0.0', startPort: 8080, endPort: 8080, protocol: 'tcp' }],
    incomplete: [],
    externalNetworks: [],
    runtimeChecked: true,
    conflicts: { internal: [], 'same-node': [], lan: [], 'reverse-proxy': [], public: [], temporary: [], unknown: [] },
    suggestedIntent: null,
    answer: 'host-published',
    ...over,
  };
}

function service(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, networks: [], publishedPorts: [], extraHosts: [], ...over };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('StackNetworkingPanel: detected exposure', () => {
  it('shows auto (detected) and the answer when nothing is declared', async () => {
    mockApi(facts({ services: [service('api', { detected: detected() })] }), []);
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    expect(await screen.findByText('detected: host-published')).toBeInTheDocument();
    expect(screen.getAllByText('→ auto (detected)').length).toBeGreaterThan(0);
  });

  it('shows the inherited intent instead of auto once the stack declares one', async () => {
    mockApi(facts({ services: [service('api', { detected: detected() })] }), [{ service: '', intent: 'internal' }]);
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    await screen.findByText('detected: host-published');
    expect(screen.getByRole('button', { name: 'inherit' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('→ internal')).toBeInTheDocument();
    expect(screen.queryByText('→ auto (detected)')).not.toBeInTheDocument();
  });

  it('shows the answer but no adoption for a declared unknown', async () => {
    mockApi(facts({ services: [service('api', { detected: detected({ answer: 'no known exposure path', status: 'none-known', paths: [], suggestedIntent: 'same-node' }) })] }), [{ service: '', intent: 'unknown' }]);
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    expect(await screen.findByText('detected: no known exposure path')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /use same-node/i })).not.toBeInTheDocument();
  });

  it('renders a conflict, a possible conflict and an informational note', async () => {
    const conflict = detected({
      paths: [{ kind: 'host-port', scope: 'host-published', bind: 'all-interfaces', hostIp: '0.0.0.0', startPort: 8080, endPort: 8080, protocol: 'tcp' }],
      conflicts: { internal: [{ level: 'conflict', reason: 'host-port', paths: [0] }], 'same-node': [], lan: [], 'reverse-proxy': [], public: [], temporary: [], unknown: [] },
    });
    mockApi(facts({ services: [service('api', { detected: conflict })] }), [{ service: '', intent: 'internal' }]);
    const { unmount } = render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    expect(await screen.findByText('conflicts with internal: published port')).toBeInTheDocument();
    unmount();

    const possible = detected({
      paths: [{ kind: 'tunnel', scope: 'public-edge', provider: 'cloudflared', connector: 'cf', path: 'shared-network', certain: false }],
      answer: 'public edge (unverified)',
      conflicts: { internal: [{ level: 'possible', reason: 'tunnel', paths: [0] }], 'same-node': [], lan: [], 'reverse-proxy': [], public: [], temporary: [], unknown: [] },
    });
    mockApi(facts({ services: [service('api', { detected: possible })] }), [{ service: '', intent: 'internal' }]);
    const second = render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    expect(await screen.findByText('may conflict with internal: tunnel')).toBeInTheDocument();
    second.unmount();

    const note = detected({
      answer: 'host-published',
      conflicts: { internal: [], 'same-node': [], lan: [], 'reverse-proxy': [{ level: 'note', reason: 'broad-bind', paths: [0] }], public: [], temporary: [], unknown: [] },
    });
    mockApi(facts({ services: [service('api', { detected: note })] }), [{ service: '', intent: 'reverse-proxy' }]);
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    expect(await screen.findByText('broad bind alongside reverse-proxy')).toBeInTheDocument();
  });

  it('shows no chip for an intent the facts agree with', async () => {
    mockApi(facts({ services: [service('api', { detected: detected() })] }), [{ service: '', intent: 'public' }]);
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    await screen.findByText('detected: host-published');
    expect(screen.queryByText(/conflicts with/)).not.toBeInTheDocument();
    expect(screen.queryByText(/alongside/)).not.toBeInTheDocument();
  });

  it('offers Use same-node only with no effective intent, edit access and a suggestion', async () => {
    const adoptable = detected({
      paths: [{ kind: 'host-port', scope: 'host-loopback', bind: 'loopback', hostIp: '127.0.0.1', startPort: 3000, endPort: 3000, protocol: 'tcp' }],
      answer: 'same host only',
      suggestedIntent: 'same-node',
    });
    mockApi(facts({ services: [service('api', { detected: adoptable })] }), []);
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    await screen.findByText('detected: same host only');
    fireEvent.click(screen.getByRole('button', { name: /use same-node/i }));
    await waitFor(() => expect(putBodies()).toEqual([{ service: 'api', intent: 'same-node' }]));
  });

  it('hides Use same-node without edit access or with a declared intent', async () => {
    const adoptable = detected({ answer: 'same host only', suggestedIntent: 'same-node' });
    mockApi(facts({ services: [service('api', { detected: adoptable })] }), []);
    const readOnly = render(<StackNetworkingPanel stackName="web" canEdit={false} doctorEnabled />);
    await screen.findByText('detected: same host only');
    expect(screen.queryByRole('button', { name: /use same-node/i })).not.toBeInTheDocument();
    readOnly.unmount();

    mockApi(facts({ services: [service('api', { detected: adoptable })] }), [{ service: '', intent: 'internal' }]);
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    await screen.findByText('detected: same host only');
    expect(screen.queryByRole('button', { name: /use same-node/i })).not.toBeInTheDocument();
  });

  it('says detection is not reported by an older node, without inventing an auto label', async () => {
    mockApi(facts({ services: [service('api')] }), []);
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    expect(await screen.findByText('detected exposure is not reported by this node')).toBeInTheDocument();
    expect(screen.queryAllByText('→ auto (detected)')).toHaveLength(0);
  });

  it('lists every tunnel path and the proof line', async () => {
    const multi = detected({
      paths: [
        { kind: 'tunnel', scope: 'public-edge', provider: 'cloudflared', connector: 'cf', path: 'shared-network', certain: false },
        { kind: 'tunnel', scope: 'private-overlay', provider: 'tailscale', connector: 'ts', path: 'shared-network', certain: false },
        { kind: 'host-port', scope: 'host-published', bind: 'all-interfaces', hostIp: '0.0.0.0', startPort: 8080, endPort: 8080, protocol: 'tcp', via: 'app' },
      ],
      incomplete: ['runtime-ports-differ'],
      externalNetworks: ['shared'],
      runtimeChecked: false,
      answer: 'public edge (unverified) + private overlay (unverified) + host-published · partly undetermined',
    });
    mockApi(facts({ services: [service('api', { detected: multi })] }), []);
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    await screen.findByText(/detected: public edge \(unverified\)/);
    expect(screen.getByText('via Cloudflare Tunnel (cf) · public edge')).toBeInTheDocument();
    expect(screen.getByText('via Tailscale (ts) · private overlay')).toBeInTheDocument();
    const proof = screen.getByText(/a running container publishes ports/);
    expect(proof.textContent).toContain('a running container publishes ports the Compose file does not');
    expect(proof.textContent).toContain('the host path comes from "app"');
    expect(proof.textContent).toContain('a connector in another stack on "shared" could reach it');
    expect(proof.textContent).toContain('runtime not checked');
  });
});

describe('StackNetworkingPanel: view freshness', () => {
  it('drops a late load from the previous stack and shows the current one', async () => {
    const webFacts = deferred<Response>();
    const apiFacts = deferred<Response>();
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      if (url === '/stacks/web/networking') return webFacts.promise;
      if (url === '/stacks/api/networking') return apiFacts.promise;
      if (url.endsWith('/exposure')) return Promise.resolve(jsonRes({ intents: [] }));
      return Promise.resolve(jsonRes({}));
    });
    const { rerender } = render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    rerender(<StackNetworkingPanel stackName="api" canEdit doctorEnabled />);
    apiFacts.resolve(jsonRes(facts({ services: [service('api-svc', { detected: detected() })] })));
    await screen.findAllByText('api-svc');
    webFacts.resolve(jsonRes(facts({ services: [service('web-svc', { detected: detected() })] })));
    await waitFor(() => expect(screen.queryAllByText('web-svc')).toHaveLength(0));
  });

  it('drops a late intent write from the previous stack', async () => {
    const put = deferred<Response>();
    vi.mocked(apiFetch).mockImplementation((url: string, opts?: RequestInit) => {
      if (url === '/stacks/web/networking') return Promise.resolve(jsonRes(facts({ services: [service('api', { detected: detected() })] })));
      if (url === '/stacks/api/networking') return Promise.resolve(jsonRes(facts({ services: [service('db')] })));
      if (url.endsWith('/exposure') && opts?.method === 'PUT') return put.promise;
      if (url.endsWith('/exposure')) return Promise.resolve(jsonRes({ intents: [] }));
      return Promise.resolve(jsonRes({}));
    });
    const { rerender } = render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    await screen.findByText('detected: host-published');
    fireEvent.click(screen.getAllByRole('button', { name: 'internal' })[1]);
    rerender(<StackNetworkingPanel stackName="api" canEdit doctorEnabled />);
    await screen.findAllByText('db');
    put.resolve(jsonRes({ intents: [{ service: '', intent: 'internal' }] }));
    await waitFor(() => {
      const pressed = screen.getAllByRole('button', { name: 'internal' }).filter(b => b.getAttribute('aria-pressed') === 'true');
      expect(pressed).toHaveLength(0);
    });
  });

  it('never reuses the previous stack intents when the new read fails', async () => {
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      if (url === '/stacks/web/networking') return Promise.resolve(jsonRes(facts({ services: [service('api', { detected: detected() })] })));
      if (url === '/stacks/api/networking') return Promise.resolve(jsonRes(facts({ services: [service('db')] })));
      if (url === '/stacks/web/exposure') return Promise.resolve(jsonRes({ intents: [{ service: '', intent: 'internal' }] }));
      if (url === '/stacks/api/exposure') return Promise.resolve(jsonRes({ error: 'boom' }, false));
      return Promise.resolve(jsonRes({}));
    });
    const { rerender } = render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    expect(await screen.findByText('→ internal')).toBeInTheDocument();
    rerender(<StackNetworkingPanel stackName="api" canEdit doctorEnabled />);
    await screen.findAllByText('db');
    expect(await screen.findByText(/exposure intent could not be read/)).toBeInTheDocument();
    expect(screen.queryAllByText('→ internal')).toHaveLength(0);
    // A read that failed is not reported as "nothing declared".
    expect(screen.queryAllByText('→ auto (detected)')).toHaveLength(0);
  });

  it('never offers auto or the adoption verb when a read left the intents unknown', async () => {
    const adoptable = detected({
      paths: [{ kind: 'host-port', scope: 'host-loopback', bind: 'loopback', hostIp: '127.0.0.1', startPort: 3000, endPort: 3000, protocol: 'tcp' }],
      answer: 'same host only',
      suggestedIntent: 'same-node',
    });
    vi.mocked(apiFetch).mockImplementation((url: string) => {
      if (url === '/stacks/web/networking') return Promise.resolve(jsonRes(facts({ services: [service('api', { detected: adoptable })] })));
      return Promise.resolve(jsonRes({ error: 'boom' }, false));
    });
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    expect(await screen.findByText('detected: same host only')).toBeInTheDocument();
    expect(screen.getByText(/exposure intent could not be read/)).toBeInTheDocument();
    expect(screen.queryAllByText('→ auto (detected)')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /use same-node/i })).not.toBeInTheDocument();
  });

  it('refetches on refresh without clearing the view or the intents', async () => {
    mockApi(facts({ services: [service('api', { detected: detected() })] }), [{ service: '', intent: 'internal' }]);
    render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    await screen.findByText('detected: host-published');
    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(screen.queryByText('Loading networking…')).not.toBeInTheDocument();
    await waitFor(() => {
      const reads = vi.mocked(apiFetch).mock.calls.filter(c => String(c[0]).endsWith('/networking'));
      expect(reads.length).toBeGreaterThan(1);
    });
    expect(screen.getByText('→ internal')).toBeInTheDocument();
  });

  it('reloads when the active node changes', async () => {
    mockApi(facts({ services: [service('api', { detected: detected() })] }), []);
    const { rerender } = render(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    await screen.findByText('detected: host-published');
    const before = vi.mocked(apiFetch).mock.calls.filter(c => String(c[0]).endsWith('/networking')).length;
    nodeState.id = 2;
    rerender(<StackNetworkingPanel stackName="web" canEdit doctorEnabled />);
    await waitFor(() => {
      const after = vi.mocked(apiFetch).mock.calls.filter(c => String(c[0]).endsWith('/networking')).length;
      expect(after).toBeGreaterThan(before);
    });
  });
});
