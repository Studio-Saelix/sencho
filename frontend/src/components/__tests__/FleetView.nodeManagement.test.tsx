import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NodeManagementActions } from '../FleetView/types';

const mocks = vi.hoisted(() => ({
  openCreate: vi.fn(),
  checkUpdates: vi.fn(),
  nodeManagement: null as NodeManagementActions | null,
  auth: { isAdmin: true, can: () => true as boolean },
}));

vi.mock('@/hooks/useExperimental', () => ({
  useExperimental: () => ({ experimental: false, experimentalReady: true }),
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => mocks.auth,
}));
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ hasCapability: () => false, nodes: [], isLoading: false }),
}));
vi.mock('../FleetView/hooks/useFleetPreferences', () => ({
  useFleetPreferences: () => ({ prefs: { sortBy: 'name', sortDir: 'asc', filterStatus: 'all', filterType: 'all', filterCritical: false, filterNetworking: 'all' }, updatePrefs: vi.fn() }),
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
    checkUpdates: mocks.checkUpdates,
    confirmLocalUpdate: vi.fn(),
    cancelLocalUpdate: vi.fn(),
    triggerNodeReapply: vi.fn(),
    triggerUpdateAll: vi.fn(),
  }),
}));
vi.mock('../FleetView/hooks/useFleetOverview', () => ({
  useFleetOverview: () => ({
    nodes: [],
    processedNodes: [],
    allNodes: [],
    topologyNodes: [],
    viewMode: 'grid',
    setViewMode: vi.fn(),
    searchQuery: '',
    setSearchQuery: vi.fn(),
    fleetPalette: [],
    labelFilters: new Set<string>(),
    setLabelFilters: vi.fn(),
    clearFilters: vi.fn(),
    fleetStackLabelMap: {},
    updateStatusMap: new Map(),
    networkingByNode: new Map(),
    gitopsAttentionByNode: new Map(),
    mastheadStats: { nodeCount: 0, onlineCount: 0, criticalCount: 0, avgCpuNum: 0, totalMemUsed: 0, totalContainers: 0, totalContainersAll: 0 },
    lastSyncAt: null,
    loading: false,
    refreshing: false,
    fetchOverview: vi.fn(),
  }),
}));
vi.mock('../FleetView/hooks/useFleetPolling', () => ({ useFleetPolling: () => {} }));
vi.mock('../FleetView/hooks/useFleetDossierExport', () => ({ useFleetDossierExport: () => ({ exporting: false, exportDossier: vi.fn() }) }));
vi.mock('@/hooks/useTopologyPreferences', () => ({ useTopologyPreferences: () => ({ prefs: { mode: 'hub', positions: {} }, setMode: vi.fn(), setPositions: vi.fn() }) }));
vi.mock('@/hooks/useFleetReadiness', () => ({}));
vi.mock('../nodes/useNodeActions', () => ({
  useNodeActions: () => ({ openCreate: mocks.openCreate, openEdit: vi.fn(), openDelete: vi.fn(), NodeActionModals: null }),
}));
vi.mock('../fleet/fleetTabs', () => ({ buildFleetTabs: () => [{ id: 'overview', label: 'Overview' }] }));
vi.mock('@/hooks/use-fleet-tab-layout', () => ({ useFleetTabLayout: () => ['full'] }));
vi.mock('../fleet/FleetMasthead', () => ({ FleetMasthead: () => <div data-testid="masthead" /> }));
vi.mock('../fleet/FleetTabStrip', () => ({ FleetTabStrip: () => <div /> }));
vi.mock('../fleet/FleetReadiness', () => ({ FleetReadiness: () => null }));
vi.mock('../fleet/readiness/useFleetReadiness', () => ({ useFleetReadiness: () => ({ data: null, error: null, checking: false, retry: vi.fn() }) }));
vi.mock('../fleet/readiness/canDismissFinding', () => ({ canDismissFinding: () => false }));
vi.mock('../fleet/readiness/readinessVerbs', () => ({ canRunVerb: () => false }));
vi.mock('../FleetView/OverviewTab', () => ({
  OverviewTab: ({ nodeManagement }: { nodeManagement?: NodeManagementActions }) => {
    mocks.nodeManagement = nodeManagement ?? null;
    if (!nodeManagement) return <div data-testid="overview-tab" />;
    return (
      <div data-testid="overview-tab">
        {nodeManagement.canConnectExisting && <button type="button" onClick={nodeManagement.onConnectExisting}>call-connect</button>}
        {nodeManagement.canBootstrapServer && <button type="button" onClick={nodeManagement.onBootstrapServer}>call-bootstrap</button>}
        <button type="button" onClick={nodeManagement.onCheckUpdates}>call-updates</button>
      </div>
    );
  },
}));
vi.mock('../FleetView/ReconnectingOverlay', () => ({ ReconnectingOverlay: () => null }));
vi.mock('../FleetView/NodeUpdatesSheet', () => ({ NodeUpdatesSheet: () => null }));
vi.mock('../FleetView/LocalUpdateConfirmDialog', () => ({ LocalUpdateConfirmDialog: () => null }));
vi.mock('../FleetView/NodeDetailsSheet', () => ({ NodeDetailsSheet: () => null }));
vi.mock('../FleetSnapshots', () => ({ default: () => null }));
vi.mock('../fleet/RoutingTab', () => ({ RoutingTab: () => null }));
vi.mock('../fleet/FederationTab', () => ({ FederationTab: () => null }));
vi.mock('../blueprints/DeploymentsTab', () => ({ DeploymentsTab: () => null }));
vi.mock('../fleet/FleetActions/FleetActionsTab', () => ({ FleetActionsTab: () => null }));
vi.mock('../fleet/secrets/SecretsTab', () => ({ SecretsTab: () => null }));
vi.mock('../fleet/DependencyMapTab', () => ({ DependencyMapTab: () => null }));
vi.mock('../fleet/useFleetMap', () => ({ useFleetMap: () => ({}) }));
vi.mock('../fleet/ContainerLabelsTab', () => ({ ContainerLabelsTab: () => null }));
vi.mock('../nodes/bootstrap/BootstrapServerDialog', () => ({
  BootstrapServerDialog: ({ open }: { open: boolean }) => open ? <div data-testid="bootstrap-dialog" /> : null,
}));

import { FleetView } from '../FleetView';

function renderFleet(onOpenSettingsSection = vi.fn()) {
  return render(
    <FleetView
      onNavigateToNode={vi.fn()}
      onOpenNodeNetworking={vi.fn()}
      onOpenSettingsSection={onOpenSettingsSection}
    />,
  );
}

describe('FleetView node management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.nodeManagement = null;
    mocks.auth = { isAdmin: true, can: () => true };
  });

  it('opens the existing Add node modal in place instead of navigating to Settings', async () => {
    const user = userEvent.setup();
    const onOpenSettingsSection = vi.fn();
    renderFleet(onOpenSettingsSection);
    await user.click(screen.getByRole('button', { name: 'call-connect' }));
    expect(mocks.openCreate).toHaveBeenCalledTimes(1);
    expect(onOpenSettingsSection).not.toHaveBeenCalled();
  });

  it('opens the bootstrap wizard from the menu action', async () => {
    const user = userEvent.setup();
    renderFleet();
    expect(screen.queryByTestId('bootstrap-dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'call-bootstrap' }));
    expect(screen.getByTestId('bootstrap-dialog')).toBeInTheDocument();
  });

  it('routes the update item to the existing update check', async () => {
    const user = userEvent.setup();
    renderFleet();
    await user.click(screen.getByRole('button', { name: 'call-updates' }));
    expect(mocks.checkUpdates).toHaveBeenCalledTimes(1);
  });

  it('hides Connect from a session without node:manage and Bootstrap from a non-admin', () => {
    mocks.auth = { isAdmin: false, can: () => false };
    renderFleet();
    expect(mocks.nodeManagement?.canConnectExisting).toBe(false);
    expect(mocks.nodeManagement?.canBootstrapServer).toBe(false);
    expect(screen.queryByRole('button', { name: 'call-connect' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'call-bootstrap' })).toBeNull();
  });

  it('hides Bootstrap from a node-admin but keeps Connect', () => {
    mocks.auth = { isAdmin: false, can: (action?: string) => action === 'node:manage' };
    renderFleet();
    expect(mocks.nodeManagement?.canConnectExisting).toBe(true);
    expect(mocks.nodeManagement?.canBootstrapServer).toBe(false);
  });
});
