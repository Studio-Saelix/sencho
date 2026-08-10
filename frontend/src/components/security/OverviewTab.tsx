import { useState } from 'react';
import { ShieldOff } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { SignalRail, type SignalTile } from '@/components/ui/SignalRail';
import { cn } from '@/lib/utils';
import { formatTimeAgo } from '@/lib/relativeTime';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { toast } from '@/components/ui/toast-store';
import { SecuritySevStrip, SecurityTotalsGrid, SecurityFooterBand } from './SecurityMobile';
import type { SecurityOverview, SecurityRiskTrendPoint, ExploitIntelFinding, PostureReason } from '@/types/security';
import type { SecurityTab } from '@/lib/events';
import type { ImageFilterValue } from '@/lib/severityStyles';
import { reasonImageFilter, defaultReasonActionLabel } from './postureNavigation';
import { triggerNodeImageUpdateCheck } from './imageUpdateRecheck';
import { targetingFromTargets, type ImagesTargetingInput } from './imagesTargeting';
import {
  RiskTrendChart,
  ActionPostureChart,
  TopExploitRiskList,
  CvssEpssQuadrantChart,
} from './SecurityCharts';
import { ScanNodeLauncher } from './ScanNodeLauncher';

/** Navigate to a security tab, optionally with an Images severity filter and/or
 *  posture targeting (image refs). */
type NavigateFn = (
  tab: SecurityTab,
  filter?: ImageFilterValue,
  targeting?: ImagesTargetingInput,
) => void;

interface OverviewTabProps {
  overview: SecurityOverview | null;
  /** 'unsupported' = node has no overview endpoint (benign); 'failed' = a real error. */
  loadError: 'unsupported' | 'failed' | null;
  trend: SecurityRiskTrendPoint[];
  /** Actionable Critical/High findings with KEV/EPSS for the exploit-intel charts. */
  exploitIntel: ExploitIntelFinding[];
  /** True when the exploit-intel set hit its row cap (highest-risk shown, not all). */
  exploitTruncated: boolean;
  onNavigate: NavigateFn;
  onInspect: (scanId: number) => void;
  /** Admin on a node with a ready scanner; enables the node-scan launcher. */
  canScan: boolean;
  /** Refresh the overview after a node-wide scan completes. */
  onScanComplete: () => void;
  /** Whether the operator may trigger node-scoped image-update refresh. */
  canManageNode?: boolean;
}

const STATUS_ROW_TONE: Record<'value' | 'warn' | 'subtitle', string> = {
  value: 'text-stat-value',
  warn: 'text-warning',
  subtitle: 'text-stat-subtitle',
};

function StatusRow({ label, value, tone }: { label: string; value: string; tone?: 'value' | 'warn' | 'subtitle' }) {
  const toneClass = STATUS_ROW_TONE[tone ?? 'value'];
  return (
    <div className="flex items-center justify-between gap-4 py-[var(--density-cell-y)]">
      <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle">{label}</span>
      <span className={`font-mono tabular-nums text-sm ${toneClass}`}>{value}</span>
    </div>
  );
}

function ChartCard({ title, className, children }: { title: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn('rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel p-4 h-full', className)}>
      <h3 className="font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle mb-3">{title}</h3>
      {children}
    </div>
  );
}

const SEVERITY_DOT: Record<PostureReason['severity'], string> = {
  blocker: 'bg-destructive',
  review: 'bg-warning',
  info: 'bg-stat-subtitle',
};

const SEVERITY_LABEL: Record<PostureReason['severity'], string> = {
  blocker: 'text-destructive',
  review: 'text-warning',
  info: 'text-stat-subtitle',
};

function reasonNavLabel(r: PostureReason): string {
  return `${r.actionLabel ?? defaultReasonActionLabel(r.targetTab)} →`;
}

function navigateReason(onNavigate: NavigateFn, reason: PostureReason): void {
  const targeting = targetingFromTargets(reason.kind, reason.label, reason.targets);
  // Prefer precise targets; severity filter is only the older-node fallback.
  const filter = targeting ? undefined : reasonImageFilter(reason.kind);
  onNavigate(reason.targetTab, filter, targeting);
}

function ReasonRow({
  reason,
  onNavigate,
  showCheckAgain = false,
  checkAgainBusy = false,
  onCheckAgain,
}: {
  reason: PostureReason;
  onNavigate: NavigateFn;
  showCheckAgain?: boolean;
  checkAgainBusy?: boolean;
  onCheckAgain?: () => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', SEVERITY_DOT[reason.severity])} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn('font-mono text-sm', SEVERITY_LABEL[reason.severity])}>{reason.label}</span>
          <span className="font-mono tabular-nums text-xs text-stat-subtitle">{reason.count}</span>
          <div className="ml-auto flex items-center gap-3">
            {showCheckAgain && onCheckAgain ? (
              <button
                type="button"
                disabled={checkAgainBusy}
                onClick={onCheckAgain}
                className="text-xs font-medium text-brand hover:underline whitespace-nowrap disabled:opacity-50"
              >
                {checkAgainBusy ? 'Starting…' : 'Check again'}
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => navigateReason(onNavigate, reason)}
              className="text-xs font-medium text-brand hover:underline whitespace-nowrap"
            >
              {reasonNavLabel(reason)}
            </button>
          </div>
        </div>
        <p className="text-xs text-stat-subtitle mt-0.5">{reason.description}</p>
      </div>
    </div>
  );
}

function ReviewQueueCard({
  reasons,
  onNavigate,
  canManageNode,
  updateChecksDisabled,
}: {
  reasons: PostureReason[];
  onNavigate: NavigateFn;
  canManageNode: boolean;
  updateChecksDisabled: boolean;
}) {
  const [checkAgainBusy, setCheckAgainBusy] = useState(false);
  const blockers = reasons.filter((r) => r.severity === 'blocker');
  const nonBlockers = reasons.filter((r) => r.severity !== 'blocker');
  const hasBlockers = blockers.length > 0;
  const title = hasBlockers ? 'Why Action needed' : 'Review queue';

  const handleCheckAgain = async () => {
    if (checkAgainBusy) return;
    setCheckAgainBusy(true);
    try {
      await triggerNodeImageUpdateCheck();
    } catch (err) {
      toast.error((err as Error)?.message || 'Failed to start image update check');
    } finally {
      setCheckAgainBusy(false);
    }
  };

  const showCheckAgainFor = (r: PostureReason): boolean =>
    r.kind === 'update_check_uncertain' && canManageNode && !updateChecksDisabled;

  return (
    <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel p-4">
      <h3 className="font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle mb-3">{title}</h3>
      <div className="space-y-3">
        {blockers.map((r, i) => (
          <ReasonRow key={`${r.kind}-${i}`} reason={r} onNavigate={onNavigate} />
        ))}
        {nonBlockers.length > 0 && hasBlockers && (
          <div className="border-t border-hairline pt-3 mt-1" />
        )}
        {nonBlockers.map((r, i) => (
          <ReasonRow
            key={`${r.kind}-${i}`}
            reason={r}
            onNavigate={onNavigate}
            showCheckAgain={showCheckAgainFor(r)}
            checkAgainBusy={checkAgainBusy}
            onCheckAgain={handleCheckAgain}
          />
        ))}
      </div>
    </div>
  );
}

export function OverviewTab({
  overview,
  loadError,
  trend,
  exploitIntel,
  exploitTruncated,
  onNavigate,
  onInspect,
  canScan,
  onScanComplete,
  canManageNode = false,
}: OverviewTabProps) {
  const isMobile = useIsMobile();

  if (loadError === 'unsupported') {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <ShieldOff className="w-12 h-12 text-muted-foreground/50 mb-4" strokeWidth={1.5} />
        <h3 className="text-lg font-medium mb-1">Overview unavailable on this node</h3>
        <p className="text-sm text-muted-foreground">
          This node does not report a security overview. Browse images, history, and scanner setup directly.
        </p>
      </div>
    );
  }

  if (loadError === 'failed') {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <ShieldOff className="w-12 h-12 text-warning/60 mb-4" strokeWidth={1.5} />
        <h3 className="text-lg font-medium mb-1">Couldn't load the overview</h3>
        <p className="text-sm text-muted-foreground">
          The security overview failed to load for this node. Switch nodes and back, or try again shortly.
        </p>
      </div>
    );
  }

  if (!overview) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-56 w-full rounded-lg" />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }

  const tiles: SignalTile[] = [
    { kicker: 'Scanned images', value: String(overview.scannedImages) },
    {
      kicker: 'Fixable', value: String(overview.fixable), tone: overview.fixable > 0 ? 'warn' : 'value',
      onClick: overview.fixable > 0 ? () => onNavigate('images', 'FIXABLE') : undefined,
    },
    {
      kicker: 'Secrets', value: String(overview.secrets), tone: overview.secrets > 0 ? 'error' : 'value',
      onClick: overview.secrets > 0 ? () => onNavigate('secrets') : undefined,
    },
    {
      kicker: 'Misconfigs', value: String(overview.misconfigs), tone: overview.misconfigs > 0 ? 'warn' : 'value',
      onClick: overview.misconfigs > 0 ? () => onNavigate('compose') : undefined,
    },
    {
      kicker: 'Stale', value: String(overview.staleScans), tone: overview.staleScans > 0 ? 'warn' : 'value',
      onClick: overview.staleScans > 0 ? () => onNavigate('history') : undefined,
    },
    {
      kicker: 'Failed', value: String(overview.failedScans), tone: overview.failedScans > 0 ? 'error' : 'value',
      onClick: overview.failedScans > 0 ? () => onNavigate('history') : undefined,
    },
  ];

  const scannerValue = overview.scanner.available
    ? `${overview.scanner.source}${overview.scanner.version ? ` · v${overview.scanner.version}` : ''}`
    : 'not installed';

  return (
    <div className="space-y-6">
      {canScan && (
        isMobile ? (
          <ScanNodeLauncher canScan={canScan} onComplete={onScanComplete} fullWidth />
        ) : (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-stat-subtitle">
              {overview.scannedImages === 0
                ? 'No images scanned on this node yet.'
                : `${overview.scannedImages} image${overview.scannedImages === 1 ? '' : 's'} scanned.`}
            </p>
            <ScanNodeLauncher canScan={canScan} onComplete={onScanComplete} />
          </div>
        )
      )}

      {/* The masthead hides its stat cluster on a phone; restate it here. The
          scanner-detections note lives in the masthead's info affordance. */}
      {isMobile && <SecuritySevStrip overview={overview} />}

      {/* Review queue: surfaces the "why" behind the posture -- blocker reasons
          with CTAs, plus review/info items even when the masthead is not red. */}
      {overview.posture && overview.posture !== 'Unknown' && overview.postureReasons && overview.postureReasons.length > 0 && (
        <ReviewQueueCard
          reasons={overview.postureReasons}
          onNavigate={onNavigate}
          canManageNode={canManageNode}
          updateChecksDisabled={overview.updateChecksDisabled === true}
        />
      )}

      {/* Charts lead the dashboard: the trend gives severity context, the rest
          answer "what should I act on first?" from posture + exploit intel. */}
      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard title="Risk trend · 30 days · critical + high" className="lg:col-span-2">
          <RiskTrendChart trend={trend} />
        </ChartCard>
        <ChartCard title="Action posture">
          <ActionPostureChart overview={overview} />
        </ChartCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <TopExploitRiskList items={exploitIntel} truncated={exploitTruncated} onInspect={onInspect} />
        <ChartCard title="Severity × exploitability">
          <CvssEpssQuadrantChart items={exploitIntel} />
        </ChartCard>
      </div>

      {/* Supporting counts + posture, secondary to the charts above. */}
      {isMobile ? (
        <SecurityTotalsGrid overview={overview} />
      ) : (
        <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel overflow-hidden">
          <div className="min-w-[640px]">
            <SignalRail tiles={tiles} className="border-b-0" />
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel p-4">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle mb-2">Scanner</h3>
          <StatusRow label="Status" value={scannerValue} tone={overview.scanner.available ? 'value' : 'warn'} />
          {overview.scanner.source === 'managed' && (
            <StatusRow label="Auto-update" value={overview.scanner.autoUpdate ? 'on' : 'off'} tone="subtitle" />
          )}
          <StatusRow
            label="Last scan"
            value={overview.lastSuccessfulScanAt ? formatTimeAgo(overview.lastSuccessfulScanAt) : 'never'}
            tone="subtitle"
          />
          {!overview.scanner.available && (
            <button
              type="button"
              onClick={() => onNavigate('scanner')}
              className="mt-2 text-xs text-brand hover:underline"
            >
              Set up the scanner
            </button>
          )}
        </div>

        <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel p-4">
          <h3 className="font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle mb-2">Deploy enforcement</h3>
          <StatusRow
            label="Block policies"
            value={String(overview.deployEnforcement.eligibleBlockPolicies)}
            tone={overview.deployEnforcement.eligibleBlockPolicies > 0 ? 'value' : 'subtitle'}
          />
          <StatusRow
            label="Honor suppressions"
            value={overview.deployEnforcement.honorSuppressionsOnDeploy ? 'on' : 'off'}
            tone="subtitle"
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Manage enforcement policies on the Policies tab. This is a read-only posture for the active node.
          </p>
        </div>
      </div>

      {isMobile && <SecurityFooterBand overview={overview} />}
    </div>
  );
}
