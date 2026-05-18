import { describe, expect, it } from 'vitest';
import {
    buildTunnelsGraph,
    buildAliasesGraph,
    buildStackTopologyGraph,
    meshNodeStateEqual,
    miniMapColorFor,
    stacksKey,
    MINIMAP_BRAND,
    MINIMAP_WARNING,
    MINIMAP_MUTED,
    MINIMAP_DESTRUCTIVE,
} from './mesh-topology-layout';
import type { MeshAlias, MeshNodeStatus } from '@/types/mesh';

function makeNode(over: Partial<MeshNodeStatus> & Pick<MeshNodeStatus, 'nodeId' | 'nodeName'>): MeshNodeStatus {
    return {
        nodeId: over.nodeId,
        nodeName: over.nodeName,
        enabled: over.enabled ?? false,
        localForwarderListening: over.localForwarderListening ?? null,
        pilotConnected: over.pilotConnected ?? false,
        reachableMode: over.reachableMode ?? 'unreachable',
        reachableReason: over.reachableReason ?? null,
        reverseCallbackStatus: over.reverseCallbackStatus ?? 'not_applicable',
        optedInStacks: over.optedInStacks ?? [],
        activeStreamCount: over.activeStreamCount ?? 0,
    };
}

function makeAlias(over: Partial<MeshAlias> & Pick<MeshAlias, 'host' | 'nodeId'>): MeshAlias {
    return {
        host: over.host,
        nodeId: over.nodeId,
        nodeName: over.nodeName ?? `node-${over.nodeId}`,
        stackName: over.stackName ?? 'stack-a',
        serviceName: over.serviceName ?? 'svc',
        port: over.port ?? 80,
    };
}

describe('stacksKey', () => {
    it('returns the same key for the same membership regardless of order', () => {
        expect(stacksKey(['a', 'b', 'c'])).toBe(stacksKey(['c', 'a', 'b']));
    });

    it('differs when membership differs even with the same count', () => {
        expect(stacksKey(['a', 'b'])).not.toBe(stacksKey(['a', 'c']));
    });

    it('returns empty string for empty list', () => {
        expect(stacksKey([])).toBe('');
    });
});

describe('meshNodeStateEqual', () => {
    const base = makeNode({ nodeId: 1, nodeName: 'n', reachableMode: 'pilot', enabled: true, pilotConnected: true, optedInStacks: ['a', 'b'] });

    it('returns true when scalar fields and stack membership match', () => {
        const a = { ...base };
        const b = { ...base, optedInStacks: ['b', 'a'] };
        expect(meshNodeStateEqual(a, b)).toBe(true);
    });

    it('detects a stack swap that preserves the count', () => {
        const a = { ...base };
        const b = { ...base, optedInStacks: ['a', 'c'] };
        expect(meshNodeStateEqual(a, b)).toBe(false);
    });

    it('detects a reachable-mode flip', () => {
        const a = { ...base };
        const b = { ...base, reachableMode: 'unreachable' as const };
        expect(meshNodeStateEqual(a, b)).toBe(false);
    });

    it('detects a pilot disconnect', () => {
        const a = { ...base };
        const b = { ...base, pilotConnected: false };
        expect(meshNodeStateEqual(a, b)).toBe(false);
    });
});

describe('miniMapColorFor', () => {
    it('returns destructive for unreachable', () => {
        const node = makeNode({ nodeId: 1, nodeName: 'n', reachableMode: 'unreachable' });
        expect(miniMapColorFor(node)).toBe(MINIMAP_DESTRUCTIVE);
    });

    it('returns warning for pilot that is not connected', () => {
        const node = makeNode({ nodeId: 1, nodeName: 'n', reachableMode: 'pilot', enabled: true, pilotConnected: false });
        expect(miniMapColorFor(node)).toBe(MINIMAP_WARNING);
    });

    it('returns muted for an enabled-false pilot that is connected', () => {
        const node = makeNode({ nodeId: 1, nodeName: 'n', reachableMode: 'pilot', enabled: false, pilotConnected: true });
        expect(miniMapColorFor(node)).toBe(MINIMAP_MUTED);
    });

    it('returns brand for a healthy meshed remote', () => {
        const node = makeNode({ nodeId: 1, nodeName: 'n', reachableMode: 'pilot', enabled: true, pilotConnected: true });
        expect(miniMapColorFor(node)).toBe(MINIMAP_BRAND);
    });

    it('returns muted when node is undefined', () => {
        expect(miniMapColorFor(undefined)).toBe(MINIMAP_MUTED);
    });
});

describe('buildTunnelsGraph', () => {
    it('returns empty result when no nodes', () => {
        const result = buildTunnelsGraph([]);
        expect(result.nodes).toHaveLength(0);
        expect(result.edges).toHaveLength(0);
    });

    it('returns nodes but no edges when only the local node is present', () => {
        const result = buildTunnelsGraph([
            makeNode({ nodeId: 1, nodeName: 'local', reachableMode: 'local', enabled: true }),
        ]);
        expect(result.nodes).toHaveLength(1);
        expect(result.edges).toHaveLength(0);
    });

    it('returns one edge from local to every other node', () => {
        const result = buildTunnelsGraph([
            makeNode({ nodeId: 1, nodeName: 'local', reachableMode: 'local', enabled: true }),
            makeNode({ nodeId: 2, nodeName: 'peer-a', reachableMode: 'pilot', enabled: true, pilotConnected: true }),
            makeNode({ nodeId: 3, nodeName: 'peer-b', reachableMode: 'proxy', enabled: true }),
        ]);
        expect(result.nodes).toHaveLength(3);
        expect(result.edges).toHaveLength(2);
        expect(result.edges.every((e) => e.source === '1')).toBe(true);
    });

    it('labels pilot edges with state suffixes', () => {
        const result = buildTunnelsGraph([
            makeNode({ nodeId: 1, nodeName: 'local', reachableMode: 'local', enabled: true }),
            makeNode({ nodeId: 2, nodeName: 'on', reachableMode: 'pilot', enabled: true, pilotConnected: true }),
            makeNode({ nodeId: 3, nodeName: 'off', reachableMode: 'pilot', enabled: true, pilotConnected: false }),
        ]);
        const onEdge = result.edges.find((e) => e.target === '2');
        const offEdge = result.edges.find((e) => e.target === '3');
        expect(onEdge?.label).toBe('pilot · ok');
        expect(offEdge?.label).toBe('pilot · idle');
    });

    it('dashes unreachable edges', () => {
        const result = buildTunnelsGraph([
            makeNode({ nodeId: 1, nodeName: 'local', reachableMode: 'local', enabled: true }),
            makeNode({ nodeId: 2, nodeName: 'down', reachableMode: 'unreachable', enabled: false, reachableReason: 'auth failed' }),
        ]);
        const edge = result.edges[0];
        expect(edge).toBeDefined();
        expect((edge?.style as { strokeDasharray?: string } | undefined)?.strokeDasharray).toBe('4 4');
        expect(edge?.label).toBe('unreachable');
    });
});

describe('buildAliasesGraph', () => {
    const status: MeshNodeStatus[] = [
        makeNode({ nodeId: 1, nodeName: 'local', reachableMode: 'local', enabled: true }),
        makeNode({ nodeId: 2, nodeName: 'peer-a', reachableMode: 'pilot', enabled: true, pilotConnected: true }),
        makeNode({ nodeId: 3, nodeName: 'peer-b', reachableMode: 'proxy', enabled: true }),
    ];

    it('produces one edge per remote node like the tunnels graph', () => {
        const aliases = [
            makeAlias({ host: 'a.mesh', nodeId: 2 }),
            makeAlias({ host: 'b.mesh', nodeId: 2 }),
            makeAlias({ host: 'c.mesh', nodeId: 3 }),
        ];
        const result = buildAliasesGraph(status, aliases);
        expect(result.edges).toHaveLength(2);
        const labels = result.edges.map((e) => e.label);
        expect(labels).toContain('2 aliases');
        expect(labels).toContain('1 alias');
    });

    it('labels edges with "no aliases" when remote owns none', () => {
        const result = buildAliasesGraph(status, [makeAlias({ host: 'a.mesh', nodeId: 2 })]);
        const noAliasEdge = result.edges.find((e) => e.target === '3');
        expect(noAliasEdge?.label).toBe('no aliases');
    });

    it('encodes aliasCount on node data when in aliases mode', () => {
        const aliases = [
            makeAlias({ host: 'a.mesh', nodeId: 2 }),
            makeAlias({ host: 'b.mesh', nodeId: 2 }),
        ];
        const result = buildAliasesGraph(status, aliases);
        const peerA = result.nodes.find((n) => n.id === '2');
        const data = peerA?.data as { aliasCount: number } | undefined;
        expect(data?.aliasCount).toBe(2);
    });
});

describe('buildStackTopologyGraph', () => {
    const status: MeshNodeStatus[] = [
        makeNode({ nodeId: 1, nodeName: 'local', reachableMode: 'local', enabled: true }),
        makeNode({ nodeId: 2, nodeName: 'peer-a', reachableMode: 'pilot', enabled: true, pilotConnected: true }),
        makeNode({ nodeId: 3, nodeName: 'peer-b', reachableMode: 'proxy', enabled: true }),
    ];

    it('returns empty when stack publishes nothing and no consumers', () => {
        const result = buildStackTopologyGraph({
            nodeId: 1,
            stackName: 'empty',
            status: [makeNode({ nodeId: 1, nodeName: 'local', reachableMode: 'local', enabled: true })],
            aliases: [],
        });
        expect(result.nodes).toHaveLength(0);
        expect(result.edges).toHaveLength(0);
    });

    it('builds a center + alias + consumer fanout for a stack with 2 aliases and 2 consumers', () => {
        const aliases = [
            makeAlias({ host: 'a.mesh', nodeId: 1, stackName: 'api' }),
            makeAlias({ host: 'b.mesh', nodeId: 1, stackName: 'api' }),
            makeAlias({ host: 'other.mesh', nodeId: 1, stackName: 'other' }),
        ];
        const result = buildStackTopologyGraph({
            nodeId: 1,
            stackName: 'api',
            status,
            aliases,
        });
        const centerNodes = result.nodes.filter((n) => n.type === 'stackCenter');
        const aliasNodes = result.nodes.filter((n) => n.type === 'stackAlias');
        const consumerNodes = result.nodes.filter((n) => n.type === 'stackConsumer');
        expect(centerNodes).toHaveLength(1);
        expect(aliasNodes).toHaveLength(2);
        expect(consumerNodes).toHaveLength(2);
        // 2 center→alias edges + 2 aliases × 2 consumers = 4 alias→consumer edges = 6 total.
        expect(result.edges).toHaveLength(6);
    });

    it('filters aliases by both nodeId and stackName', () => {
        const aliases = [
            makeAlias({ host: 'a.mesh', nodeId: 1, stackName: 'api' }),
            makeAlias({ host: 'wrong-stack.mesh', nodeId: 1, stackName: 'other' }),
            makeAlias({ host: 'wrong-node.mesh', nodeId: 2, stackName: 'api' }),
        ];
        const result = buildStackTopologyGraph({
            nodeId: 1,
            stackName: 'api',
            status,
            aliases,
        });
        const aliasNodes = result.nodes.filter((n) => n.type === 'stackAlias');
        expect(aliasNodes).toHaveLength(1);
        expect(aliasNodes[0]?.id).toBe('alias-1-api-a.mesh');
    });

    it('only treats meshed (enabled) remote nodes as consumers', () => {
        const aliases = [makeAlias({ host: 'a.mesh', nodeId: 1, stackName: 'api' })];
        const mixedStatus = [
            makeNode({ nodeId: 1, nodeName: 'local', reachableMode: 'local', enabled: true }),
            makeNode({ nodeId: 2, nodeName: 'meshed', reachableMode: 'pilot', enabled: true, pilotConnected: true }),
            makeNode({ nodeId: 3, nodeName: 'unmeshed', reachableMode: 'pilot', enabled: false }),
        ];
        const result = buildStackTopologyGraph({
            nodeId: 1,
            stackName: 'api',
            status: mixedStatus,
            aliases,
        });
        const consumerNodes = result.nodes.filter((n) => n.type === 'stackConsumer');
        expect(consumerNodes).toHaveLength(1);
        expect(consumerNodes[0]?.id).toBe('consumer-1-api-2');
    });
});
