/**
 * OverviewTab review-queue affordances for remediation-aware posture:
 * non-blocker View findings, Check again gating, and node-scoped refresh.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SecurityOverview, PostureReason } from '@/types/security';

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
import { toast } from '@/components/ui/toast-store';
import { OverviewTab } from '../OverviewTab';
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

function renderOverview(
  reasons: PostureReason[],
  opts: {
    canManageNode?: boolean;
    updateChecksDisabled?: boolean;
    onNavigate?: OverviewNavigate;
  } = {},
) {
  const onNavigate: OverviewNavigate = opts.onNavigate ?? vi.fn();
  render(
    <OverviewTab
      overview={overview(reasons, { updateChecksDisabled: opts.updateChecksDisabled })}
      loadError={null}
      trend={[]}
      exploitIntel={[]}
      exploitTruncated={false}
      onNavigate={onNavigate}
      onInspect={vi.fn()}
      canScan={false}
      onScanComplete={vi.fn()}
      canManageNode={opts.canManageNode ?? false}
    />,
  );
  return { onNavigate };
}

describe('OverviewTab remediation affordances', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
        label: 'Publicly exposed affected images',
        severity: 'blocker',
        targets: [{ imageRef: 'exp:1' }, { imageRef: 'exp:2' }],
      }),
    ]);
    await user.click(screen.getByRole('button', { name: /view findings/i }));
    expect(onNavigate).toHaveBeenCalledWith('images', undefined, {
      kind: 'public_exposure',
      label: 'Publicly exposed affected images',
      imageRefs: ['exp:1', 'exp:2'],
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
});
