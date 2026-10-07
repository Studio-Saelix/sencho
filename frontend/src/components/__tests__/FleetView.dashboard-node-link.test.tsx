import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FleetView } from '../FleetView';

// Mocks mirror FleetView.experimental.test.tsx. Everything except the intent
// effect is stubbed, so the assertions below are about the deep link and
// nothing else.
vi.mock('@/hooks/useExperimental', () => ({
  useExperimental: () => ({ experimental: true, experimentalReady: true }),
}));
vi.mock('@/context/LicenseContext', () => ({
  useLicense: () => ({ isPaid: true, licenseStatus: 'ready' as const }),
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAdmin: true, can: () => true as boolean }),
}));
// registryNodes must be a real array: the details sheet mount reads it as soon
// as a node is selected, so an absent `nodes` throws on `.find`.
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ hasCapability: () => false, nodes: [] }),
}));

vi.mock('../FleetView/hooks/useFleetPreferences', () => ({
  useFleetPreferences: () => ({ prefs: {}, updatePrefs: vi.fn() }),
}));
vi.mock('../FleetView/hooks/useFleetUpdateStatus', () => ({
  useFleetUpdateStatus: () => ({
    updateStatuses: [],
    localUpdateConfirm: null,
    setShowUpdateModal: vi.fn(),
    fetchUpdateStatus: vi.fn(),
    showUpdateModal: false,
    checkingUpdates: false,
    updatingNodeId: null,
    reconnecting: false,
    preUpdateStartedAt: null,
    triggerNodeUpdate: vi.fn(),
    retryNodeUpdate: vi.fn(),
    reapplyConfirm: null,
    dismissNodeUpdate: vi.fn(),
    checkUpdates: vi.fn(),
    confirmLocalUpdate: vi.fn(),
    cancelLocalUpdate: vi.fn(),
    triggerNodeReapply: vi.fn(),
    triggerUpdateAll: vi.fn(),
  }),
}));

const LINKED_NODE = { id: 7, name: 'edge-02', type: 'remote' as const, status: 'offline' as const };

vi.mock('../FleetView/hooks/useFleetOverview', () => ({
  useFleetOverview: () => ({
    nodes: [LINKED_NODE],
    processedNodes: [LINKED_NODE],
    allNodes: [LINKED_NODE],
    topologyNodes: [LINKED_NODE],
    viewMode: 'cards',
    setViewMode: vi.fn(),
    searchQuery: '',
    setSearchQuery: vi.fn(),
    fleetPalette: {},
    labelFilters: {},
    setLabelFilters: vi.fn(),
    clearFilters: vi.fn(),
    fleetStackLabelMap: {},
    updateStatusMap: new Map(),
    networkingByNode: new Map(),
    mastheadStats: {
      nodeCount: 1,
      onlineCount: 0,
      criticalCount: 0,
      avgCpuNum: 0,
      worstCpu: 0,
      totalMemUsed: 0,
      totalMemTotal: 0,
      totalContainers: 0,
      totalContainersAll: 0,
    },
    lastSyncAt: null,
    loading: false,
    refreshing: false,
    fetchOverview: vi.fn(),
  }),
}));

vi.mock('../FleetView/hooks/useFleetPolling', () => ({ useFleetPolling: () => {} }));
vi.mock('../FleetView/hooks/useFleetDossierExport', () => ({
  useFleetDossierExport: () => ({ exporting: false, exportDossier: vi.fn() }),
}));
vi.mock('@/hooks/useTopologyPreferences', () => ({
  useTopologyPreferences: () => ({ prefs: { mode: 'hub', positions: {} }, setMode: vi.fn(), setPositions: vi.fn() }),
}));
vi.mock('../nodes/useNodeActions', () => ({
  useNodeActions: () => ({ openEdit: vi.fn(), openDelete: vi.fn(), NodeActionModals: null }),
}));
vi.mock('../fleet/FleetMasthead', () => ({ FleetMasthead: () => <div data-testid="masthead" /> }));
vi.mock('../FleetView/OverviewTab', () => ({ OverviewTab: () => <div data-testid="overview-tab" /> }));
vi.mock('../FleetView/ReconnectingOverlay', () => ({ ReconnectingOverlay: () => null }));
vi.mock('../FleetView/NodeUpdatesSheet', () => ({ NodeUpdatesSheet: () => null }));
vi.mock('../FleetView/LocalUpdateConfirmDialog', () => ({ LocalUpdateConfirmDialog: () => null }));
vi.mock('../FleetSnapshots', () => ({ default: () => null }));
vi.mock('../fleet/FleetConfiguration', () => ({ FleetConfiguration: () => null }));
vi.mock('../fleet/RoutingTab', () => ({ RoutingTab: () => <div data-testid="routing-tab" /> }));
vi.mock('../fleet/FederationTab', () => ({ FederationTab: () => <div data-testid="federation-tab" /> }));
vi.mock('../blueprints/DeploymentsTab', () => ({ DeploymentsTab: () => <div data-testid="deployments-tab" /> }));
vi.mock('../fleet/FleetActions/FleetActionsTab', () => ({ FleetActionsTab: () => <div data-testid="actions-tab" /> }));
vi.mock('../fleet/secrets/SecretsTab', () => ({ SecretsTab: () => <div data-testid="secrets-tab" /> }));
vi.mock('../fleet/DependencyMapTab', () => ({ DependencyMapTab: () => null }));
vi.mock('../fleet/ContainerLabelsTab', () => ({ ContainerLabelsTab: () => null }));
vi.mock('../PaidGate', () => ({ PaidGate: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

// The destination the deep link must reach. Driving the real sheet would test
// the sheet; what is under test is that the intent reaches it with the node.
vi.mock('../FleetView/NodeDetailsSheet', () => ({
  NodeDetailsSheet: ({ open, node }: { open: boolean; node: { id: number; name: string } | null }) =>
    open ? (
      <div
        data-testid="node-details-sheet"
        data-node-id={String(node?.id)}
        data-node-name={node?.name ?? ''}
      />
    ) : null,
}));

describe('FleetView dashboard node link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens the details sheet for the linked node and consumes the intent', () => {
    const onConsumed = vi.fn();
    render(
      <FleetView
        onNavigateToNode={vi.fn()}
        onOpenNodeNetworking={vi.fn()}
        fleetNodeIntent={7}
        onFleetNodeIntentConsumed={onConsumed}
      />,
    );

    const sheet = screen.getByTestId('node-details-sheet');
    expect(sheet.getAttribute('data-node-id')).toBe('7');
    expect(sheet.getAttribute('data-node-name')).toBe('edge-02');
    expect(onConsumed).toHaveBeenCalledTimes(1);
  });

  it('renders no details sheet without an intent', () => {
    render(
      <FleetView
        onNavigateToNode={vi.fn()}
        onOpenNodeNetworking={vi.fn()}
        fleetNodeIntent={null}
        onFleetNodeIntentConsumed={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('node-details-sheet')).toBeNull();
  });

  it('does not re-open the sheet while the same intent stays unconsumed', () => {
    const onConsumed = vi.fn();
    const { rerender } = render(
      <FleetView
        onNavigateToNode={vi.fn()}
        onOpenNodeNetworking={vi.fn()}
        fleetNodeIntent={7}
        onFleetNodeIntentConsumed={onConsumed}
      />,
    );

    // Simulate a parent render that has not yet cleared the intent: the effect
    // deps are unchanged, so it must not fire a second time.
    rerender(
      <FleetView
        onNavigateToNode={vi.fn()}
        onOpenNodeNetworking={vi.fn()}
        fleetNodeIntent={7}
        onFleetNodeIntentConsumed={onConsumed}
      />,
    );

    expect(onConsumed).toHaveBeenCalledTimes(1);
  });
});
