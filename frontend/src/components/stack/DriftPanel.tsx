import { useEffect, useState } from 'react';
import { Check, TriangleAlert, CircleSlash, WifiOff, RefreshCw, type LucideIcon } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast-store';
import { useNodes } from '@/context/NodeContext';

// Mirrors the backend StackDriftReport shape (the frontend never imports backend).
type StackDriftStatus = 'in-sync' | 'drifted' | 'missing-runtime' | 'unreachable';
type DriftFindingKind = 'service-missing' | 'service-undeclared' | 'image-mismatch' | 'ports-mismatch';

interface StackDriftFinding {
  kind: DriftFindingKind;
  service: string;
  detail: string;
  expected?: string;
  actual?: string;
}

interface StackDriftReport {
  stack: string;
  status: StackDriftStatus;
  hasComposeFile: boolean;
  hasContainers: boolean;
  findings: StackDriftFinding[];
  parseError?: string;
}

const LABEL_CLASS = 'font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle';
const ACTION_CLASS =
  'inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-stat-subtitle hover:text-brand transition-colors disabled:opacity-40';

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
};

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

export default function DriftPanel({ stackName }: { stackName: string }) {
  const { activeNode } = useNodes();
  const nodeId = activeNode?.id;
  const [report, setReport] = useState<StackDriftReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // Refetch when the stack OR the active node changes (the same stack can exist on
  // two nodes), and on an explicit re-check. Drift is a point-in-time snapshot, so
  // a failed load shows a distinct retry state rather than a stale or blank report.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      // Clear any prior failure so an in-flight re-check shows the checking
      // affordance instead of leaving the error card up.
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

  const meta = report ? STATUS_META[report.status] : null;
  const StatusIcon = meta?.icon;

  return (
    <div data-testid="drift-panel" className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className={LABEL_CLASS}>compose vs runtime</span>
        <button
          type="button"
          data-testid="drift-recheck-btn"
          onClick={() => setReloadKey(k => k + 1)}
          disabled={loading}
          className={ACTION_CLASS}
        >
          <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} strokeWidth={1.5} /> re-check
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
            <div data-testid="drift-status" data-status={report.status} className={cn('rounded-lg border px-3 py-2.5', meta.tone)}>
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
        </>
      )}
    </div>
  );
}
