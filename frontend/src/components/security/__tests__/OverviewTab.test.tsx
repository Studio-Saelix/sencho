/**
 * OverviewTab review-queue affordances for remediation-aware posture:
 * non-blocker View findings, Check again gating, and node-scoped refresh.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SecurityOverview, PostureReason } from '@/types/security';

// Mutable so individual tests can pin the active node type/capabilities.
const nodeState: {
  activeNode: { id: number; type: string } | null;
  activeNodeMeta: { capabilities: string[] } | null;
} = { activeNode: { id: 1, type: 'local' }, activeNodeMeta: null };

vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({
    activeNode: nodeState.activeNode,
    activeNodeMeta: nodeState.activeNodeMeta,
  }),
}));
const authState: { can: (action: string, type?: string, id?: string, nodeId?: number) => boolean } = { can: () => false };
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ can: authState.can }) }));
vi.mock('@/context/DeployFeedbackContext', () => ({ useDeployFeedback: () => ({ runWithLog: vi.fn() }) }));
const dismissalState: { dismissals: unknown[]; dismiss: ReturnType<typeof vi.fn>; restore: ReturnType<typeof vi.fn> } = {
  dismissals: [], dismiss: vi.fn(), restore: vi.fn(),
};
vi.mock('@/hooks/useNodeDismissals', () => ({
  useNodeDismissals: () => ({
    dismissals: dismissalState.dismissals,
    dismiss: dismissalState.dismiss,
    restore: dismissalState.restore,
    isPending: () => false,
  }),
}));
vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => false }));
vi.mock('../ScanNodeLauncher', () => ({ ScanNodeLauncher: () => null }));
vi.mock('../SecurityCharts', () => ({
  RiskTrendChart: () => null,
  ActionPostureChart: () => null,
  TopExploitRiskList: () => null,
  CvssEpssQuadrantChart: () => null,
}));
vi.mock('../SecurityMobile', () => ({
  SecuritySevStrip: () => null,
  SecurityTotalsGrid: () => null,
  SecurityFooterBand: () => null,
}));

import { apiFetch } from '@/lib/api';
import { REMOTE_IMAGE_INSPECT_V1_CAPABILITY } from '@/lib/capabilities';
import { toast } from '@/components/ui/toast-store';
import { OverviewTab } from '../OverviewTab';
import { useSecurityReasons } from '../useSecurityReasons';
import type { ComponentProps } from 'react';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
type OverviewNavigate = ComponentProps<typeof OverviewTab>['onNavigate'];

function reason(partial: Partial<PostureReason> & Pick<PostureReason, 'kind' | 'label'>): PostureReason {
  return {
    count: 2,
    severity: 'info',
    description: 'test description',
    targetTab: 'images',
    actionLabel: 'View findings',
    ...partial,
  };
}

function overview(reasons: PostureReason[], extra: Partial<SecurityOverview> = {}): SecurityOverview {
  return {
    scannedImages: 1,
    critical: 1,
    high: 0,
    fixable: 1,
    secrets: 0,
    misconfigs: 0,
    staleScans: 0,
    failedScans: 0,
    lastSuccessfulScanAt: Date.now(),
    scanner: { available: true, version: '0.50.0', source: 'managed', autoUpdate: true },
    deployEnforcement: { honorSuppressionsOnDeploy: true, eligibleBlockPolicies: 0 },
    posture: 'Monitoring',
    postureReasons: reasons,
    primaryAction: null,
    ...extra,
  };
}

type OverviewProps = ComponentProps<typeof OverviewTab>;

function Harness({ data, onNavigate, onInspect, reload }: {
  data: SecurityOverview;
  onNavigate: OverviewNavigate;
  onInspect: OverviewProps['onInspect'];
  reload: () => void;
}) {
  const reasons = useSecurityReasons({ overview: data, isReplica: false, onNavigate, reload });
  return (
    <OverviewTab
      overview={data}
      loadError={null}
      trend={[]}
      exploitIntel={[]}
      exploitTruncated={false}
      onNavigate={onNavigate}
      onInspect={onInspect}
      canScan={false}
      onScanComplete={vi.fn()}
      reasons={reasons}
    />
  );
}

function renderOverview(
  reasons: PostureReason[],
  opts: {
    canManageNode?: boolean;
    updateChecksDisabled?: boolean;
    onNavigate?: OverviewNavigate;
  } = {},
) {
  const onNavigate: OverviewNavigate = opts.onNavigate ?? vi.fn();
  const reload = vi.fn();
  authState.can = (action) => (action === 'node:manage' ? (opts.canManageNode ?? false) : false);
  render(
    <Harness
      data={overview(reasons, { updateChecksDisabled: opts.updateChecksDisabled })}
      onNavigate={onNavigate}
      onInspect={vi.fn()}
      reload={reload}
    />,
  );
  return { onNavigate, reload };
}

describe('OverviewTab remediation affordances', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    nodeState.activeNode = { id: 1, type: 'local' };
    nodeState.activeNodeMeta = null;
    dismissalState.dismissals = [];
  });

  it('titles the review queue Why Monitoring when posture is Monitoring without blockers', () => {
    renderOverview([
      reason({ kind: 'waiting_upstream', label: 'Waiting for upstream image', severity: 'review' }),
    ]);
    expect(screen.getByRole('heading', { name: /why monitoring/i })).toBeInTheDocument();
  });

  it('passes waiting_upstream driver meta into Images targeting', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderOverview([
      reason({
        kind: 'waiting_upstream',
        label: 'Waiting for upstream image',
        severity: 'review',
        targets: [{ imageRef: 'app:1' }],
        drivers: [{ vulnerabilityId: 'CVE-1', imageRef: 'app:1' }],
        driverCount: 5,
        driversTruncated: true,
      }),
    ]);
    await user.click(screen.getByRole('button', { name: /view findings/i }));
    expect(onNavigate).toHaveBeenCalledWith('images', undefined, {
      kind: 'waiting_upstream',
      label: 'Waiting for upstream image',
      imageRefs: ['app:1'],
      targets: [{ imageRef: 'app:1' }],
      drivers: [{ vulnerabilityId: 'CVE-1', imageRef: 'app:1' }],
      driverCount: 5,
      driversTruncated: true,
    });
  });

  it('renders View findings on a waiting_upstream non-blocker row', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderOverview([
      reason({ kind: 'waiting_upstream', label: 'Waiting for upstream image' }),
    ]);
    const btn = screen.getByRole('button', { name: /view findings/i });
    await user.click(btn);
    expect(onNavigate).toHaveBeenCalledWith('images', undefined, undefined);
  });

  it('passes public_exposure targets from the review queue', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderOverview([
      reason({
        kind: 'public_exposure',
        label: 'Network-exposed images not yet classified',
        severity: 'review',
        actionLabel: 'Review networking',
        targets: [{ imageRef: 'exp:1' }, { imageRef: 'exp:2' }],
      }),
    ]);
    await user.click(screen.getByRole('button', { name: /review networking/i }));
    expect(onNavigate).toHaveBeenCalledWith('images', undefined, {
      kind: 'public_exposure',
      label: 'Network-exposed images not yet classified',
      imageRefs: ['exp:1', 'exp:2'],
      targets: [{ imageRef: 'exp:1' }, { imageRef: 'exp:2' }],
    });
  });

  it('passes elevated_exploit_risk drivers into Images targeting', async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderOverview([
      reason({
        kind: 'elevated_exploit_risk',
        label: 'Elevated exploit risk on network-exposed workload',
        severity: 'blocker',
        actionLabel: 'Review driving findings',
        targets: [{ imageRef: 'web:1', intentStatus: 'set', exposureIntent: 'public' }],
        drivers: [
          { vulnerabilityId: 'CVE-2024-1', imageRef: 'web:1' },
          { vulnerabilityId: 'CVE-2024-2', imageRef: 'web:1' },
        ],
      }),
    ]);
    await user.click(screen.getByRole('button', { name: /review driving findings/i }));
    expect(onNavigate).toHaveBeenCalledWith('images', undefined, {
      kind: 'elevated_exploit_risk',
      label: 'Elevated exploit risk on network-exposed workload',
      imageRefs: ['web:1'],
      targets: [{ imageRef: 'web:1', intentStatus: 'set', exposureIntent: 'public' }],
      drivers: [
        { vulnerabilityId: 'CVE-2024-1', imageRef: 'web:1' },
        { vulnerabilityId: 'CVE-2024-2', imageRef: 'web:1' },
      ],
    });
  });

  it('shows Check again for update_check_uncertain when canManageNode and checks enabled', async () => {
    const user = userEvent.setup();
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, message: 'Image update check started in background.' }),
    });
    renderOverview(
      [reason({ kind: 'update_check_uncertain', label: 'Update availability unknown' })],
      { canManageNode: true, updateChecksDisabled: false },
    );
    const checkAgain = screen.getByRole('button', { name: /check again/i });
    await user.click(checkAgain);
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledWith('/image-updates/refresh', { method: 'POST' });
    });
    expect(mockedFetch.mock.calls[0][1]).not.toMatchObject({ localOnly: true });
    expect(toast.success).toHaveBeenCalledWith('Image update check started in background.');
  });

  it('posts the target-local recheck alias on an inspect-v1 remote', async () => {
    const user = userEvent.setup();
    nodeState.activeNode = { id: 2, type: 'remote' };
    nodeState.activeNodeMeta = { capabilities: [REMOTE_IMAGE_INSPECT_V1_CAPABILITY] };
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, message: 'Image update check started in background.' }),
    });
    renderOverview(
      [reason({ kind: 'update_check_uncertain', label: 'Update availability unknown' })],
      { canManageNode: true, updateChecksDisabled: false },
    );
    await user.click(screen.getByRole('button', { name: /check again/i }));
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledWith('/image-updates/recheck-target', { method: 'POST' });
    });
    expect(mockedFetch).not.toHaveBeenCalledWith('/image-updates/refresh', { method: 'POST' });
    expect(toast.success).toHaveBeenCalledWith('Image update check started in background.');
  });

  it('keeps the hub refresh endpoint on a remote without inspect-v1', async () => {
    const user = userEvent.setup();
    nodeState.activeNode = { id: 2, type: 'remote' };
    nodeState.activeNodeMeta = { capabilities: [] };
    mockedFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ success: true, message: 'Image update check started in background.' }),
    });
    renderOverview(
      [reason({ kind: 'update_check_uncertain', label: 'Update availability unknown' })],
      { canManageNode: true, updateChecksDisabled: false },
    );
    await user.click(screen.getByRole('button', { name: /check again/i }));
    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledWith('/image-updates/refresh', { method: 'POST' });
    });
    expect(mockedFetch).not.toHaveBeenCalledWith('/image-updates/recheck-target', { method: 'POST' });
  });

  it('hides Check again without node:manage', () => {
    renderOverview(
      [reason({ kind: 'update_check_uncertain', label: 'Update availability unknown' })],
      { canManageNode: false },
    );
    expect(screen.queryByRole('button', { name: /check again/i })).toBeNull();
    expect(screen.getByRole('button', { name: /view findings/i })).toBeTruthy();
  });

  it('hides Check again when update checks are disabled', () => {
    renderOverview(
      [reason({ kind: 'update_check_uncertain', label: 'Update availability unknown' })],
      { canManageNode: true, updateChecksDisabled: true },
    );
    expect(screen.queryByRole('button', { name: /check again/i })).toBeNull();
  });

  it('surfaces 429 cooldown via toast.warning', async () => {
    const user = userEvent.setup();
    mockedFetch.mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({ error: 'Rate limited. Please wait at least 5 minutes between manual refreshes.' }),
    });
    renderOverview(
      [reason({ kind: 'update_check_uncertain', label: 'Update availability unknown' })],
      { canManageNode: true },
    );
    await user.click(screen.getByRole('button', { name: /check again/i }));
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith(expect.stringMatching(/rate limited/i));
    });
  });

  describe('refetch and dismissals', () => {
    const dismissable = (partial: Partial<PostureReason> = {}) => reason({
      kind: 'needs_review', label: 'Findings needing review', severity: 'review', targetTab: 'suppressions', actionLabel: undefined,
      key: 'needs_review:all', fingerprint: 'fp-1', dismissPolicy: 'any', ...partial,
    });

    it('refetches the overview after Check again', async () => {
      const user = userEvent.setup();
      mockedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ message: 'started' }) });
      const { reload } = renderOverview(
        [reason({ kind: 'update_check_uncertain', label: 'Update availability unknown' })],
        { canManageNode: true },
      );
      await user.click(screen.getByRole('button', { name: /check again/i }));
      await waitFor(() => expect(reload).toHaveBeenCalled());
    });

    it('dismisses a review reason in one click, sending what the operator saw', async () => {
      const user = userEvent.setup();
      renderOverview([dismissable()], { canManageNode: true });
      await user.click(screen.getByRole('button', { name: /^dismiss: findings needing review/i }));
      expect(dismissalState.dismiss).toHaveBeenCalledWith(
        { id: 'security:1:needs_review:all', fingerprint: 'fp-1', count: 2, severity: 'review' },
        'until_change',
        undefined,
      );
    });

    it('offers no Dismiss on a blocker, to an account that cannot manage the node, or for an older remote', () => {
      renderOverview([
        reason({ kind: 'secret', label: 'Detected secrets', severity: 'blocker', key: 'secret:all', fingerprint: 'f', dismissPolicy: 'none' }),
        dismissable({ kind: 'failed_scan', label: 'Failed scans', key: undefined, fingerprint: undefined, dismissPolicy: undefined }),
      ], { canManageNode: true });
      expect(screen.queryByRole('button', { name: /^dismiss:/i })).toBeNull();
      cleanup();
      renderOverview([dismissable()], { canManageNode: false });
      expect(screen.queryByRole('button', { name: /^dismiss:/i })).toBeNull();
    });

    it('moves a covered reason to the dismissed list and still counts it in the title', async () => {
      const user = userEvent.setup();
      dismissalState.dismissals = [{
        id: 7, nodeId: 1, surface: 'security', findingKey: 'security:1:needs_review:all', fingerprint: 'fp-1',
        severity: 'review', count: 2, mode: 'until_change', expiresAt: null, createdBy: 'alice', createdAt: Date.now(),
      }];
      renderOverview([dismissable()], { canManageNode: true });
      expect(screen.getByRole('heading', { name: /why monitoring/i })).toBeInTheDocument();
      expect(screen.getByText(/1 dismissed/i)).toBeInTheDocument();
      expect(screen.getByText(/dismissed by alice/i)).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /restore/i }));
      expect(dismissalState.restore).toHaveBeenCalledWith(7);
    });
  });
});
