import { describe, expect, it } from 'vitest';
import { parseEffectiveModel, type EffResource } from '../services/preflight/effectiveModel';
import { classifyMissingExternalNetworks } from '../services/network/missingExternalNetworks';
import { isValidDockerNetworkName } from '../services/network/dockerNetworkName';

function net(partial: Partial<EffResource> & Pick<EffResource, 'name' | 'external'>): EffResource {
  return {
    internal: false,
    driverKind: 'default',
    hasDriverOpts: false,
    hasCustomIpam: false,
    attachable: false,
    ipv4Enabled: true,
    ipv6Enabled: false,
    hasLabels: false,
    ...partial,
  };
}

function model(networks: Record<string, EffResource>) {
  return { projectName: 'proj', services: [], networks, volumes: {} };
}

describe('isValidDockerNetworkName', () => {
  it('accepts docker-safe names', () => {
    expect(isValidDockerNetworkName('proxy')).toBe(true);
    expect(isValidDockerNetworkName('a.b_c-1')).toBe(true);
  });
  it('rejects invalid names', () => {
    expect(isValidDockerNetworkName('')).toBe(false);
    expect(isValidDockerNetworkName('-bad')).toBe(false);
    expect(isValidDockerNetworkName('has space')).toBe(false);
  });
});

describe('parseEffectiveModel network metadata', () => {
  it('treats empty ipam {} as safe (no custom IPAM)', () => {
    const m = parseEffectiveModel({
      name: 'proj',
      networks: {
        proxy: { name: 'proxy', external: true, ipam: {} },
      },
    }, 'proj');
    expect(m.networks.proxy.hasCustomIpam).toBe(false);
    expect(m.networks.proxy.driverKind).toBe('default');
  });

  it('detects custom IPAM and never retains option values', () => {
    const m = parseEffectiveModel({
      name: 'proj',
      networks: {
        proxy: {
          name: 'proxy',
          external: true,
          ipam: { driver: 'default', config: [{ subnet: '10.0.0.0/24' }] },
          labels: { secret: 'should-not-leak' },
          driver_opts: { 'com.example': 'x' },
        },
      },
    }, 'proj');
    expect(m.networks.proxy.hasCustomIpam).toBe(true);
    expect(m.networks.proxy.hasLabels).toBe(true);
    expect(m.networks.proxy.hasDriverOpts).toBe(true);
    expect(JSON.stringify(m.networks.proxy)).not.toContain('should-not-leak');
    expect(JSON.stringify(m.networks.proxy)).not.toContain('10.0.0.0');
  });

  it('maps arbitrary interpolated drivers to custom without retaining the raw string', () => {
    const m = parseEffectiveModel({
      name: 'proj',
      networks: {
        proxy: { name: 'proxy', external: true, driver: 'resolved-from-env-SECRET' },
      },
    }, 'proj');
    expect(m.networks.proxy.driverKind).toBe('custom');
    expect(JSON.stringify(m.networks.proxy)).not.toContain('SECRET');
    expect(JSON.stringify(m.networks.proxy)).not.toContain('resolved-from-env');
  });

  it('flags internal, attachable, ipv4 disabled, ipv6 enabled', () => {
    const m = parseEffectiveModel({
      name: 'proj',
      networks: {
        n: {
          name: 'n',
          external: true,
          internal: true,
          attachable: true,
          enable_ipv4: false,
          enable_ipv6: true,
        },
      },
    }, 'proj');
    expect(m.networks.n.internal).toBe(true);
    expect(m.networks.n.attachable).toBe(true);
    expect(m.networks.n.ipv4Enabled).toBe(false);
    expect(m.networks.n.ipv6Enabled).toBe(true);
  });
});

describe('classifyMissingExternalNetworks', () => {
  it('returns nothing when the network exists', () => {
    const missing = classifyMissingExternalNetworks(
      model({ proxy: net({ name: 'proxy', external: true }) }),
      new Set(['proxy']),
    );
    expect(missing).toEqual([]);
  });

  it('classifies a safe missing bridge/default network', () => {
    const missing = classifyMissingExternalNetworks(
      model({ proxy: net({ name: 'proxy', external: true }) }),
      new Set(),
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      name: 'proxy',
      keys: ['proxy'],
      safe: true,
      creationSpec: { driver: 'bridge', options: 'default' },
      unsupportedFeatures: [],
    });
  });

  it('dedupes by runtime name and keeps all Compose keys', () => {
    const missing = classifyMissingExternalNetworks(
      model({
        a: net({ name: 'shared-net', external: true, driverKind: 'bridge' }),
        b: net({ name: 'shared-net', external: true, driverKind: 'overlay' }),
      }),
      new Set(),
    );
    expect(missing).toHaveLength(1);
    expect(missing[0].keys).toEqual(['a', 'b']);
    expect(missing[0].safe).toBe(false);
    expect(missing[0].blockReason).toBe('unsupported_driver');
    expect(missing[0].declarations.map((d) => d.driverKind).sort()).toEqual(['bridge', 'overlay']);
    expect(missing[0].creationSpec).toBeNull();
  });

  it('unions unsupported features across keys and stable-sorts them', () => {
    const missing = classifyMissingExternalNetworks(
      model({
        a: net({ name: 'n', external: true, internal: true }),
        b: net({ name: 'n', external: true, hasLabels: true, ipv6Enabled: true }),
      }),
      new Set(),
    );
    expect(missing[0].unsupportedFeatures).toEqual(['labels', 'internal', 'ipv6_enabled']);
    expect(missing[0].blockReason).toBe('unsupported_options');
  });

  it('blocks reserved system names', () => {
    const missing = classifyMissingExternalNetworks(
      model({ hostnet: net({ name: 'host', external: true }) }),
      new Set(),
    );
    expect(missing[0].blockReason).toBe('reserved_system');
    expect(missing[0].safe).toBe(false);
  });

  it('blocks invalid names', () => {
    const missing = classifyMissingExternalNetworks(
      model({ bad: net({ name: '-nope', external: true }) }),
      new Set(),
    );
    expect(missing[0].blockReason).toBe('invalid_name');
  });

  it('never serializes a raw custom driver string', () => {
    const missing = classifyMissingExternalNetworks(
      model({
        x: net({ name: 'x', external: true, driverKind: 'custom' }),
      }),
      new Set(),
    );
    expect(JSON.stringify(missing)).not.toMatch(/driver:\s*"/);
    expect(missing[0].declarations[0].driverKind).toBe('custom');
  });
});
