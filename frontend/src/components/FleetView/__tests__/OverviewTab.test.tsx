import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Stub the heavy children so this test exercises OverviewTab's own
// branch-selection logic, not NodeCard/FleetTopology internals.
vi.mock('../NodeCard', () => ({ NodeCard: ({ node }: { node: { name: string } }) => <div data-testid="node-card">{node.name}</div> }));
vi.mock('../../fleet/FleetTopology', () => ({ FleetTopology: () => <div data-testid="topology" /> }));

import { OverviewTab } from '../OverviewTab';
import type { FleetNode, FleetPreferences } from '../types';

const PREFS: FleetPreferences = { sortBy: 'name', sortDir: 'asc', filterStatus: 'all', filterType: 'all', filterCritical: false, filterNetworking: 'all' };

function node(id: number, name: string): FleetNode {
  return { id, name, type: 'remote', status: 'online', stats: null, systemStats: null, stacks: null, cordoned: false, cordoned_at: null, cordoned_reason: null };
}

function props(overrides: Partial<React.ComponentProps<typeof OverviewTab>> = {}) {
  return {
    loading: false,
    nodes: [node(1, 'Alpha')],
    processedNodes: [node(1, 'Alpha')],
    allNodes: [node(1, 'Alpha')],
    topologyNodes: [],
    viewMode: 'grid' as const,
    onViewModeChange: vi.fn(),
    searchQuery: '',
    onSearchQueryChange: vi.fn(),
    prefs: PREFS,
    onPrefsChange: vi.fn(),
    fleetPalette: [],
    labelFilters: new Set<string>(),
    onLabelFiltersChange: vi.fn(),
    onClearFilters: vi.fn(),
    fleetStackLabelMap: {},
    updateStatusMap: new Map(),
    onNavigateToNode: vi.fn(),
    updatingNodeId: null,
    topologyMode: 'hub' as const,
    onTopologyModeChange: vi.fn(),
    topologyPositions: {},
    onTopologyPositionsChange: vi.fn(),
    ...overrides,
  };
}

describe('OverviewTab', () => {
  it('renders node cards when nodes are present', () => {
    render(<OverviewTab {...props()} />);
    expect(screen.getByTestId('node-card')).toHaveTextContent('Alpha');
  });

  it('shows the empty state when no nodes are configured', () => {
    render(<OverviewTab {...props({ nodes: [], processedNodes: [], allNodes: [] })} />);
    expect(screen.getByText('No nodes configured')).toBeInTheDocument();
  });

  it('shows the no-match state when filters exclude every node', () => {
    render(<OverviewTab {...props({ processedNodes: [], allNodes: [] })} />);
    expect(screen.getByText('No nodes match your filters')).toBeInTheDocument();
  });

  it('renders the topology view in topology mode', () => {
    render(<OverviewTab {...props({ viewMode: 'topology' })} />);
    expect(screen.getByTestId('topology')).toBeInTheDocument();
  });
});
