import { ShieldOff } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { SignalRail, type SignalTile } from '@/components/ui/SignalRail';
import { cn } from '@/lib/utils';
import { formatTimeAgo } from '@/lib/relativeTime';
import type { SecurityOverview, ScanSummary, SecurityRiskTrendPoint } from '@/types/security';
import type { SecurityTab } from '@/lib/events';
import {
  SeverityDonutChart,
  RiskTrendChart,
  TopExposedImagesChart,
  FindingsByTypeChart,
} from './SecurityCharts';
import { ScanNodeLauncher } from './ScanNodeLauncher';

interface OverviewTabProps {
  overview: SecurityOverview | null;
  /** 'unsupported' = node has no overview endpoint (benign); 'failed' = a real error. */
  loadError: 'unsupported' | 'failed' | null;
  summaries: Record<string, ScanSummary>;
  trend: SecurityRiskTrendPoint[];
  onNavigate: (tab: SecurityTab) => void;
  onInspect: (scanId: number) => void;
  /** Admin on a node with a ready scanner; enables the node-scan launcher. */
  canScan: boolean;
  /** Refresh the overview after a node-wide scan completes. */
  onScanComplete: () => void;
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

export function OverviewTab({ overview, loadError, summaries, trend, onNavigate, onInspect, canScan, onScanComplete }: OverviewTabProps) {
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

  const summaryList = Object.values(summaries);

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
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-stat-subtitle">
            {overview.scannedImages === 0
              ? 'No images scanned on this node yet.'
              : `${overview.scannedImages} image${overview.scannedImages === 1 ? '' : 's'} scanned.`}
          </p>
          <ScanNodeLauncher canScan={canScan} onComplete={onScanComplete} />
        </div>
      )}

      {/* Charts lead the dashboard. */}
      <div className="grid gap-4 lg:grid-cols-3">
        <ChartCard title="Risk trend · 30 days · critical + high" className="lg:col-span-2">
          <RiskTrendChart trend={trend} />
        </ChartCard>
        <ChartCard title="Severity distribution">
          <SeverityDonutChart summaries={summaryList} />
        </ChartCard>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <ChartCard title="Top exposed images">
          <TopExposedImagesChart summaries={summaryList} onInspect={onInspect} />
        </ChartCard>
        <ChartCard title="Findings by type">
          <FindingsByTypeChart summaries={summaryList} />
        </ChartCard>
      </div>

      {/* Supporting counts + posture, secondary to the charts above. */}
      <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel overflow-hidden max-md:overflow-x-auto">
        <div className="min-w-[640px]">
          <SignalRail tiles={tiles} className="border-b-0" />
        </div>
      </div>

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
    </div>
  );
}
