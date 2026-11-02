import { RefreshCw, ShieldOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SignalRail, type SignalTile } from '@/components/ui/SignalRail';
import { cn } from '@/lib/utils';
import { formatTimeAgo } from '@/lib/relativeTime';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { DismissedSection } from '@/components/ui/dismissed-section';
import { SecuritySevStrip, SecurityTotalsGrid, SecurityFooterBand } from './SecurityMobile';
import type { SecurityOverview, SecurityRiskTrendPoint, ExploitIntelFinding, PostureReason } from '@/types/security';
import type { SecurityTab } from '@/lib/events';
import type { ImageFilterValue } from '@/lib/severityStyles';
import type { ImagesTargetingInput } from './imagesTargeting';
import { SecurityReasonActions } from './SecurityReasonActions';
import type { SecurityReasons } from './useSecurityReasons';
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

/** Loading ownership of a secondary chart region: a chart still in flight is
 *  not an empty chart, and a failed read is not "no history yet". */
export type ChartLoadState = 'loading' | 'ready' | 'unavailable';

/**
 * Why the overview is not on screen. Every cause the gateway established gets
 * its own kind, so a disconnected Pilot or an unconfigured node is never
 * described as a node that did not answer.
 */
export type OverviewLoadError =
  | 'unsupported'
  | 'timeout'
  | 'unreachable'
  | 'unauthorized'
  | 'node-credential'
  | 'unverified'
  | 'not-configured'
  | 'pilot-disconnected'
  | 'refused'
  | 'failed';

interface OverviewTabProps {
  overview: SecurityOverview | null;
  /**
   * 'unsupported' = node has no overview endpoint (benign); 'timeout' = the node
   * missed its read deadline and may answer on a retry; 'unreachable' = no
   * answer at all; 'unauthorized' = the operator's grants, not the node;
   * 'pilot-disconnected' / 'not-configured' / 'refused' = the hub has no
   * readable path to the node; 'node-credential' = the hub's stored token for
   * the node was rejected; 'unverified' = the node answered but its permissions
   * could not be verified; 'failed' = a real error.
   */
  loadError: OverviewLoadError | null;
  /** Reload every Security read (overview, scan summaries, risk trend, exploit intel). */
  onReload: () => void;
  trend: SecurityRiskTrendPoint[];
  /** Where the risk-trend read stands; independent of the overview read. */
  trendState: ChartLoadState;
  /** Actionable Critical/High findings with KEV/EPSS for the exploit-intel charts. */
  exploitIntel: ExploitIntelFinding[];
  /** Where the exploit-intel read stands; independent of the overview read. */
  exploitIntelState: ChartLoadState;
  /** True when the exploit-intel set hit its row cap (highest-risk shown, not all). */
  exploitTruncated: boolean;
  onNavigate: NavigateFn;
  onInspect: (scanId: number) => void;
  /** Admin on a node with a ready scanner; enables the node-scan launcher. */
  canScan: boolean;
  /** Refresh the overview after a node-wide scan completes. */
  onScanComplete: () => void;
  /** Verbs, dismissals, and the single handler that runs them for the review queue. */
  reasons: SecurityReasons;
}

/**
 * Why the overview is not on screen. Each kind keeps its own cause, because
 * "the node did not answer", "the node is unreachable", and "you cannot read
 * this here" send the operator to different places.
 */
const UNAVAILABLE_COPY: Record<Exclude<OverviewLoadError, 'unsupported'>, {
  title: string;
  body: string;
}> = {
  timeout: {
    title: 'This node did not answer',
    body: 'The security overview did not arrive in time, so nothing is shown rather than an empty result.',
  },
  unreachable: {
    title: 'This node is unreachable',
    body: 'The security overview could not be read because the node is not answering. Check that Sencho is running on that host.',
  },
  unauthorized: {
    title: 'No access to this overview',
    body: 'Your account cannot read the security overview on this node. Ask an administrator for access.',
  },
  'node-credential': {
    title: 'This node rejected the hub credential',
    body: "The stored API token for this node was rejected. Update the node's token in Settings → Nodes.",
  },
  unverified: {
    title: 'Permissions could not be verified',
    body: "This node's permission model could not be verified. Try again once the node is healthy.",
  },
  'pilot-disconnected': {
    title: 'The Pilot tunnel is disconnected',
    body: 'The Pilot tunnel to this node is disconnected. It resumes when the agent reconnects.',
  },
  'not-configured': {
    title: 'This node has no target configured',
    body: 'This node has no API URL or token configured. Update it in Settings → Nodes.',
  },
  refused: {
    title: 'The hub refused this node’s address',
    body: "The hub refused this node's address. Check the node's API URL.",
  },
  failed: {
    title: "Couldn't load the overview",
    body: 'The security overview failed to load for this node. Try again shortly.',
  },
};

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

function ReasonRow({ reason, reasons }: { reason: PostureReason; reasons: SecurityReasons }) {
  return (
    <div className="flex items-start gap-3">
      <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', SEVERITY_DOT[reason.severity])} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn('font-mono text-sm', SEVERITY_LABEL[reason.severity])}>{reason.label}</span>
          <span className="font-mono tabular-nums text-xs text-stat-subtitle">{reason.count}</span>
          <div className="ml-auto flex items-center gap-1 max-md:w-full max-md:justify-end">
            <SecurityReasonActions reason={reason} verb={reasons.verbFor(reason)} controls={reasons.controls} />
          </div>
        </div>
        <p className="text-xs text-stat-subtitle mt-0.5">{reason.description}</p>
      </div>
    </div>
  );
}

/** Placeholder that distinguishes a chart still loading from one whose read failed. */
function ChartPending({ state, noun }: { state: ChartLoadState; noun: string }) {
  if (state === 'loading') {
    return <Skeleton className="h-[220px] w-full rounded-md" />;
  }
  if (state === 'unavailable') {
    return (
      <p className="flex h-[220px] items-center justify-center text-sm text-stat-subtitle">
        {noun} unavailable right now.
      </p>
    );
  }
  return null;
}

function ReviewQueueCard({
  allReasons,
  reasons,
  posture,
}: {
  allReasons: PostureReason[];
  reasons: SecurityReasons;
  posture?: SecurityOverview['posture'];
}) {
  // The title follows the posture word, so it reads every reason; the list shows the active ones.
  const hasBlockers = allReasons.some((r) => r.severity === 'blocker');
  const blockers = reasons.active.filter((r) => r.severity === 'blocker');
  const nonBlockers = reasons.active.filter((r) => r.severity !== 'blocker');
  const title = hasBlockers
    ? 'Why Action needed'
    : posture === 'Monitoring'
      ? 'Why Monitoring'
      : 'Review queue';

  return (
    <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel p-4">
      <h3 className="font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle mb-3">{title}</h3>
      <div className="space-y-3">
        {blockers.map((r, i) => (
          <ReasonRow key={`${r.kind}-${i}`} reason={r} reasons={reasons} />
        ))}
        {nonBlockers.length > 0 && hasBlockers && (
          <div className="border-t border-hairline pt-3 mt-1" />
        )}
        {nonBlockers.map((r, i) => (
          <ReasonRow key={`${r.kind}-${r.key ?? i}`} reason={r} reasons={reasons} />
        ))}
        {reasons.active.length === 0 && reasons.dismissedItems.length > 0 && (
          <p className="text-sm text-muted-foreground">Nothing needs attention right now.</p>
        )}
      </div>
      {reasons.dismissedItems.length > 0 && (
        <div className="mt-3">
          <DismissedSection items={reasons.dismissedItems} forceOpen={reasons.active.length === 0} />
        </div>
      )}
    </div>
  );
}

export function OverviewTab({
  overview,
  loadError,
  trend,
  trendState,
  exploitIntel,
  exploitIntelState,
  exploitTruncated,
  onNavigate,
  onInspect,
  canScan,
  onScanComplete,
  onReload,
  reasons,
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

  if (loadError !== null) {
    // 'unsupported' returned above, so this is a cause the hub established
    // about the node, an authorization failure, or a real error.
    const copy = UNAVAILABLE_COPY[loadError];

    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <ShieldOff className="w-12 h-12 text-warning/60 mb-4" strokeWidth={1.5} />
        <h3 className="text-lg font-medium mb-1">{copy.title}</h3>
        <p className="mb-4 text-sm text-muted-foreground">{copy.body}</p>
        <Button variant="outline" size="sm" onClick={onReload}>
          <RefreshCw className="mr-1.5 h-4 w-4" />
          Retry
        </Button>
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
        <ReviewQueueCard allReasons={overview.postureReasons} reasons={reasons} posture={overview.posture} />
      )}

      {/* Charts lead the dashboard: the trend gives severity context, the rest
          answer "what should I act on first?" from posture + exploit intel. */}
      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard title="Risk trend · 30 days · critical + high" className="lg:col-span-2">
          {trendState === 'ready' ? <RiskTrendChart trend={trend} /> : <ChartPending state={trendState} noun="Risk trend" />}
        </ChartCard>
        <ChartCard title="Action posture">
          <ActionPostureChart overview={overview} />
        </ChartCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {exploitIntelState === 'ready' ? (
          <TopExploitRiskList items={exploitIntel} truncated={exploitTruncated} onInspect={onInspect} />
        ) : (
          <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel p-4 h-full">
            <ChartPending state={exploitIntelState} noun="Exploit intelligence" />
          </div>
        )}
        <ChartCard title="Severity × exploitability">
          {exploitIntelState === 'ready' ? <CvssEpssQuadrantChart items={exploitIntel} /> : <ChartPending state={exploitIntelState} noun="Exploit intelligence" />}
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
            Security posture describes current operational actionability. Explicit deploy policies may enforce stricter admission rules (package fix available ≠ confirmed image update). Manage enforcement policies on the Policies tab. This is a read-only posture for the active node.
          </p>
        </div>
      </div>

      {isMobile && <SecurityFooterBand overview={overview} />}
    </div>
  );
}
