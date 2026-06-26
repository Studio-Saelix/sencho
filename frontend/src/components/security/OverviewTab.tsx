import { ShieldOff } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { SignalRail, type SignalTile } from '@/components/ui/SignalRail';
import { cn } from '@/lib/utils';
import { formatTimeAgo } from '@/lib/relativeTime';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { SecuritySevStrip, SecurityTotalsGrid, SecurityFooterBand } from './SecurityMobile';
import type { SecurityOverview, SecurityRiskTrendPoint, ExploitIntelFinding, PostureReason } from '@/types/security';
import type { SecurityTab } from '@/lib/events';
import {
  RiskTrendChart,
  ActionPostureChart,
  TopExploitRiskList,
  CvssEpssQuadrantChart,
} from './SecurityCharts';
import { ScanNodeLauncher } from './ScanNodeLauncher';

interface OverviewTabProps {
  overview: SecurityOverview | null;
  /** 'unsupported' = node has no overview endpoint (benign); 'failed' = a real error. */
  loadError: 'unsupported' | 'failed' | null;
  trend: SecurityRiskTrendPoint[];
  /** Actionable Critical/High findings with KEV/EPSS for the exploit-intel charts. */
  exploitIntel: ExploitIntelFinding[];
  onNavigate: (tab: SecurityTab) => void;
  onInspect: (scanId: number) => void;
  /** Admin on a node with a ready scanner; enables the node-scan launcher. */
  canScan: boolean;
  /** Refresh the overview after a node-wide scan completes. */
  onScanComplete: () => void;
  /** Paid licensees can manage enforcement policies (the Policies tab is hidden otherwise). */
  isPaid: boolean;
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
    <div className={cn('rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel p-4', className)}>
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

function ReviewQueueCard({
  reasons,
  onNavigate,
}: {
  reasons: PostureReason[];
  onNavigate: (tab: SecurityTab) => void;
}) {
  const blockers = reasons.filter((r) => r.severity === 'blocker');
  const nonBlockers = reasons.filter((r) => r.severity !== 'blocker');
  const hasBlockers = blockers.length > 0;
  const title = hasBlockers ? 'Why Action needed' : 'Review queue';

  return (
    <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel p-4">
      <h3 className="font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle mb-3">{title}</h3>
      <div className="space-y-3">
        {blockers.map((r, i) => (
          <div key={`${r.kind}-${i}`} className="flex items-start gap-3">
            <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', SEVERITY_DOT[r.severity])} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className={cn('font-mono text-sm', SEVERITY_LABEL[r.severity])}>{r.label}</span>
                <span className="font-mono tabular-nums text-xs text-stat-subtitle">{r.count}</span>
                <button
                  type="button"
                  onClick={() => onNavigate(r.targetTab)}
                  className="text-xs font-medium text-brand hover:underline whitespace-nowrap ml-auto"
                >
                  Open {r.targetTab === 'compose' ? 'Compose risks' : r.targetTab === 'suppressions' ? 'Suppressions' : r.targetTab === 'secrets' ? 'Secrets' : r.targetTab === 'history' ? 'History' : r.targetTab === 'scanner' ? 'Scanner setup' : 'Images'} →
                </button>
              </div>
              <p className="text-xs text-stat-subtitle mt-0.5">{r.description}</p>
            </div>
          </div>
        ))}
        {nonBlockers.length > 0 && hasBlockers && (
          <div className="border-t border-hairline pt-3 mt-1" />
        )}
        {nonBlockers.map((r, i) => (
          <div key={`${r.kind}-${i}`} className="flex items-start gap-3">
            <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', SEVERITY_DOT[r.severity])} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className={cn('font-mono text-sm', SEVERITY_LABEL[r.severity])}>{r.label}</span>
                <span className="font-mono tabular-nums text-xs text-stat-subtitle">{r.count}</span>
              </div>
              <p className="text-xs text-stat-subtitle mt-0.5">{r.description}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function OverviewTab({ overview, loadError, trend, exploitIntel, onNavigate, onInspect, canScan, onScanComplete, isPaid }: OverviewTabProps) {
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
    { kicker: 'Fixable', value: String(overview.fixable), tone: overview.fixable > 0 ? 'warn' : 'value' },
    { kicker: 'Secrets', value: String(overview.secrets), tone: overview.secrets > 0 ? 'error' : 'value' },
    { kicker: 'Misconfigs', value: String(overview.misconfigs), tone: overview.misconfigs > 0 ? 'warn' : 'value' },
    { kicker: 'Stale', value: String(overview.staleScans), tone: overview.staleScans > 0 ? 'warn' : 'value' },
    { kicker: 'Failed', value: String(overview.failedScans), tone: overview.failedScans > 0 ? 'error' : 'value' },
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

      {/* items-start: each card keeps its natural height so the fixed-height chart
          card never stretches to a taller exploit table (which left dead space
          under the chart). The exploit-risk table owns its own card chrome. */}
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <TopExploitRiskList items={exploitIntel} onInspect={onInspect} />
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
            {isPaid ? 'Manage enforcement policies on the Policies tab. ' : ''}This is a read-only posture for the active node.
          </p>
        </div>
      </div>

      {isMobile && <SecurityFooterBand overview={overview} />}
    </div>
  );
}
