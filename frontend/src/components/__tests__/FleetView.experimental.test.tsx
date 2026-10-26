import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FleetView } from '../FleetView';

const useExperimentalMock = vi.fn(() => ({ experimental: true, experimentalReady: true }));
vi.mock('@/hooks/useExperimental', () => ({
  useExperimental: () => useExperimentalMock(),
}));

// Community license: Routing must not depend on a paid tier.
const useLicenseMock = vi.fn(() => ({ isPaid: false, isAdmiral: false, licenseStatus: 'ready' as 'ready' | 'loading' }));
vi.mock('@/context/LicenseContext', () => ({
  useLicense: () => useLicenseMock(),
}));
const useAuthMock = vi.fn(() => ({ isAdmin: true as boolean, can: () => true as boolean }));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => useAuthMock(),
}));
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
    dismissNodeUpdate: vi.fn(),
    checkUpdates: vi.fn(),
    confirmLocalUpdate: vi.fn(),
    cancelLocalUpdate: vi.fn(),
  }),
}));
vi.mock('../FleetView/hooks/useFleetOverview', () => ({
  useFleetOverview: () => ({
    nodes: [],
    processedNodes: [],
    allNodes: [],
    topologyNodes: [],
    viewMode: 'cards',
    setViewMode: vi.fn(),
    searchQuery: '',
    setSearchQuery: vi.fn(),
    fleetPalette: {},
    labelFilters: {},
    setLabelFilters: vi.fn(),
    clearFilters: vi.fn(),
    fleetStackLabelMap: {},
    updateStatusMap: {},
    mastheadStats: {
      nodeCount: 0,
      onlineCount: 0,
      criticalCount: 0,
      avgCpuNum: 0,
      totalMemUsed: 0,
      totalContainers: 0,
      totalContainersAll: 0,
    },
    lastSyncAt: null,
    loading: false,
    refreshing: false,
    fetchOverview: vi.fn(),
  }),
}));
vi.mock('../FleetView/hooks/useFleetPolling', () => ({
  useFleetPolling: () => {},
}));
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
vi.mock('../fleet/FleetReadiness', () => ({ FleetReadiness: () => null }));
const routingTabProps = vi.hoisted(() => ({
  current: null as null | { canManageNode: (nodeId: number) => boolean; canManageMembership: boolean },
}));
vi.mock('../fleet/RoutingTab', () => ({
  RoutingTab: (props: { canManageNode: (nodeId: number) => boolean; canManageMembership: boolean }) => {
    routingTabProps.current = props;
    return <div data-testid="routing-tab" />;
  },
}));
vi.mock('../fleet/FederationTab', () => ({ FederationTab: () => <div data-testid="federation-tab" /> }));
vi.mock('../blueprints/DeploymentsTab', () => ({ DeploymentsTab: () => <div data-testid="deployments-tab" /> }));
vi.mock('../fleet/FleetActions/FleetActionsTab', () => ({ FleetActionsTab: () => <div data-testid="actions-tab" /> }));
vi.mock('../fleet/secrets/SecretsTab', () => ({ SecretsTab: () => <div data-testid="secrets-tab" /> }));
vi.mock('../fleet/DependencyMapTab', () => ({ DependencyMapTab: () => null }));
vi.mock('../fleet/ContainerLabelsTab', () => ({ ContainerLabelsTab: () => null }));

describe('FleetView tab discovery and deep-link fallback', () => {
  beforeEach(() => {
    useExperimentalMock.mockReturnValue({ experimental: true, experimentalReady: true });
    useAuthMock.mockReturnValue({ isAdmin: true, can: () => true });
    useLicenseMock.mockReturnValue({ isPaid: false, isAdmiral: false, licenseStatus: 'ready' });
  });

  it('shows Routing when experimental is on; Secrets always visible for Admin', () => {
    render(<FleetView onNavigateToNode={vi.fn()} onOpenNodeNetworking={vi.fn()} />);
    expect(screen.getByRole('tab', { name: /routing/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /secrets/i })).toBeTruthy();
  });

  it('renders the Routing panel on a Community license when experimental is on', () => {
    const onTab = vi.fn();
    render(
      <FleetView
        onNavigateToNode={vi.fn()}
        onOpenNodeNetworking={vi.fn()}
        fleetActiveTab="routing"
        onFleetActiveTabChange={onTab}
      />,
    );
    expect(screen.getByTestId('routing-tab')).toBeTruthy();
    expect(onTab).not.toHaveBeenCalled();
  });

  it('keeps the Routing panel read-only for a user without manage permission', () => {
    useAuthMock.mockReturnValue({ isAdmin: false, can: () => false });
    render(
      <FleetView
        onNavigateToNode={vi.fn()}
        onOpenNodeNetworking={vi.fn()}
        fleetActiveTab="routing"
        onFleetActiveTabChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('routing-tab')).toBeTruthy();
    expect(routingTabProps.current?.canManageMembership).toBe(false);
    expect(routingTabProps.current?.canManageNode(1)).toBe(false);
  });

  it('keeps a Routing deep link and panel while the license is still loading', () => {
    useLicenseMock.mockReturnValue({ isPaid: false, isAdmiral: false, licenseStatus: 'loading' });
    const onTab = vi.fn();
    render(
      <FleetView
        onNavigateToNode={vi.fn()}
        onOpenNodeNetworking={vi.fn()}
        fleetActiveTab="routing"
        onFleetActiveTabChange={onTab}
      />,
    );
    expect(screen.getByTestId('routing-tab')).toBeTruthy();
    expect(onTab).not.toHaveBeenCalled();
  });

  it('renders no Routing panel when experimental is off', () => {
    useExperimentalMock.mockReturnValue({ experimental: false, experimentalReady: true });
    render(
      <FleetView
        onNavigateToNode={vi.fn()}
        onOpenNodeNetworking={vi.fn()}
        fleetActiveTab="routing"
        onFleetActiveTabChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('routing-tab')).toBeNull();
  });

  it('hides Routing when experimental off; Secrets stays visible for Admin', () => {
    useExperimentalMock.mockReturnValue({ experimental: false, experimentalReady: true });
    render(<FleetView onNavigateToNode={vi.fn()} onOpenNodeNetworking={vi.fn()} />);
    expect(screen.queryByRole('tab', { name: /routing/i })).toBeNull();
    expect(screen.getByRole('tab', { name: /secrets/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /blueprints/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /federation/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /actions/i })).toBeTruthy();
  });

  it('delayed experimental true preserves controlled routing without Overview callback', async () => {
    useExperimentalMock.mockReturnValue({ experimental: false, experimentalReady: false });
    const onTab = vi.fn();
    const { rerender } = render(
      <FleetView
        onNavigateToNode={vi.fn()}
        onOpenNodeNetworking={vi.fn()}
        fleetActiveTab="routing"
        onFleetActiveTabChange={onTab}
      />,
    );
    expect(screen.queryByRole('tab', { name: /routing/i })).toBeNull();
    expect(onTab).not.toHaveBeenCalled();

    useExperimentalMock.mockReturnValue({ experimental: true, experimentalReady: true });
    rerender(
      <FleetView
        onNavigateToNode={vi.fn()}
        onOpenNodeNetworking={vi.fn()}
        fleetActiveTab="routing"
        onFleetActiveTabChange={onTab}
      />,
    );
    await waitFor(() => expect(screen.getByRole('tab', { name: /routing/i })).toBeTruthy());
    expect(onTab).not.toHaveBeenCalled();
  });

  it('resolved experimental false falls back controlled routing to overview once', async () => {
    useExperimentalMock.mockReturnValue({ experimental: false, experimentalReady: false });
    const onTab = vi.fn();
    const { rerender } = render(
      <FleetView
        onNavigateToNode={vi.fn()}
        onOpenNodeNetworking={vi.fn()}
        fleetActiveTab="routing"
        onFleetActiveTabChange={onTab}
      />,
    );
    expect(onTab).not.toHaveBeenCalled();

    useExperimentalMock.mockReturnValue({ experimental: false, experimentalReady: true });
    rerender(
      <FleetView
        onNavigateToNode={vi.fn()}
        onOpenNodeNetworking={vi.fn()}
        fleetActiveTab="routing"
        onFleetActiveTabChange={onTab}
      />,
    );
    await waitFor(() => expect(onTab).toHaveBeenCalledWith('overview'));
    expect(onTab).toHaveBeenCalledTimes(1);
  });

  it('does not rewrite a Secrets deep link for Admin when experimental is off', () => {
    useExperimentalMock.mockReturnValue({ experimental: false, experimentalReady: true });
    const onTab = vi.fn();
    render(
      <FleetView
        onNavigateToNode={vi.fn()}
        onOpenNodeNetworking={vi.fn()}
        fleetActiveTab="secrets"
        onFleetActiveTabChange={onTab}
      />,
    );
    // No fallback rewrite; Secrets is always available to Admin
    expect(onTab).not.toHaveBeenCalled();
  });

  it('hides Secrets tab for non-admin', () => {
    useAuthMock.mockReturnValue({ isAdmin: false, can: () => false });
    render(<FleetView onNavigateToNode={vi.fn()} onOpenNodeNetworking={vi.fn()} />);
    expect(screen.queryByRole('tab', { name: /secrets/i })).toBeNull();
    // Routing still visible (gated on experimental only, not tier or admin)
    expect(screen.getByRole('tab', { name: /routing/i })).toBeTruthy();
    // Unrelated tabs still visible
    expect(screen.getByRole('tab', { name: /blueprints/i })).toBeTruthy();
  });
});
