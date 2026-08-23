/**
 * Networking aggregate memo: read endpoints share one computation per node and
 * requested variant within the TTL window, a mutation invalidation forces the
 * next read to recompute, and a base (no-topology) read never satisfies a
 * topology read. In-flight joining itself is covered by CacheService's own
 * suite; these tests pin the key derivation this module adds on top.
 */
import { describe, it, expect } from 'vitest';
import {
  fetchNodeNetworkingAggregateWithMeta,
  invalidateNodeNetworkingAggregate,
  networkingAggregateCacheKey,
} from '../services/network/networkingAggregateCache';
import type { NetworkingAggregateOptions } from '../services/network/networkingAggregateCache';
import type { NodeNetworkingAggregate } from '../services/network/networkingTypes';

function fakeAggregate(networkCount: number): NodeNetworkingAggregate {
  return {
    overview: {
      runtimeAvailable: true,
      networkCount,
      stackCount: 0,
      connectedContainerCount: 0,
      systemNetworkCount: 0,
      senchoManagedNetworkCount: 0,
      composeManagedNetworkCount: 0,
      unmanagedNetworkCount: 0,
      externalDependencyNetworkCount: 0,
      exposedStackCount: 0,
      unknownExposureStackCount: 0,
      missingExternalCount: 0,
      networkCollisionCount: 0,
      findingCount: 0,
      degradedCache: false,
      renderFailedStacks: [],
    },
    networks: [],
    findings: [],
    stackFacts: [],
    runtimeAvailable: true,
    recentActivity: [],
  };
}

function fakeTopology(): NodeNetworkingAggregate['topology'] {
  return { networks: [{ id: 'n1', name: 'net', driver: 'bridge', scope: '', stack: null, isSystem: false, ingress: false, ownership: 'unmanaged', declaredByStacks: [], declaredExternalByStacks: [], isExternalDependency: false, findingIds: [], containers: [] }], includeSystem: false };
}

const NO_OPTIONS: NetworkingAggregateOptions = {};

async function fetchMemo(nodeId: number, options: NetworkingAggregateOptions, compute: () => Promise<NodeNetworkingAggregate>) {
  const { value } = await fetchNodeNetworkingAggregateWithMeta(nodeId, options, compute);
  return value;
}

describe('networkingAggregateCache', () => {
  it('computes once per TTL window per node and variant', async () => {
    invalidateNodeNetworkingAggregate(1);
    let calls = 0;

    const first = await fetchMemo(1, NO_OPTIONS, async () => fakeAggregate(++calls));
    const second = await fetchMemo(1, NO_OPTIONS, async () => fakeAggregate(++calls));

    expect(first.overview.networkCount).toBe(1);
    expect(second.overview.networkCount).toBe(1);
  });

  it('keeps nodes isolated', async () => {
    invalidateNodeNetworkingAggregate(2);
    invalidateNodeNetworkingAggregate(3);
    const [a, b] = await Promise.all([
      fetchMemo(2, NO_OPTIONS, async () => fakeAggregate(2)),
      fetchMemo(3, NO_OPTIONS, async () => fakeAggregate(3)),
    ]);
    expect(a.overview.networkCount).toBe(2);
    expect(b.overview.networkCount).toBe(3);
  });

  it('does not serve a base read to a topology request', async () => {
    invalidateNodeNetworkingAggregate(5);

    const base = await fetchMemo(5, NO_OPTIONS, async () => fakeAggregate(1));
    expect(base.topology).toBeUndefined();

    let topologyComputes = 0;
    const topology = await fetchMemo(5, { includeTopology: true }, async () => {
      topologyComputes += 1;
      return { ...fakeAggregate(1), topology: fakeTopology() };
    });
    expect(topologyComputes).toBe(1);
    expect(topology.topology?.networks).toHaveLength(1);

    // The base entry stays warm and is served for base reads.
    let baseComputes = 0;
    const warmedBase = await fetchMemo(5, NO_OPTIONS, async () => {
      baseComputes += 1;
      return fakeAggregate(99);
    });
    expect(baseComputes).toBe(0);
    expect(warmedBase.overview.networkCount).toBe(1);
  });

  it('treats includeSystem variants as distinct entries', async () => {
    invalidateNodeNetworkingAggregate(7);
    await fetchMemo(7, { includeTopology: true }, async () => fakeAggregate(1));

    let computes = 0;
    await fetchMemo(7, { includeTopology: true, includeSystem: true }, async () => {
      computes += 1;
      return fakeAggregate(1);
    });
    expect(computes).toBe(1);
  });

  it('builds a distinct key per variant', () => {
    const keys = new Set([
      networkingAggregateCacheKey(9, {}),
      networkingAggregateCacheKey(9, { includeTopology: true }),
      networkingAggregateCacheKey(9, { includeTopology: true, includeSystem: true }),
      networkingAggregateCacheKey(10, {}),
    ]);
    expect(keys.size).toBe(4);
  });

  it('recomputes after an explicit invalidation (mutation path)', async () => {
    invalidateNodeNetworkingAggregate(4);
    let calls = 0;

    await fetchMemo(4, NO_OPTIONS, async () => fakeAggregate(++calls));
    invalidateNodeNetworkingAggregate(4);
    const after = await fetchMemo(4, NO_OPTIONS, async () => fakeAggregate(++calls));

    expect(after.overview.networkCount).toBe(2);
  });

  it('invalidation drops every variant of the node', async () => {
    invalidateNodeNetworkingAggregate(6);
    await fetchMemo(6, NO_OPTIONS, async () => fakeAggregate(1));
    await fetchMemo(6, { includeTopology: true }, async () => fakeAggregate(1));

    invalidateNodeNetworkingAggregate(6);

    let calls = 0;
    await fetchMemo(6, NO_OPTIONS, async () => { calls += 1; return fakeAggregate(1); });
    await fetchMemo(6, { includeTopology: true }, async () => { calls += 1; return fakeAggregate(1); });
    expect(calls).toBe(2);
  });
});
