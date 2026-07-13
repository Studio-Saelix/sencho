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

  it('has sane threshold constants (animation limit below the hard render cap)', () => {
    expect(TOPOLOGY_ANIMATION_EDGE_LIMIT).toBeLessThan(TOPOLOGY_RENDER_CAP);
  });

  it('a graph with many distinct containers exceeds the render cap', () => {
    const networks = [network('big', Array.from({ length: 400 }, (_, i) => container(`c${i}`)))];
    const size = countTopologyGraphSize(networks);
    expect(size.nodeCount + size.edgeCount).toBeGreaterThan(TOPOLOGY_RENDER_CAP);
  });
});
