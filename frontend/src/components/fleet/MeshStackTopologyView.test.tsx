import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MeshStackTopologyView } from './MeshStackTopologyView';
import type { MeshAlias, MeshNodeStatus } from '@/types/mesh';

vi.mock('@xyflow/react', () => ({
    ReactFlow: () => <div data-testid="reactflow" />,
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
    makeNode({ nodeId: 2, nodeName: 'peer-a', reachableMode: 'proxy', enabled: true, reverseCallbackStatus: 'connected' }),
];

describe('MeshStackTopologyView', () => {
    it('renders the empty-state message when the stack publishes no aliases', () => {
        render(<MeshStackTopologyView nodeId={1} stackName="api" status={baseStatus} aliases={[]} />);

        expect(screen.getByText(/No published mesh services/i)).toBeInTheDocument();
        expect(screen.queryByTestId('reactflow')).not.toBeInTheDocument();
    });

    it('renders the topology graph when the stack publishes aliases', () => {
        const aliases = [
            makeAlias({ host: 'a.mesh', nodeId: 1, stackName: 'api' }),
            makeAlias({ host: 'b.mesh', nodeId: 1, stackName: 'api' }),
        ];
        render(<MeshStackTopologyView nodeId={1} stackName="api" status={baseStatus} aliases={aliases} />);

        expect(screen.getByTestId('reactflow')).toBeInTheDocument();
        expect(screen.queryByText(/No published mesh services/i)).not.toBeInTheDocument();
    });
});
