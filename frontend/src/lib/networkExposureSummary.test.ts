/**
 * The redacted networking + exposure summary for the dossier export: it carries
 * only names, intents, port numbers, and binding scope, never env or label
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
      services: [{ name: 'web', intent: 'public', ports: ['8080/tcp (all interfaces)', '9000/tcp (loopback)'], hostNetwork: false }],
    });
  });
  it('flags a host-network service as host-exposed even with no published ports', () => {
    const s = buildNetworkExposureSummary({ renderable: true, networks: [], services: [{ name: 'app', publishedPorts: [], networkMode: 'host' }] }, []);
    expect(s).toEqual({
      stackIntent: null,
      networks: [],
      services: [{ name: 'app', intent: null, ports: [], hostNetwork: true }],
    });
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
