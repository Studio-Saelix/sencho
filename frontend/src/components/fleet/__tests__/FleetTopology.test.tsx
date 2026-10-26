import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { ComponentType, ReactNode } from 'react';
import type { FleetTopologyNode } from '@/lib/fleet-topology-layout';

// Render each laid-out node through the real nodeTypes so the node header is
// under test; the canvas chrome (pan, zoom, minimap) is stubbed.
vi.mock('@xyflow/react', async () => {
  const { useState } = await import('react');
  type FlowNode = { id: string; type: string; data: unknown };
  const useFlowState = <T,>(initial: T[]) => {
    const [items, setItems] = useState<T[]>(initial);
    return [items, setItems, vi.fn()] as const;
  };
  return {
    ReactFlow: ({ nodes, nodeTypes, children }: { nodes: FlowNode[]; nodeTypes: Record<string, ComponentType<{ data: unknown }>>; children?: ReactNode }) => (
      <div>
        {nodes.map(n => {
          const Card = nodeTypes[n.type];
          return <div key={n.id} data-testid={`node-${n.id}`}><Card data={n.data} /></div>;
        })}
        {children}
      </div>
    ),
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
    Handle: () => null,
    Position: { Left: 'left', Right: 'right' },
    useNodesState: useFlowState,
    useEdgesState: useFlowState,
  };
});

import { FleetTopology } from '../FleetTopology';

function topologyNode(overrides: Partial<FleetTopologyNode>): FleetTopologyNode {
  return {
    id: 1, name: 'Local', type: 'local', status: 'online',
    cpuPercent: 10, memPercent: 20, diskPercent: 30,
    stackCount: 2, runningCount: 1, critical: false,
    ...overrides,
  };
}

function renderTopology(nodes: FleetTopologyNode[]) {
  return render(
    <FleetTopology
      nodes={nodes}
      mode="hub"
      onModeChange={vi.fn()}
      savedPositions={{}}
      onPositionsChange={vi.fn()}
    />,
  );
}

describe('FleetTopology node header', () => {
  it('shows only the dot and the connection pin on a healthy node', async () => {
    renderTopology([
      topologyNode({ id: 1, name: 'Local' }),
      topologyNode({ id: 2, name: 'Edge', type: 'remote', nodeMode: 'proxy' }),
    ]);

    const edge = await screen.findByTestId('node-2');
    expect(within(edge).getByText('Proxy')).toBeInTheDocument();
    expect(within(edge).getByRole('img', { name: 'Online' })).toBeInTheDocument();
    expect(screen.queryByText('Online')).not.toBeInTheDocument();
    expect(screen.queryByText(/^remote$/i)).not.toBeInTheDocument();
    expect(within(screen.getByTestId('node-1')).getByText('★ Local')).toBeInTheDocument();
  });

  it('names Critical and Offline, and does not announce Online when a word is shown', async () => {
    renderTopology([
      topologyNode({ id: 1, name: 'Local' }),
      topologyNode({ id: 2, name: 'Hot', type: 'remote', nodeMode: 'proxy', critical: true }),
      topologyNode({ id: 3, name: 'Gone', type: 'remote', nodeMode: 'pilot_agent', status: 'offline', critical: true }),
    ]);

    const hot = await screen.findByTestId('node-2');
    expect(within(hot).getByText('Critical')).toBeInTheDocument();
    expect(within(hot).queryByRole('img', { name: 'Online' })).not.toBeInTheDocument();

    const gone = screen.getByTestId('node-3');
    expect(within(gone).getByText('Offline')).toBeInTheDocument();
    expect(within(gone).queryByText('Critical')).not.toBeInTheDocument();
    expect(within(gone).getByText('Pilot')).toBeInTheDocument();
    expect(within(gone).queryByRole('img', { name: 'Online' })).not.toBeInTheDocument();
  });

  it('keeps the stale heartbeat clock on a pilot node and drops the critical icon', async () => {
    renderTopology([
      topologyNode({ id: 1, name: 'Local' }),
      topologyNode({ id: 2, name: 'Quiet', type: 'remote', nodeMode: 'pilot_agent', pilotLastSeen: Date.now() - 5 * 60_000 }),
      topologyNode({ id: 3, name: 'Hot', type: 'remote', nodeMode: 'proxy', critical: true }),
    ]);

    const quiet = await screen.findByTestId('node-2');
    expect(within(quiet).getByLabelText('Pilot heartbeat stale')).toBeInTheDocument();
    expect(screen.queryByLabelText('Critical')).not.toBeInTheDocument();
  });
});
