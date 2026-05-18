import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MeshStackTopologySheet } from './MeshStackTopologySheet';
import type { MeshAlias, MeshNodeStatus } from '@/types/mesh';

vi.mock('@xyflow/react', () => ({
    ReactFlow: () => null,
    Background: () => null,
    Handle: () => null,
    Position: { Left: 'left', Right: 'right' },
    useNodesState: <T,>() => [[] as T[], () => {}, () => {}],
    useEdgesState: <T,>() => [[] as T[], () => {}, () => {}],
}));

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

const baseStatus: MeshNodeStatus[] = [
    makeNode({ nodeId: 1, nodeName: 'local', reachableMode: 'local', enabled: true }),
    makeNode({ nodeId: 2, nodeName: 'peer-a', reachableMode: 'pilot', enabled: true, pilotConnected: true }),
];

describe('MeshStackTopologySheet', () => {
    it('renders the empty-state message when the stack publishes no aliases', () => {
        render(
            <MeshStackTopologySheet
                open
                onOpenChange={() => {}}
                nodeId={1}
                nodeName="local"
                stackName="api"
                status={baseStatus}
                aliases={[]}
            />,
        );

        expect(screen.getByText(/No published mesh services/i)).toBeInTheDocument();
        expect(screen.getByText(/0 aliases/i)).toBeInTheDocument();
    });

    it('shows the alias and consumer counts in the meta band', () => {
        const aliases = [
            makeAlias({ host: 'a.mesh', nodeId: 1, stackName: 'api' }),
            makeAlias({ host: 'b.mesh', nodeId: 1, stackName: 'api' }),
        ];
        render(
            <MeshStackTopologySheet
                open
                onOpenChange={() => {}}
                nodeId={1}
                nodeName="local"
                stackName="api"
                status={baseStatus}
                aliases={aliases}
            />,
        );

        expect(screen.getByText(/2 aliases · 1 consumer/i)).toBeInTheDocument();
        expect(screen.queryByText(/No published mesh services/i)).not.toBeInTheDocument();
    });

    it('counts only meshed remote nodes as consumers', () => {
        const aliases = [makeAlias({ host: 'a.mesh', nodeId: 1, stackName: 'api' })];
        const status: MeshNodeStatus[] = [
            makeNode({ nodeId: 1, nodeName: 'local', reachableMode: 'local', enabled: true }),
            makeNode({ nodeId: 2, nodeName: 'meshed', reachableMode: 'pilot', enabled: true, pilotConnected: true }),
            makeNode({ nodeId: 3, nodeName: 'unmeshed', reachableMode: 'pilot', enabled: false }),
        ];
        render(
            <MeshStackTopologySheet
                open
                onOpenChange={() => {}}
                nodeId={1}
                nodeName="local"
                stackName="api"
                status={status}
                aliases={aliases}
            />,
        );

        expect(screen.getByText(/1 alias · 1 consumer/i)).toBeInTheDocument();
    });
});
