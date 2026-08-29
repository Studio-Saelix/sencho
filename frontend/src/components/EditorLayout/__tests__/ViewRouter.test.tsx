import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import * as AuthContext from '@/context/AuthContext';
import * as LicenseContext from '@/context/LicenseContext';
import * as NodeContext from '@/context/NodeContext';
import { ViewRouter } from '../ViewRouter';

vi.mock('@/context/AuthContext');
vi.mock('@/context/LicenseContext');
vi.mock('@/context/NodeContext');

vi.mock('../../HostConsole', () => ({
  default: ({ nodeId, stackName }: { nodeId: number; stackName?: string | null }) => (
    <div
      data-testid="host-console"
      data-node-id={String(nodeId)}
      data-stack={stackName ?? ''}
    >
      Host Console
    </div>
  ),
}));

vi.mock('../../LazyBoundary', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const baseProps = {
  activeView: 'host-console' as const,
  selectedFile: null as string | null,
  isLoading: false,
  settingsSection: 'appearance' as const,
  onSettingsSectionChange: vi.fn(),
  onTemplateDeploySuccess: vi.fn(),
  onHostConsoleClose: vi.fn(),
  onFleetNavigateToNode: vi.fn(),
  onOpenNodeNetworking: vi.fn(),
  filterNodeId: null,
  onClearScheduledOpsFilter: vi.fn(),
  schedulePrefill: null,
  onPrefillConsumed: vi.fn(),
  muteRulePrefill: null,
  onMutePrefillConsumed: vi.fn(),
  notifications: [] as [],
  onNavigateToStack: vi.fn(),
  onOpenSettingsSection: vi.fn(),
  onClearNotifications: vi.fn(),
  securityTab: 'overview' as const,
  onSecurityTabChange: vi.fn(),
  renderEditor: () => null,
  stackUpdates: {},
  urlHydratingStack: null as string | null,
  isFileLoading: false,
  quickLinkCandidates: [],
};

describe('ViewRouter host-console', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/nodes/local/host-console');
    vi.mocked(AuthContext.useAuth).mockReturnValue({
      can: (p: string) => p === 'system:console',
    } as unknown as ReturnType<typeof AuthContext.useAuth>);
    vi.mocked(LicenseContext.useLicense).mockReturnValue({
      isPaid: false,
      licenseReady: true,
    } as unknown as ReturnType<typeof LicenseContext.useLicense>);
    vi.mocked(NodeContext.useNodes).mockReturnValue({
      activeNode: { id: 1, name: 'Local', type: 'local' },
      activeNodeMeta: { version: '0.96.0', capabilities: ['host-console', 'host-console-community'], fetchedAt: 1 },
    } as unknown as ReturnType<typeof NodeContext.useNodes>);
  });

  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('renders Host Console for a Community admin on the local node', async () => {
    render(<ViewRouter {...baseProps} />);
    const el = await screen.findByTestId('host-console');
    expect(el.getAttribute('data-node-id')).toBe('1');
  });

  it('does not mount HostConsole while the active node is unresolved', () => {
    vi.mocked(NodeContext.useNodes).mockReturnValue({
      activeNode: null,
      activeNodeMeta: null,
    } as unknown as ReturnType<typeof NodeContext.useNodes>);
    render(<ViewRouter {...baseProps} />);
    expect(screen.queryByTestId('host-console')).toBeNull();
  });

  it('does not mount HostConsole while a stack deep link is still hydrating', () => {
    render(<ViewRouter {...baseProps} urlHydratingStack="radarr" selectedFile={null} />);
    expect(screen.queryByTestId('host-console')).toBeNull();
  });

  it('does not mount a root shell while the URL targets a stack-scoped Console', () => {
    window.history.replaceState({}, '', '/nodes/local/host-console/radarr');
    render(<ViewRouter {...baseProps} selectedFile={null} urlHydratingStack={null} />);
    expect(screen.queryByTestId('host-console')).toBeNull();
  });

  it('mounts stack-scoped Console only after selectedFile matches the route', async () => {
    window.history.replaceState({}, '', '/nodes/local/host-console/radarr');
    render(<ViewRouter {...baseProps} selectedFile="radarr" />);
    const el = await screen.findByTestId('host-console');
    expect(el.getAttribute('data-stack')).toBe('radarr');
    expect(el.getAttribute('data-node-id')).toBe('1');
  });

  it('renders nothing without system:console', () => {
    vi.mocked(AuthContext.useAuth).mockReturnValue({
      can: () => false,
    } as unknown as ReturnType<typeof AuthContext.useAuth>);
    const { container } = render(<ViewRouter {...baseProps} />);
    expect(container.querySelector('[data-testid="host-console"]')).toBeNull();
  });

  it('shows a skeleton while remote metadata is loading (does not mount HostConsole)', () => {
    vi.mocked(NodeContext.useNodes).mockReturnValue({
      activeNode: { id: 2, name: 'Legacy', type: 'remote' },
      activeNodeMeta: null,
    } as unknown as ReturnType<typeof NodeContext.useNodes>);
    render(<ViewRouter {...baseProps} />);
    expect(screen.queryByTestId('host-console')).toBeNull();
  });

  it('shows a lock card for Community + legacy remote without mounting HostConsole', () => {
    vi.mocked(NodeContext.useNodes).mockReturnValue({
      activeNode: { id: 2, name: 'Legacy', type: 'remote', mode: 'proxy' },
      activeNodeMeta: { version: '0.95.0', capabilities: ['host-console'], fetchedAt: 1 },
    } as unknown as ReturnType<typeof NodeContext.useNodes>);
    render(<ViewRouter {...baseProps} />);
    expect(screen.queryByTestId('host-console')).toBeNull();
    expect(screen.getByText(/Host Console is not available on this node/i)).toBeTruthy();
    expect(screen.getByText(/Legacy is running v0\.95\.0\. Upgrade the node to use this feature\./i)).toBeTruthy();
  });

  it('shows Pilot-specific copy for a pilot_agent node without mounting HostConsole', () => {
    vi.mocked(NodeContext.useNodes).mockReturnValue({
      activeNode: { id: 4, name: 'Pilot', type: 'remote', mode: 'pilot_agent' },
      activeNodeMeta: { version: '0.97.1', capabilities: [], fetchedAt: 1 },
    } as unknown as ReturnType<typeof NodeContext.useNodes>);
    render(<ViewRouter {...baseProps} />);
    expect(screen.queryByTestId('host-console')).toBeNull();
    expect(screen.getByText(/Host Console is not available through Pilot Agent yet/i)).toBeTruthy();
    expect(screen.getByText(/Host Console is currently available on the local node and Distributed API Proxy remotes\./i)).toBeTruthy();
    expect(screen.queryByText(/Upgrade the node to use this feature\./i)).toBeNull();
  });

  it('mounts Host Console for Admiral + legacy remote after meta resolves', async () => {
    vi.mocked(LicenseContext.useLicense).mockReturnValue({
      isPaid: true,
      licenseReady: true,
    } as unknown as ReturnType<typeof LicenseContext.useLicense>);
    vi.mocked(NodeContext.useNodes).mockReturnValue({
      activeNode: { id: 2, name: 'Legacy', type: 'remote' },
      activeNodeMeta: { version: '0.95.0', capabilities: ['host-console'], fetchedAt: 1 },
    } as unknown as ReturnType<typeof NodeContext.useNodes>);
    render(<ViewRouter {...baseProps} />);
    const el = await screen.findByTestId('host-console');
    expect(el.getAttribute('data-node-id')).toBe('2');
  });

  it('shows a skeleton for legacy-only remote while license is still loading', () => {
    vi.mocked(LicenseContext.useLicense).mockReturnValue({
      isPaid: false,
      licenseReady: false,
    } as unknown as ReturnType<typeof LicenseContext.useLicense>);
    vi.mocked(NodeContext.useNodes).mockReturnValue({
      activeNode: { id: 2, name: 'Legacy', type: 'remote' },
      activeNodeMeta: { version: '0.95.0', capabilities: ['host-console'], fetchedAt: 1 },
    } as unknown as ReturnType<typeof NodeContext.useNodes>);
    render(<ViewRouter {...baseProps} />);
    expect(screen.queryByTestId('host-console')).toBeNull();
    expect(screen.queryByText(/Host Console is not available on this node/i)).toBeNull();
  });

  it('mounts Host Console for Community + host-console-community remote', async () => {
    vi.mocked(NodeContext.useNodes).mockReturnValue({
      activeNode: { id: 3, name: 'NewPeer', type: 'remote' },
      activeNodeMeta: {
        version: '0.96.0',
        capabilities: ['host-console', 'host-console-community'],
        fetchedAt: 1,
      },
    } as unknown as ReturnType<typeof NodeContext.useNodes>);
    render(<ViewRouter {...baseProps} />);
    expect(await screen.findByTestId('host-console')).toBeTruthy();
  });
});
