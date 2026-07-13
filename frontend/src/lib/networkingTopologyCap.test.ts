import { describe, it, expect } from 'vitest';
import { countTopologyGraphSize, TOPOLOGY_ANIMATION_EDGE_LIMIT, TOPOLOGY_RENDER_CAP } from './networkingTopology';
import type { NetworkingTopologyContainer, NetworkingTopologyNetwork } from '@/types/networking';

function container(id: string): NetworkingTopologyContainer {
  return {
    id, name: id, ip: '10.0.0.1', state: 'running', image: 'nginx', stack: 'app', service: 'web',
    composeAliases: [], publishedPorts: [], exposureIntent: null, findingIds: [], driftFlags: [], hostMode: false,
  };
}

function network(id: string, containers: NetworkingTopologyContainer[]): NetworkingTopologyNetwork {
  return {
    id, name: id, driver: 'bridge', scope: 'local', stack: null, isSystem: false, ingress: false,
    ownership: 'sencho-managed', declaredByStacks: [], declaredExternalByStacks: [],
    isExternalDependency: false, findingIds: [], containers,
  };
}

describe('countTopologyGraphSize', () => {
  it('counts a container attached to two networks as ONE node and TWO edges', () => {
    const shared = container('shared');
    const size = countTopologyGraphSize([network('net-a', [shared]), network('net-b', [shared])]);
    // 2 networks + 1 deduped container = 3 nodes; 2 edges (one per attachment).
    expect(size.nodeCount).toBe(3);
    expect(size.edgeCount).toBe(2);
  });

  it('lands just under the render cap at the boundary and just over one container later', () => {
    // One network with N containers is (1 + N) nodes and N edges: total 1 + 2N.
    const belowN = Math.floor((TOPOLOGY_RENDER_CAP - 1) / 2); // largest N with 1 + 2N <= cap
    const below = countTopologyGraphSize([network('g', Array.from({ length: belowN }, (_, i) => container(`c${i}`)))]);
    expect(below.nodeCount + below.edgeCount).toBeLessThanOrEqual(TOPOLOGY_RENDER_CAP);

    const above = countTopologyGraphSize([network('g', Array.from({ length: belowN + 1 }, (_, i) => container(`c${i}`)))]);
    expect(above.nodeCount + above.edgeCount).toBeGreaterThan(TOPOLOGY_RENDER_CAP);
  });

  it('crosses the animation edge limit exactly one edge past the threshold', () => {
    const atLimit = countTopologyGraphSize([network('g', Array.from({ length: TOPOLOGY_ANIMATION_EDGE_LIMIT }, (_, i) => container(`c${i}`)))]);
    expect(atLimit.edgeCount).toBe(TOPOLOGY_ANIMATION_EDGE_LIMIT);
    const over = countTopologyGraphSize([network('g', Array.from({ length: TOPOLOGY_ANIMATION_EDGE_LIMIT + 1 }, (_, i) => container(`c${i}`)))]);
    expect(over.edgeCount).toBeGreaterThan(TOPOLOGY_ANIMATION_EDGE_LIMIT);
  });
});
