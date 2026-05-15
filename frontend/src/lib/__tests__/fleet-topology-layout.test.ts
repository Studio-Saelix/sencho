import { describe, it, expect } from 'vitest';
import {
    layoutFleetGraph,
    LOCAL_CLUSTER_ID,
    UNLABELED_CLUSTER_ID,
    type FleetTopologyNode,
} from '../fleet-topology-layout';

function makeNode(
    id: number,
    type: 'local' | 'remote',
    overrides: Partial<FleetTopologyNode> = {},
): FleetTopologyNode {
    return {
        id,
        name: `node-${id}`,
        type,
        status: 'online',
        cpuPercent: 10,
        memPercent: 20,
        diskPercent: 30,
        stackCount: 1,
        runningCount: 2,
        critical: false,
        labels: [],
        cordoned: false,
        cordonedReason: null,
        latencyMs: null,
        pilotLastSeen: null,
        nodeMode: null,
        ...overrides,
    };
}

describe('layoutFleetGraph', () => {
    it('returns empty arrays when there are no nodes', () => {
        const result = layoutFleetGraph([], { mode: 'hub' });
        expect(result.nodes).toEqual([]);
        expect(result.edges).toEqual([]);
    });

    it('hub mode emits one edge from local to each remote', () => {
        const nodes = [
            makeNode(1, 'local'),
            makeNode(2, 'remote'),
            makeNode(3, 'remote'),
            makeNode(4, 'remote'),
        ];
        const result = layoutFleetGraph(nodes, { mode: 'hub' });
        expect(result.edges).toHaveLength(3);
        for (const edge of result.edges) {
            expect(edge.source).toBe('1');
            expect(['2', '3', '4']).toContain(edge.target);
        }
        expect(result.nodes.map(n => n.id).sort()).toEqual(['1', '2', '3', '4']);
        for (const n of result.nodes) {
            expect((n.data as { clusterLabel?: string }).clusterLabel).toBeUndefined();
        }
    });

    it('grouped mode assigns local to __local__ and remotes to their primary label cluster', () => {
        const nodes = [
            makeNode(1, 'local', { labels: ['prod'] }),
            makeNode(2, 'remote', { labels: ['prod', 'aws'] }),
            makeNode(3, 'remote', { labels: ['staging'] }),
            makeNode(4, 'remote', { labels: [] }),
        ];
        const result = layoutFleetGraph(nodes, { mode: 'grouped' });
        const clusterByNodeId = new Map<string, string | undefined>(
            result.nodes.map(n => [n.id, (n.data as { clusterLabel?: string }).clusterLabel]),
        );
        expect(clusterByNodeId.get('1')).toBe(LOCAL_CLUSTER_ID);
        // Primary label is alphabetically first: 'aws' wins over 'prod'.
        expect(clusterByNodeId.get('2')).toBe('aws');
        expect(clusterByNodeId.get('3')).toBe('staging');
        expect(clusterByNodeId.get('4')).toBe(UNLABELED_CLUSTER_ID);
        // Real edges only — pseudo intra-cluster edges must not surface.
        for (const edge of result.edges) {
            expect(edge.source).toBe('1');
        }
    });

    it('grouped mode with no labels collapses remotes into the unlabeled cluster', () => {
        const nodes = [
            makeNode(1, 'local'),
            makeNode(2, 'remote'),
            makeNode(3, 'remote'),
        ];
        const result = layoutFleetGraph(nodes, { mode: 'grouped' });
        const cluster = (id: string) =>
            (result.nodes.find(n => n.id === id)?.data as { clusterLabel?: string }).clusterLabel;
        expect(cluster('1')).toBe(LOCAL_CLUSTER_ID);
        expect(cluster('2')).toBe(UNLABELED_CLUSTER_ID);
        expect(cluster('3')).toBe(UNLABELED_CLUSTER_ID);
    });

    it('free mode overrides positions for ids present in savedPositions', () => {
        const nodes = [
            makeNode(1, 'local'),
            makeNode(2, 'remote'),
            makeNode(3, 'remote'),
        ];
        const saved = {
            '2': { x: 500, y: 99 },
        };
        const result = layoutFleetGraph(nodes, { mode: 'free', savedPositions: saved });
        const byId = new Map(result.nodes.map(n => [n.id, n.position]));
        expect(byId.get('2')).toEqual({ x: 500, y: 99 });
        // Node 3 has no saved position; falls back to Dagre-derived (some
        // numeric coordinate, not the saved override).
        const pos3 = byId.get('3')!;
        expect(typeof pos3.x).toBe('number');
        expect(pos3).not.toEqual({ x: 500, y: 99 });
    });

    it('free mode without any savedPositions matches hub layout positions', () => {
        const nodes = [makeNode(1, 'local'), makeNode(2, 'remote')];
        const hub = layoutFleetGraph(nodes, { mode: 'hub' });
        const free = layoutFleetGraph(nodes, { mode: 'free' });
        const hubPositions = new Map(hub.nodes.map(n => [n.id, n.position]));
        const freePositions = new Map(free.nodes.map(n => [n.id, n.position]));
        for (const id of ['1', '2']) {
            expect(freePositions.get(id)).toEqual(hubPositions.get(id));
        }
    });

    it('offline remote produces a dashed edge style', () => {
        const nodes = [
            makeNode(1, 'local'),
            makeNode(2, 'remote', { status: 'offline' }),
        ];
        const result = layoutFleetGraph(nodes, { mode: 'hub' });
        const edge = result.edges[0];
        const style = edge.style as { strokeDasharray?: string };
        expect(style.strokeDasharray).toBe('4 4');
    });
});
