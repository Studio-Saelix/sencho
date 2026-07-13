import { describe, expect, it } from 'vitest';
import {
  adaptNetworkingOverview, buildExternalNetworkSnippet, filterNetworkRows, getNetworkingPosture,
} from './networking';
import type { NetworkingFinding, NetworkingFindingKind, NetworkingNetworkRow, NodeNetworkingOverview } from '@/types/networking';

const rows: NetworkingNetworkRow[] = [
  {
    id: 'managed', name: 'app-net', driver: 'bridge', scope: 'local', isSystem: false, ingress: false,
    composeProject: 'app', stack: 'app', connectedCount: 2, isSencho: false, ownership: 'sencho-managed',
    declaredByStacks: ['app'], declaredExternalByStacks: ['peer'], isExternalDependency: true,
    sharedStackCount: 2, exposureSummary: null, findingIds: ['drift'], serviceNames: ['web'],
  },
  {
    id: 'system', name: 'bridge', driver: 'bridge', scope: 'local', isSystem: true, ingress: false,
    composeProject: null, stack: null, connectedCount: 0, isSencho: false, ownership: 'system',
    declaredByStacks: [], declaredExternalByStacks: [], isExternalDependency: false,
    sharedStackCount: 0, exposureSummary: null, findingIds: [], serviceNames: [],
  },
];

const findingKindById = new Map<string, NetworkingFindingKind>([['drift', 'network-missing']]);

describe('networking view helpers', () => {
  it('filters ownership, dependencies, and findings independently', () => {
    expect(filterNetworkRows(rows, 'managed', '')).toHaveLength(1);
    expect(filterNetworkRows(rows, 'external', '')).toHaveLength(1);
    expect(filterNetworkRows(rows, 'system', '')).toHaveLength(1);
    expect(filterNetworkRows(rows, 'shared', '')).toHaveLength(1);
    expect(filterNetworkRows(rows, 'drift', '', findingKindById)).toHaveLength(1);
  });

  it('drift filter requires a drift-kind finding, not just any finding', () => {
    const nonDriftKindById = new Map<string, NetworkingFindingKind>([['drift', 'shared-network']]);
    expect(filterNetworkRows(rows, 'drift', '', nonDriftKindById)).toHaveLength(0);
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

  it('adapts a schema-2 response: derives ownership counts and fills new-field defaults', () => {
    // A schema-2 remote sends partial rows/findings (no serviceNames, no
    // sources/doctorFindings); the envelope type models the schema-3 ideal, so
    // the partial wire shape is cast to mirror what actually arrives.
    const adapted = adaptNetworkingOverview({
      schemaVersion: 2,
      runtimeAvailable: true,
      overview: { networkCount: 2 } as NodeNetworkingOverview,
      networks: [
        { id: 'a', name: 'a', ownership: 'sencho-managed', isExternalDependency: false },
        { id: 'b', name: 'b', ownership: 'unmanaged', isExternalDependency: true },
      ] as unknown as NetworkingNetworkRow[],
      findings: [{ id: 'f1', kind: 'network-missing', severity: 'high', title: 't', message: 'm' }] as unknown as NetworkingFinding[],
    });
    expect(adapted.isLegacy).toBe(false);
    expect(adapted.runtimeAvailable).toBe(true);
    // The schema-2 envelope omits ownership counts, so they are derived from the rows.
    expect(adapted.overview?.senchoManagedNetworkCount).toBe(1);
    expect(adapted.overview?.unmanagedNetworkCount).toBe(1);
    expect(adapted.overview?.externalDependencyNetworkCount).toBe(1);
    // Fields new in schema 3 get safe defaults rather than undefined.
    expect(adapted.networks[0].serviceNames).toEqual([]);
    expect(adapted.findings[0].sources).toEqual(['live']);
    expect(adapted.findings[0].doctorFindings).toEqual([]);
  });

  it('builds an external network snippet only for safe names', () => {
    expect(buildExternalNetworkSnippet('shared-net')).toBe(
      'networks:\n  shared-net:\n    external: true',
    );
    expect(buildExternalNetworkSnippet('../unsafe')).toBeNull();
  });
});
