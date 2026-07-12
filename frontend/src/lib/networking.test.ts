import { describe, expect, it } from 'vitest';
import {
  adaptNetworkingOverview, buildExternalNetworkSnippet, filterNetworkRows, getNetworkingPosture,
} from './networking';
import type { NetworkingNetworkRow } from '@/types/networking';

const rows: NetworkingNetworkRow[] = [
  {
    id: 'managed', name: 'app-net', driver: 'bridge', scope: 'local', isSystem: false, ingress: false,
    composeProject: 'app', stack: 'app', connectedCount: 2, isSencho: false, ownership: 'sencho-managed',
    declaredByStacks: ['app'], declaredExternalByStacks: ['peer'], isExternalDependency: true,
    sharedStackCount: 2, exposureSummary: null, findingIds: ['drift'],
  },
  {
    id: 'system', name: 'bridge', driver: 'bridge', scope: 'local', isSystem: true, ingress: false,
    composeProject: null, stack: null, connectedCount: 0, isSencho: false, ownership: 'system',
    declaredByStacks: [], declaredExternalByStacks: [], isExternalDependency: false,
    sharedStackCount: 0, exposureSummary: null, findingIds: [],
  },
];

describe('networking view helpers', () => {
  it('filters ownership, dependencies, and findings independently', () => {
    expect(filterNetworkRows(rows, 'managed', '')).toHaveLength(1);
    expect(filterNetworkRows(rows, 'external', '')).toHaveLength(1);
    expect(filterNetworkRows(rows, 'system', '')).toHaveLength(1);
    expect(filterNetworkRows(rows, 'shared', '')).toHaveLength(1);
    expect(filterNetworkRows(rows, 'drift', '')).toHaveLength(1);
  });

  it('does not infer contained posture from a schema-less response', () => {
    expect(getNetworkingPosture([], true, true).label).toBe('Partial networking data');
  });

  it('adapts schema-less responses without synthesizing findings', () => {
    const adapted = adaptNetworkingOverview({ networks: rows });
    expect(adapted.isLegacy).toBe(true);
    expect(adapted.findings).toEqual([]);
    expect(adapted.runtimeAvailable).toBe(false);
  });

  it('builds an external network snippet only for safe names', () => {
    expect(buildExternalNetworkSnippet('shared-net')).toBe(
      'networks:\n  shared-net:\n    external: true',
    );
    expect(buildExternalNetworkSnippet('../unsafe')).toBeNull();
  });
});
