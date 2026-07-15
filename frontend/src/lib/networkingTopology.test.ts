import { describe, expect, it } from 'vitest';
import { filterTopologyNetworks, normalizeTopologyResponse } from './networkingTopology';
import type { NetworkingTopologyNetwork } from '@/types/networking';

const missingNetwork: NetworkingTopologyNetwork = {
  id: 'missing:shared-net', name: 'shared-net', driver: 'unknown', scope: 'local', stack: null,
  isSystem: false, ingress: false, ownership: 'unmanaged', declaredByStacks: [],
  declaredExternalByStacks: ['app'], isExternalDependency: true, runtimeState: 'missing',
  findingIds: ['network-missing'], containers: [],
};

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
