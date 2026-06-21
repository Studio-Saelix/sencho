import { useEffect, useState } from 'react';
import {
  Check, TriangleAlert, CircleSlash, WifiOff, RefreshCw,
  FileClock, FileCheck2, FileQuestion, type LucideIcon,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast-store';
import { formatTimeAgo } from '@/lib/relativeTime';
import { useNodes } from '@/context/NodeContext';

// Mirrors the backend payload shape (the frontend never imports backend).
type StackDriftStatus = 'in-sync' | 'drifted' | 'missing-runtime' | 'unreachable';
type DriftFindingKind =
  | 'service-missing' | 'service-undeclared' | 'image-mismatch' | 'ports-mismatch'
  | 'network-undeclared' | 'network-missing';

interface StackDriftFinding {
  kind: DriftFindingKind;
  service: string;
  detail: string;
  expected?: string;
  actual?: string;
}

interface DriftTemporal {
  hasBaseline: boolean;
  sourceChanged: boolean;
  renderedChanged: boolean;
}

interface DriftLedgerEntry {
  service: string;
  kind: DriftFindingKind;
  message: string;
  detectedAt: number;
  resolvedAt: number | null;
}

interface StackDriftReport {
  stack: string;
  status: StackDriftStatus;
  hasComposeFile: boolean;
  hasContainers: boolean;
  findings: StackDriftFinding[];
  parseError?: string;
  // Optional so a report from an older remote node (no ledger layer) still renders.
  temporal?: DriftTemporal;
  ledger?: DriftLedgerEntry[];
  // When the ledger was last reconciled (re-check, deploy, or background scan); null
  // if never. The history is "as of" this time, not the live status above it.
  lastCheckedAt?: number | null;
}

const LABEL_CLASS = 'font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle';
const ACTION_CLASS =
  'inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-stat-subtitle hover:text-brand transition-colors disabled:opacity-40';
const CARD_CLASS = 'rounded-lg border px-3 py-2.5';

const STATUS_META: Record<StackDriftStatus, { label: string; icon: LucideIcon; tone: string; line: string }> = {
  'in-sync': {
    label: 'in sync',
    icon: Check,
    tone: 'border-success/40 bg-success/[0.06] text-success',
    line: 'Runtime matches the compose file.',
  },
  drifted: {
    label: 'drifted',
    icon: TriangleAlert,
    tone: 'border-warning/40 bg-warning/[0.06] text-warning',
    line: 'Runtime differs from the compose file.',
  },
  'missing-runtime': {
    label: 'not running',
    icon: CircleSlash,
    tone: 'border-muted bg-card/40 text-stat-subtitle',
    line: 'Defined on disk but no containers are running.',
  },
  unreachable: {
    label: 'unreachable',
    icon: WifiOff,
    tone: 'border-destructive/40 bg-destructive/[0.06] text-destructive',
    line: 'Docker is unreachable, so drift cannot be assessed.',
  },
};

const FINDING_LABEL: Record<DriftFindingKind, string> = {
  'service-missing': 'service missing',
  'service-undeclared': 'undeclared',
  'image-mismatch': 'image',
  'ports-mismatch': 'ports',
  'network-undeclared': 'network',
  'network-missing': 'network missing',
};

/** The temporal overlay: how the on-disk compose compares to the last deploy baseline. */
function temporalMeta(temporal: DriftTemporal): { label: string; icon: LucideIcon; tone: string; line: string; key: string } {
  if (!temporal.hasBaseline) {
    return {
      key: 'no-baseline',
      label: 'no deploy baseline',
      icon: FileQuestion,
      tone: 'border-muted bg-card/40 text-stat-subtitle',
      line: 'Deploy through Sencho to start tracking changes since deploy.',
    };
  }
  if (temporal.sourceChanged) {
    return {
      key: 'source-changed',
      label: 'source changed',
      icon: FileClock,
      tone: 'border-warning/40 bg-warning/[0.06] text-warning',
      line: temporal.renderedChanged
        ? 'The compose model changed since the last deploy.'
        : 'The compose file changed since the last deploy (formatting only).',
    };
  }
  return {
    key: 'matches',
    label: 'matches last deploy',
    icon: FileCheck2,
    tone: 'border-success/40 bg-success/[0.06] text-success',
    line: 'The compose source is unchanged since the last deploy.',
  };
}

function Finding({ finding }: { finding: StackDriftFinding }) {
  return (
    <div className="border-t border-muted py-2 first:border-t-0">
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-brand/15 px-1.5 py-0.5 font-mono text-[11px] text-brand">{finding.service}</span>
        <span className="font-mono text-[10px] uppercase tracking-wide text-stat-subtitle">{FINDING_LABEL[finding.kind]}</span>
      </div>
      <div className="mt-1 text-[12px] text-foreground/90">{finding.detail}</div>
      {finding.expected !== undefined && finding.actual !== undefined && (
        <div className="mt-1 flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
          <span className="text-stat-subtitle">compose</span>
          <span className="text-foreground/90">{finding.expected}</span>
          <span className="text-stat-subtitle">→ running</span>
          <span className="font-semibold text-foreground">{finding.actual}</span>
        </div>
      )}
    </div>
  );
}

function LedgerRow({ entry }: { entry: DriftLedgerEntry }) {
  const resolved = entry.resolvedAt != null;
  return (
    <div className="border-t border-muted py-2 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md bg-brand/15 px-1.5 py-0.5 font-mono text-[11px] text-brand">{entry.service}</span>
        <span className="font-mono text-[10px] uppercase tracking-wide text-stat-subtitle">{FINDING_LABEL[entry.kind] ?? entry.kind}</span>
        <span className={cn('font-mono text-[10px] uppercase tracking-wide', resolved ? 'text-success' : 'text-warning')}>
          {resolved ? 'resolved' : 'open'}
        </span>
      </div>
      <div className="mt-1 text-[12px] text-foreground/90">{entry.message}</div>
      <div className="mt-1 font-mono text-[10px] text-stat-subtitle">
        detected {formatTimeAgo(entry.detectedAt)}
        {entry.resolvedAt != null ? ` · resolved ${formatTimeAgo(entry.resolvedAt)}` : ''}
      </div>
    </div>
  );
}

export default function DriftPanel({ stackName }: { stackName: string }) {
  const { activeNode } = useNodes();
  const nodeId = activeNode?.id;
  const [report, setReport] = useState<StackDriftReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [rechecking, setRechecking] = useState(false);

  // Passive load when the stack OR active node changes (the same stack can exist on
  // two nodes), and on an explicit retry. Read-only: it never writes the ledger, so
  // opening the tab has no side effects. A failed load shows a distinct retry state
  // rather than a stale or blank report.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setLoadError(false);
      try {
        const res = await apiFetch(`/stacks/${stackName}/drift`);
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(true);
          toast.error('Failed to load the drift report.');
          return;
        }
        setReport((await res.json()) as StackDriftReport);
        setLoadError(false);
      } catch {
        if (!cancelled) {
          setLoadError(true);
          toast.error('Failed to load the drift report.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [stackName, nodeId, reloadKey]);

  // Re-check reconciles the ledger server-side (recording newly detected / resolved
  // findings) and returns the fresh payload, so the history reflects this check.
  const recheck = async () => {
    setRechecking(true);
    try {
      const res = await apiFetch(`/stacks/${stackName}/drift/recheck`, { method: 'POST' });
      if (!res.ok) {
        toast.error('Failed to re-check drift.');
        return;
      }
      setReport((await res.json()) as StackDriftReport);
      setLoadError(false);
    } catch {
      toast.error('Failed to re-check drift.');
    } finally {
      setRechecking(false);
    }
  };

  const meta = report ? STATUS_META[report.status] : null;
  const StatusIcon = meta?.icon;
  // Only render the temporal card when the payload actually carries it. A report
  // proxied from an older node without the ledger layer omits it; showing "no deploy
  // baseline" there would be misleading, so the card is left out entirely.
  const temporal = report?.temporal ? temporalMeta(report.temporal) : null;
  const TemporalIcon = temporal?.icon;
  const ledger = report?.ledger ?? [];
  // The ledger only moves on a reconcile (re-check, deploy, or background scan), so
  // label the history with when that last happened: a "resolved"/"open" row then
  // reads as the state at that check, not a claim about the live status above it.
  const lastChecked = report?.lastCheckedAt != null ? formatTimeAgo(report.lastCheckedAt) : null;
  const busy = loading || rechecking;

  return (
    <div data-testid="drift-panel" className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className={LABEL_CLASS}>compose vs runtime</span>
        <button
          type="button"
          data-testid="drift-recheck-btn"
          onClick={recheck}
          disabled={busy}
          className={ACTION_CLASS}
        >
          <RefreshCw className={cn('h-3 w-3', busy && 'animate-spin')} strokeWidth={1.5} /> re-check
        </button>
      </div>

      {loadError ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/[0.06] px-3 py-3">
          <span className="font-mono text-[11px] text-destructive">Could not load the drift report.</span>
          <button
            type="button"
            data-testid="drift-retry-btn"
            onClick={() => setReloadKey(k => k + 1)}
            className="font-mono text-[10px] uppercase tracking-wide text-destructive hover:underline"
          >
            retry
          </button>
        </div>
      ) : !report ? (
        <div className="py-3 font-mono text-[11px] text-stat-subtitle">Checking drift…</div>
      ) : (
        <>
          {meta && StatusIcon && (
            <div data-testid="drift-status" data-status={report.status} className={cn(CARD_CLASS, meta.tone)}>
              <div className="flex items-center gap-2">
                <StatusIcon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                <span className="font-mono text-[11px] uppercase tracking-wide">{meta.label}</span>
                {report.findings.length > 0 && (
                  <span className="font-mono text-[10px] text-stat-subtitle">
                    · {report.findings.length} finding{report.findings.length === 1 ? '' : 's'}
                  </span>
                )}
              </div>
              <div className="mt-1 font-mono text-[11px] leading-relaxed text-foreground/80">{meta.line}</div>
            </div>
          )}

          {temporal && TemporalIcon && (
            <div data-testid="drift-temporal" data-temporal={temporal.key} className={cn(CARD_CLASS, temporal.tone)}>
              <div className="flex items-center gap-2">
                <TemporalIcon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                <span className="font-mono text-[11px] uppercase tracking-wide">{temporal.label}</span>
              </div>
              <div className="mt-1 font-mono text-[11px] leading-relaxed text-foreground/80">{temporal.line}</div>
            </div>
          )}

          {report.parseError && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/[0.06] px-3 py-2 font-mono text-[11px] text-destructive">
              {report.parseError}
            </div>
          )}

          {report.findings.length > 0 && (
            <section>
              <div className={cn(LABEL_CLASS, 'mb-1.5')}>findings</div>
              <div className="rounded-lg border border-muted bg-card/40 px-3 py-1">
                {report.findings.map((f, i) => (
                  <Finding key={`${f.service}-${f.kind}-${i}`} finding={f} />
                ))}
              </div>
            </section>
          )}

          {ledger.length > 0 && (
            <section>
              <div className={cn(LABEL_CLASS, 'mb-1.5 flex items-center gap-1.5')}>
                <span>drift history</span>
                {lastChecked && (
                  <span className="tracking-normal normal-case text-stat-subtitle/70">· checked {lastChecked}</span>
                )}
              </div>
              <div className="rounded-lg border border-muted bg-card/40 px-3 py-1">
                {ledger.map((e, i) => (
                  <LedgerRow key={`${e.service}-${e.kind}-${e.detectedAt}-${i}`} entry={e} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
