/**
 * Unit tests for the fleet dependency-map merge: per-node id namespacing,
 * authoritative node attribution, and graceful partial-failure handling.
 */
import { describe, it, expect } from 'vitest';
import { mergeFleetGraph, isLocalDependencyGraph, type FleetNodeGraphResult, type LocalDependencyGraph } from '../services/DependencyGraphService';

function localGraph(nodeId: number, nodeName: string, stack: string): LocalDependencyGraph {
  return {
    nodeId,
    nodeName,
    nodes: [
      { id: 'host', kind: 'host', label: nodeName, nodeId, nodeName, stack: null, flags: [] },
      { id: `stack:${stack}`, kind: 'stack', label: stack, nodeId, nodeName, stack, flags: [] },
    ],
    edges: [{ id: `e:host-stack:${stack}`, source: 'host', target: `stack:${stack}`, kind: 'stack-node' }],
    flags: [{ kind: 'orphan', nodeId, nodeName, subjects: [`stack:${stack}`], detail: 'x' }],
    parseErrors: [{ stack, error: 'bad' }],
  };
}

const ok = (nodeId: number, nodeName: string, stack: string): FleetNodeGraphResult => ({
  nodeId, nodeName, status: 'ok', graph: localGraph(nodeId, nodeName, stack), error: null,
});
const err = (nodeId: number, nodeName: string, error: string): FleetNodeGraphResult => ({
  nodeId, nodeName, status: 'error', graph: null, error,
});

describe('mergeFleetGraph', () => {
  it('namespaces ids by node so identical stack names stay distinct', () => {
    const merged = mergeFleetGraph([ok(1, 'hub', 'web'), ok(2, 'edge', 'web')]);
    const stackNodes = merged.nodes.filter((n) => n.kind === 'stack');
    expect(stackNodes.map((n) => n.id).sort()).toEqual(['n1:stack:web', 'n2:stack:web']);
    expect(merged.edges.map((e) => e.id).sort()).toEqual(['n1:e:host-stack:web', 'n2:e:host-stack:web']);
  });

  it('re-stamps host label and attribution from the hub registry', () => {
    const graph = localGraph(1, 'wrong-self-name', 'web');
    const merged = mergeFleetGraph([{ nodeId: 7, nodeName: 'authoritative', status: 'ok', graph, error: null }]);
    const host = merged.nodes.find((n) => n.kind === 'host');
    expect(host?.label).toBe('authoritative');
    expect(host?.nodeName).toBe('authoritative');
    expect(host?.id).toBe('n7:host');
  });

  it('namespaces flag subjects and carries parse errors with node attribution', () => {
    const merged = mergeFleetGraph([ok(3, 'edge', 'api')]);
    expect(merged.flags[0].subjects).toEqual(['n3:stack:api']);
    expect(merged.parseErrors).toEqual([{ nodeId: 3, nodeName: 'edge', stack: 'api', error: 'bad' }]);
  });

  it('degrades a failed node to nodeErrors while keeping healthy nodes', () => {
    const merged = mergeFleetGraph([ok(1, 'hub', 'web'), err(2, 'edge', 'unreachable')]);
    expect(merged.nodeErrors).toEqual([{ nodeId: 2, nodeName: 'edge', error: 'unreachable' }]);
    expect(merged.nodes.some((n) => n.id === 'n1:stack:web')).toBe(true);
    expect(merged.nodes.some((n) => n.id.startsWith('n2:'))).toBe(false);
  });

  it('returns an empty graph with full nodeErrors when every node fails', () => {
    const merged = mergeFleetGraph([err(1, 'hub', 'down'), err(2, 'edge', 'down')]);
    expect(merged.nodes).toHaveLength(0);
    expect(merged.edges).toHaveLength(0);
    expect(merged.nodeErrors).toHaveLength(2);
  });
});

describe('isLocalDependencyGraph', () => {
  it('accepts a well-formed graph and one with parseErrors absent', () => {
    expect(isLocalDependencyGraph({ nodes: [{ id: 'host', flags: [] }], edges: [{ id: 'e', source: 'a', target: 'b' }], flags: [{ subjects: ['a'] }], parseErrors: [{ stack: 's', error: 'x' }] })).toBe(true);
    expect(isLocalDependencyGraph({ nodes: [], edges: [], flags: [] })).toBe(true);
  });

  it('rejects null and non-array core fields', () => {
    expect(isLocalDependencyGraph(null)).toBe(false);
    expect(isLocalDependencyGraph({ nodes: {}, edges: [], flags: [] })).toBe(false);
  });

  it('rejects a node missing its flags array', () => {
    expect(isLocalDependencyGraph({ nodes: [{ id: 'x' }], edges: [], flags: [] })).toBe(false);
  });

  it('rejects flags whose subjects are missing or non-string (would corrupt merge)', () => {
    expect(isLocalDependencyGraph({ nodes: [], edges: [], flags: [{}] })).toBe(false);
    expect(isLocalDependencyGraph({ nodes: [], edges: [], flags: [{ subjects: [1] }] })).toBe(false);
  });

  it('rejects malformed parseErrors elements (would throw in merge)', () => {
    expect(isLocalDependencyGraph({ nodes: [], edges: [], flags: [], parseErrors: [null] })).toBe(false);
    expect(isLocalDependencyGraph({ nodes: [], edges: [], flags: [], parseErrors: ['oops'] })).toBe(false);
  });
});
