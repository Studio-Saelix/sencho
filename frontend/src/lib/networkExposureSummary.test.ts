/**
 * The redacted networking + exposure summary for the dossier export: it carries
 * only names, intents, port labels, and binding scope, never env or label
 * values, and renders nothing when there is nothing to document.
 */
import { describe, it, expect } from 'vitest';
import { buildNetworkExposureSummary, networkExposureSection } from './networkExposureSummary';

const facts = (over: Record<string, unknown> = {}) => ({
  renderable: true,
  networks: [{ name: 'app_backend', external: false, internal: true }],
  services: [{
    name: 'web',
    publishedPorts: [
      { startPort: 8080, endPort: 8080, protocol: 'tcp', allInterfaces: true, loopbackOnly: false },
      { startPort: 9000, endPort: 9000, protocol: 'tcp', allInterfaces: false, loopbackOnly: true },
    ],
  }],
  ...over,
});

describe('buildNetworkExposureSummary', () => {
  it('returns null when the model is not renderable', () => {
    expect(buildNetworkExposureSummary({ renderable: false }, [])).toBeNull();
  });
  it('returns null when there is nothing worth documenting', () => {
    expect(buildNetworkExposureSummary({ renderable: true, networks: [], services: [{ name: 'web', publishedPorts: [] }] }, [])).toBeNull();
  });
  it('summarizes networks, intents, and ports with their binding scope', () => {
    const s = buildNetworkExposureSummary(facts(), [{ service: '', intent: 'internal' }, { service: 'web', intent: 'public' }]);
    expect(s).toEqual({
      stackIntent: 'internal',
      networks: [{ name: 'app_backend', external: false, internal: true }],
      services: [{ name: 'web', intent: 'public', ports: ['8080/tcp (all interfaces)', '9000/tcp (loopback)'], hostNetwork: false, tunnel: null }],
    });
  });
  it('names a port Docker assigns as auto-assigned, with no invented number', () => {
    const s = buildNetworkExposureSummary({
      renderable: true,
      networks: [],
      services: [{ name: 'vpn', publishedPorts: [
        { startPort: 0, endPort: 0, protocol: 'udp', dynamic: true, allInterfaces: true, loopbackOnly: false },
        { startPort: 0, endPort: 0, protocol: 'tcp', dynamic: true, allInterfaces: false, loopbackOnly: true },
      ] }],
    }, []);
    expect(s?.services[0].ports).toEqual(['auto-assigned/udp (all interfaces)', 'auto-assigned/tcp (loopback)']);
    expect(networkExposureSection(s)).toContain('ports auto-assigned/udp (all interfaces), auto-assigned/tcp (loopback)');
  });
  it('flags a host-network service as host-exposed even with no published ports', () => {
    const s = buildNetworkExposureSummary({ renderable: true, networks: [], services: [{ name: 'app', publishedPorts: [], networkMode: 'host' }] }, []);
    expect(s).toEqual({
      stackIntent: null,
      networks: [],
      services: [{ name: 'app', intent: null, ports: [], hostNetwork: true, tunnel: null }],
    });
  });
  it('documents a service reached only through a tunnel, naming the connector and unverified routing', () => {
    const s = buildNetworkExposureSummary({
      renderable: true,
      networks: [],
      services: [
        { name: 'cloudflared', publishedPorts: [] },
        { name: 'app', publishedPorts: [], tunnel: { connector: 'cloudflared', provider: 'cloudflared', scope: 'public-edge', path: 'shared-network' } },
      ],
    }, []);
    expect(s?.services.find(x => x.name === 'app')?.tunnel).toBe('via Cloudflare Tunnel (cloudflared), routing unverified');
    expect(networkExposureSection(s)).toContain('- **app:** reachable via Cloudflare Tunnel (cloudflared), routing unverified');
  });
});

describe('networkExposureSection', () => {
  it('renders a section with the redacted facts', () => {
    const md = networkExposureSection(buildNetworkExposureSummary(facts(), [{ service: '', intent: 'public' }]));
    expect(md).toContain('## Network exposure');
    expect(md).toContain('**Stack intent:** public');
    expect(md).toContain('app_backend (internal)');
    expect(md).toContain('8080/tcp (all interfaces)');
  });
  it('returns null for a null summary', () => {
    expect(networkExposureSection(null)).toBeNull();
  });
  it('renders the host-network phrase for a host-mode service', () => {
    const md = networkExposureSection(buildNetworkExposureSummary({ renderable: true, networks: [], services: [{ name: 'app', publishedPorts: [], networkMode: 'host' }] }, [])) ?? '';
    expect(md).toContain('host network (all ports exposed on host)');
  });
  it('never includes a value that lives in an ignored field (no env or label leak)', () => {
    // A secret planted in fields the builder does not read must not surface.
    const leaky = facts({
      services: [{ name: 'web', publishedPorts: [], env: { TOKEN: 'SECRET-9f3a' }, labels: { x: 'LABEL-SECRET' } }],
      networks: [{ name: 'app_backend', external: false, internal: false, driver: 'SECRET-DRIVER' }],
    });
    const md = networkExposureSection(buildNetworkExposureSummary(leaky, [{ service: '', intent: 'internal' }])) ?? '';
    expect(md).not.toContain('SECRET-9f3a');
    expect(md).not.toContain('LABEL-SECRET');
    expect(md).not.toContain('SECRET-DRIVER');
  });
});

describe('tunnel path labels', () => {
  it('marks a host-network reach as unverified like a shared network', () => {
    const s = buildNetworkExposureSummary({
      renderable: true,
      networks: [],
      services: [{ name: 'app', publishedPorts: [], tunnel: { connector: 'cf', provider: 'cloudflared', scope: 'public-edge', path: 'host-network' } }],
    }, []);
    expect(s?.services[0]?.tunnel).toBe('via Cloudflare Tunnel (cf), routing unverified');
  });
  it('omits the caveat for a Tailscale shared namespace', () => {
    const s = buildNetworkExposureSummary({
      renderable: true,
      networks: [],
      services: [{ name: 'admin', publishedPorts: [], tunnel: { connector: 'ts', provider: 'tailscale', scope: 'private-overlay', path: 'shared-namespace' } }],
    }, []);
    expect(s?.services[0]?.tunnel).toBe('via Tailscale (ts)');
  });
  it('keeps the caveat for a cloudflared shared namespace', () => {
    const s = buildNetworkExposureSummary({
      renderable: true,
      networks: [],
      services: [{ name: 'app', publishedPorts: [], tunnel: { connector: 'cf', provider: 'cloudflared', scope: 'public-edge', path: 'shared-namespace' } }],
    }, []);
    expect(s?.services[0]?.tunnel).toBe('via Cloudflare Tunnel (cf), routing unverified');
  });
});
