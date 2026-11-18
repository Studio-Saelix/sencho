import { describe, expect, it } from 'vitest';
import { filterTopologyNetworks, formatTopologyPort, normalizeTopologyResponse } from './networkingTopology';
import type { NetworkFactPort, NetworkingTopologyNetwork } from '@/types/networking';

const missingNetwork: NetworkingTopologyNetwork = {
  id: 'missing:shared-net', name: 'shared-net', driver: 'unknown', scope: 'local', stack: null,
  isSystem: false, ingress: false, ownership: 'unmanaged', declaredByStacks: [],
  declaredExternalByStacks: ['app'], isExternalDependency: true, runtimeState: 'missing',
  findingIds: ['network-missing'], containers: [],
};

function publishedPort(over: Partial<NetworkFactPort> = {}): NetworkFactPort {
  const hostIp = over.hostIp ?? '';
  return {
    hostIp, startPort: 8080, endPort: 8080, protocol: 'tcp',
    allInterfaces: hostIp === '' || hostIp === '0.0.0.0' || hostIp === '::' || hostIp === '[::]',
    loopbackOnly: hostIp.startsWith('127.') || hostIp === '::1' || hostIp === '[::1]',
    ...over,
  };
}

describe('networking topology adapters', () => {
  it('unwraps unavailable envelopes without generating missing nodes', () => {
    expect(normalizeTopologyResponse({ schemaVersion: 2, runtimeAvailable: false, networks: [missingNetwork] })).toEqual({
      networks: [], runtimeAvailable: false,
    });
  });

  it('filters synthetic missing external nodes', () => {
    expect(filterTopologyNetworks([missingNetwork], {
      stack: '', network: '', ownership: 'all', exposedOnly: false, driftOnly: false, missingExternalOnly: true, sharedOnly: false,
    })).toEqual([missingNetwork]);
  });
});

describe('formatTopologyPort', () => {
  it('formats one fixed port as host:startPort/protocol', () => {
    expect(formatTopologyPort(publishedPort({ hostIp: '192.168.1.5', startPort: 8443, endPort: 8443 })))
      .toBe('192.168.1.5:8443/tcp');
  });

  it('formats a fixed range as host:startPort-endPort/protocol', () => {
    expect(formatTopologyPort(publishedPort({ hostIp: '0.0.0.0', startPort: 8000, endPort: 8010, protocol: 'udp' })))
      .toBe('0.0.0.0:8000-8010/udp');
  });

  it('formats an auto-assigned port as host:auto/protocol', () => {
    expect(formatTopologyPort(publishedPort({ startPort: 0, endPort: 0, dynamic: true, protocol: 'udp' })))
      .toBe('0.0.0.0:auto/udp');
  });

  it('treats a 0/0 publication without the dynamic flag as auto-assigned', () => {
    expect(formatTopologyPort(publishedPort({ startPort: 0, endPort: 0 }))).toBe('0.0.0.0:auto/tcp');
  });

  it('renders the IPv4 all-interface sentinels as 0.0.0.0 and never leaks an undefined value', () => {
    const line = formatTopologyPort(publishedPort());
    expect(line).toBe('0.0.0.0:8080/tcp');
    expect(formatTopologyPort(publishedPort({ hostIp: '0.0.0.0' }))).toBe('0.0.0.0:8080/tcp');
    expect(line).not.toContain('undefined');
  });

  it('keeps the IPv6 all-interface sentinels on IPv6 instead of claiming an IPv4 bind', () => {
    expect(formatTopologyPort(publishedPort({ hostIp: '::' }))).toBe('[::]:8080/tcp');
    expect(formatTopologyPort(publishedPort({ hostIp: '[::]' }))).toBe('[::]:8080/tcp');
    expect(formatTopologyPort(publishedPort({ hostIp: '::', startPort: 18000, endPort: 18010, protocol: 'udp' })))
      .toBe('[::]:18000-18010/udp');
    expect(formatTopologyPort(publishedPort({ hostIp: '::', startPort: 0, endPort: 0 }))).toBe('[::]:auto/tcp');
    expect(formatTopologyPort(publishedPort({ hostIp: '[::]', startPort: 0, endPort: 0, dynamic: true })))
      .toBe('[::]:auto/tcp');
  });

  it('brackets an IPv6 host so the port stays readable', () => {
    expect(formatTopologyPort(publishedPort({ hostIp: '::1' }))).toBe('[::1]:8080/tcp');
    expect(formatTopologyPort(publishedPort({ hostIp: '[::1]' }))).toBe('[::1]:8080/tcp');
    expect(formatTopologyPort(publishedPort({ hostIp: 'fe80::1', startPort: 0, endPort: 0, dynamic: true })))
      .toBe('[fe80::1]:auto/tcp');
  });
});
