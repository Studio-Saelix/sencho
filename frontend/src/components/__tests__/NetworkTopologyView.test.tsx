import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { NetworkingTopologyNetwork } from '@/types/networking';

// The graph canvas is not under test here; keep the React Flow surface stubbed
// while letting the component own real node/edge state. The stub renders the
// node labels and edge ids it receives so reload assertions can prove the graph
// props were retained and then replaced, not just that the wrapper stayed. It
// mirrors the last nodes prop it received to the mocked viewport helpers, and
// the initialized flag can be toggled the way React Flow re-measures a new
// node set, so the fit effect's guards are exercised.
const flowState = vi.hoisted(() => ({
    fitView: vi.fn(),
    nodes: [] as { id: string; position?: { x: number; y: number } }[],
    nodesInitialized: true,
    onNodesChange: undefined as ((changes: unknown[]) => void) | undefined,
}));

vi.mock('@xyflow/react', async () => {
    const React = await import('react');
    type FlowNode = { id: string; data?: { label?: string }; position?: { x: number; y: number } };
    type FlowEdge = { id: string };
    type PositionChange = { type: string; id: string; position?: { x: number; y: number } };
    return {
        ReactFlow: ({ nodes = [], edges = [], children, onNodesChange }: {
            nodes?: FlowNode[];
            edges?: FlowEdge[];
            children?: ReactNode;
            onNodesChange?: (changes: PositionChange[]) => void;
        }) => {
            flowState.nodes = nodes;
            flowState.onNodesChange = onNodesChange as ((changes: unknown[]) => void) | undefined;
            return (
                <div data-testid="topology-graph">
                    {nodes.map((node) => (
                        <span key={node.id} data-testid={`topology-node-${node.id}`}>{node.data?.label}</span>
                    ))}
                    {edges.map((edge) => (
                        <span key={edge.id} data-testid={`topology-edge-${edge.id}`} />
                    ))}
                    {children}
                </div>
            );
        },
        Background: () => null,
        Controls: () => null,
        MiniMap: () => null,
        Handle: () => null,
        Position: { Top: 'top', Bottom: 'bottom' },
        useNodesState: <T extends { id: string; position?: { x: number; y: number } }>(initial: T[]) => {
            const [state, setState] = React.useState<T[]>(initial);
            const onNodesChange = React.useCallback((changes: PositionChange[]) => {
                setState((current) => current.map((node) => {
                    const change = changes.find((entry) => entry.id === node.id && entry.type === 'position');
                    return change?.position ? { ...node, position: change.position } : node;
                }));
            }, []);
            return [state, setState, onNodesChange] as const;
        },
        useEdgesState: <T,>(initial: T[]) => React.useState<T[]>(initial),
        useNodesInitialized: () => flowState.nodesInitialized,
        useStore: (selector: (state: { nodes: { id: string }[] }) => unknown) => selector({ nodes: flowState.nodes }),
        useReactFlow: () => ({ fitView: flowState.fitView }),
    };
});

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
import { apiFetch } from '@/lib/api';

vi.mock('@/components/ui/toast-store', () => ({
    toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import NetworkTopologyView from '../NetworkTopologyView';

const mockedFetch = vi.mocked(apiFetch);

const network: NetworkingTopologyNetwork = {
    id: 'net-1',
    name: 'app-net',
    driver: 'bridge',
    scope: 'local',
    stack: 'app',
    isSystem: false,
    ingress: false,
    ownership: 'sencho-managed',
    declaredByStacks: ['app'],
    declaredExternalByStacks: [],
    isExternalDependency: false,
    runtimeState: 'present',
    findingIds: [],
    containers: [{
        id: 'container-1',
        name: 'app-web-1',
        ip: '172.18.0.2',
        state: 'running',
        image: 'nginx:alpine',
        stack: 'app',
        service: 'web',
        composeAliases: ['web'],
        publishedPorts: [],
        exposureIntent: null,
        findingIds: [],
        driftFlags: [],
        hostMode: false,
    }],
};

const refreshedNetwork: NetworkingTopologyNetwork = {
    ...network,
    id: 'net-2',
    name: 'data-net',
    stack: 'data',
    declaredByStacks: ['data'],
    containers: [{
        ...network.containers[0],
        id: 'container-2',
        name: 'data-web-1',
        stack: 'data',
    }],
};

function topologyResponse(networks: NetworkingTopologyNetwork[] = [network]): Response {
    return new Response(
        JSON.stringify({ schemaVersion: 2, runtimeAvailable: true, networks }),
        { status: 200, headers: { 'content-type': 'application/json' } },
    );
}

function deferred() {
    let resolve!: (value: Response) => void;
    const promise = new Promise<Response>((done) => { resolve = done; });
    return { promise, resolve };
}

describe('NetworkTopologyView refresh', () => {
    beforeEach(() => {
        mockedFetch.mockReset();
        flowState.fitView.mockReset();
        flowState.nodes = [];
        flowState.nodesInitialized = true;
        flowState.onNodesChange = undefined;
    });

    it('shows the loading state on the first load, before any topology exists', async () => {
        const firstLoad = deferred();
        mockedFetch.mockReturnValueOnce(firstLoad.promise);

        render(<NetworkTopologyView />);

        expect(screen.getByText('Loading network topology...')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Refresh topology' })).not.toBeInTheDocument();

        await act(async () => { firstLoad.resolve(topologyResponse()); });

        expect(await screen.findByRole('button', { name: 'Refresh topology' })).toBeEnabled();
        expect(screen.queryByText('Loading network topology...')).not.toBeInTheDocument();
        expect(await screen.findByTestId('topology-node-net-net-1')).toHaveTextContent('app-net');
    });

    it('keeps the toolbar mounted with the Refresh control busy during a reload', async () => {
        const firstLoad = deferred();
        const reload = deferred();
        mockedFetch
            .mockReturnValueOnce(firstLoad.promise)
            .mockReturnValueOnce(reload.promise);

        render(<NetworkTopologyView />);
        await act(async () => { firstLoad.resolve(topologyResponse()); });

        const refresh = await screen.findByRole('button', { name: 'Refresh topology' });
        const scopeToggle = screen.getByRole('switch', { name: 'Show system networks' });
        const networkNode = await screen.findByTestId('topology-node-net-net-1');
        const containerNode = screen.getByTestId('topology-node-ctr-container-1');
        expect(networkNode).toHaveTextContent('app-net');
        expect(containerNode).toHaveTextContent('app-web-1');
        expect(screen.getByTestId('topology-edge-edge-net-1-container-1')).toBeInTheDocument();
        expect(screen.getByTestId('topology-graph')).toBeInTheDocument();
        expect(scopeToggle).toBeEnabled();

        fireEvent.click(refresh);

        // The control stays in place, locked and marked busy, while the last
        // graph and its node and edge data stay mounted instead of the loading state.
        expect(screen.getByRole('button', { name: 'Refresh topology' })).toBe(refresh);
        expect(refresh).toBeDisabled();
        expect(refresh).toHaveAttribute('aria-busy', 'true');
        expect(screen.queryByText('Loading network topology...')).not.toBeInTheDocument();
        expect(screen.getByTestId('topology-graph')).toBeInTheDocument();
        expect(screen.getByTestId('topology-node-net-net-1')).toBe(networkNode);
        expect(screen.getByTestId('topology-node-ctr-container-1')).toBe(containerNode);
        expect(networkNode).toHaveTextContent('app-net');
        expect(containerNode).toHaveTextContent('app-web-1');
        expect(screen.getByTestId('topology-edge-edge-net-1-container-1')).toBeInTheDocument();
        expect(mockedFetch).toHaveBeenCalledTimes(2);
        // The scope toggle starts its own fetch, so it is locked during a reload
        // rather than allowed to overlap with one. Clicking the lock starts nothing.
        fireEvent.click(scopeToggle);
        expect(mockedFetch).toHaveBeenCalledTimes(2);
        expect(scopeToggle).toBeDisabled();

        // The shared busy control only shows its spinner once the reload is slow.
        await waitFor(() => expect(refresh.querySelector('svg')).toHaveClass('animate-spin'));

        // The response replaces the retained graph data rather than being ignored.
        await act(async () => { reload.resolve(topologyResponse([refreshedNetwork])); });
        await waitFor(() => expect(refresh).toBeEnabled());
        expect(refresh).not.toHaveAttribute('aria-busy');
        expect(refresh.querySelector('svg')).not.toHaveClass('animate-spin');
        expect(scopeToggle).toBeEnabled();
        expect(screen.queryByTestId('topology-node-net-net-1')).not.toBeInTheDocument();
        expect(screen.queryByTestId('topology-node-ctr-container-1')).not.toBeInTheDocument();
        expect(await screen.findByTestId('topology-node-net-net-2')).toHaveTextContent('data-net');
        expect(screen.getByTestId('topology-node-ctr-container-2')).toHaveTextContent('data-web-1');
        expect(screen.queryByTestId('topology-edge-edge-net-1-container-1')).not.toBeInTheDocument();
        expect(screen.getByTestId('topology-edge-edge-net-2-container-2')).toBeInTheDocument();
    });

    it('re-fits the canvas when a reload changes the graph', async () => {
        const firstLoad = deferred();
        const reload = deferred();
        mockedFetch
            .mockReturnValueOnce(firstLoad.promise)
            .mockReturnValueOnce(reload.promise);

        render(<NetworkTopologyView />);
        await act(async () => { firstLoad.resolve(topologyResponse()); });
        await screen.findByTestId('topology-node-net-net-1');
        // The first graph is framed by the canvas's initial fit.
        await waitFor(() => expect(flowState.fitView).toHaveBeenCalledTimes(1));
        flowState.fitView.mockClear();

        fireEvent.click(screen.getByRole('button', { name: 'Refresh topology' }));
        // The pending window keeps the old graph, so there is nothing to fit yet.
        expect(flowState.fitView).not.toHaveBeenCalled();

        await act(async () => { reload.resolve(topologyResponse([refreshedNetwork])); });
        await screen.findByTestId('topology-node-net-net-2');

        // The response re-laid out the graph under the preserved canvas, so it
        // is fitted again instead of rendering under the old viewport.
        await waitFor(() => expect(flowState.fitView).toHaveBeenCalledTimes(1));
        expect(flowState.fitView).toHaveBeenCalledWith({ padding: 0.3 });
    });

    it('leaves the viewport alone when a reload returns the same graph', async () => {
        const firstLoad = deferred();
        const reload = deferred();
        mockedFetch
            .mockReturnValueOnce(firstLoad.promise)
            .mockReturnValueOnce(reload.promise);

        const { rerender } = render(<NetworkTopologyView />);
        await act(async () => { firstLoad.resolve(topologyResponse()); });
        await screen.findByTestId('topology-node-net-net-1');
        await waitFor(() => expect(flowState.fitView).toHaveBeenCalledTimes(1));
        flowState.fitView.mockClear();

        fireEvent.click(screen.getByRole('button', { name: 'Refresh topology' }));
        await act(async () => { reload.resolve(topologyResponse()); });
        await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh topology' })).toBeEnabled());

        // React Flow re-measures every new node object, so the initialized flag
        // cycles false and back even when the ids are unchanged. The signature
        // guard is what keeps the operator's pan and zoom across that cycle.
        flowState.nodesInitialized = false;
        rerender(<NetworkTopologyView />);
        flowState.nodesInitialized = true;
        rerender(<NetworkTopologyView />);

        expect(flowState.fitView).not.toHaveBeenCalled();
    });

    it('does not re-fit when the operator drags a node', async () => {
        const firstLoad = deferred();
        mockedFetch.mockReturnValueOnce(firstLoad.promise);

        const { rerender } = render(<NetworkTopologyView />);
        await act(async () => { firstLoad.resolve(topologyResponse()); });
        await screen.findByTestId('topology-node-net-net-1');
        await waitFor(() => expect(flowState.fitView).toHaveBeenCalledTimes(1));
        flowState.fitView.mockClear();

        act(() => {
            flowState.onNodesChange?.([{ type: 'position', id: 'net-net-1', position: { x: 40, y: 40 } }]);
        });
        expect(screen.getByTestId('topology-node-net-net-1')).toHaveTextContent('app-net');

        // A drag only moves an existing node, so the graph identity is
        // unchanged even when measurement cycles again.
        flowState.nodesInitialized = false;
        rerender(<NetworkTopologyView />);
        flowState.nodesInitialized = true;
        rerender(<NetworkTopologyView />);

        expect(flowState.fitView).not.toHaveBeenCalled();
    });

    it('drops the retained graph and shows the failure state when a reload fails', async () => {
        const firstLoad = deferred();
        const reload = deferred();
        mockedFetch
            .mockReturnValueOnce(firstLoad.promise)
            .mockReturnValueOnce(reload.promise);

        render(<NetworkTopologyView />);
        await act(async () => { firstLoad.resolve(topologyResponse()); });

        const refresh = await screen.findByRole('button', { name: 'Refresh topology' });
        expect(await screen.findByTestId('topology-node-net-net-1')).toHaveTextContent('app-net');

        fireEvent.click(refresh);
        expect(screen.getByTestId('topology-node-net-net-1')).toHaveTextContent('app-net');

        await act(async () => {
            reload.resolve(new Response('{"error":"unavailable"}', {
                status: 503,
                headers: { 'content-type': 'application/json' },
            }));
        });

        expect(await screen.findByText('Could not load topology for this node.')).toBeInTheDocument();
        expect(screen.queryByTestId('topology-graph')).not.toBeInTheDocument();
        expect(screen.queryByTestId('topology-node-net-net-1')).not.toBeInTheDocument();
        expect(screen.queryByText('Loading network topology...')).not.toBeInTheDocument();
    });
});
