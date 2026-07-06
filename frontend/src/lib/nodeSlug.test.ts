import { describe, it, expect } from 'vitest';
import { nodeIdToSlug, slugToNodeId, nodeSlugMap } from './nodeSlug';
import type { Node } from '@/context/NodeContext';

function node(over: Partial<Node> & Pick<Node, 'id' | 'name' | 'type'>): Node {
  return {
    url: 'http://127.0.0.1:1852',
    is_default: false,
    compose_dir: '/compose',
    ...over,
  } as Node;
}

describe('nodeSlug', () => {
  const nodes: Node[] = [
    node({ id: 1, name: 'Local', type: 'local', is_default: true }),
    node({ id: 42, name: 'NAS Box', type: 'remote' }),
    node({ id: 7, name: 'local', type: 'remote' }),
  ];

  it('maps default local node to reserved local slug', () => {
    expect(nodeIdToSlug(1, nodes)).toBe('local');
  });

  it('maps remote nodes to name-id slugs', () => {
    expect(nodeIdToSlug(42, nodes)).toBe('nas-box-42');
    expect(nodeIdToSlug(7, nodes)).toBe('local-7');
  });

  it('resolves slugs back to node ids', () => {
    expect(slugToNodeId('local', nodes)).toBe(1);
    expect(slugToNodeId('nas-box-42', nodes)).toBe(42);
    expect(slugToNodeId('local-7', nodes)).toBe(7);
  });

  it('produces a bijective slug map', () => {
    const map = nodeSlugMap(nodes);
    const slugs = [...map.values()];
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(slugs).toContain('local');
  });
});
