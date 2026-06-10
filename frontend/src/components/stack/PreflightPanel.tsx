import { useEffect, useState } from 'react';
import {
  Check, TriangleAlert, ShieldAlert, Info, RefreshCw, Stethoscope, type LucideIcon,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast-store';
import { formatTimeAgo } from '@/lib/relativeTime';
import { useNodes } from '@/context/NodeContext';

// Mirrors the backend payload shape (the frontend never imports backend).
type PreflightSeverity = 'blocker' | 'high' | 'warning' | 'info';
type PreflightStatus = 'never-run' | 'pass' | 'unrenderable' | PreflightSeverity;

interface PreflightFinding {
  ruleId: string;
  severity: PreflightSeverity;
  title: string;
  message: string;
  sourcePath?: string;
  remediation?: string;
  service?: string;
}

interface PreflightReport {
  stack: string;
  ranAt: number | null;
  ranBy: string | null;
  renderable: boolean;
  renderError: string | null;
  status: PreflightStatus;
  highestSeverity: PreflightSeverity | null;
  findings: PreflightFinding[];
}

const LABEL_CLASS = 'font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle';
const ACTION_CLASS =
  'inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-stat-subtitle hover:text-brand transition-colors disabled:opacity-40';
const CARD_CLASS = 'rounded-lg border px-3 py-2.5';

const SEVERITY_META: Record<PreflightSeverity, { label: string; icon: LucideIcon; tone: string }> = {
  blocker: { label: 'blocker', icon: ShieldAlert, tone: 'border-destructive/40 bg-destructive/[0.06] text-destructive' },
  high: { label: 'high risk', icon: TriangleAlert, tone: 'border-warning/40 bg-warning/[0.06] text-warning' },
  warning: { label: 'warning', icon: Info, tone: 'border-info/40 bg-info/[0.06] text-info' },
  info: { label: 'info', icon: Info, tone: 'border-muted bg-card/40 text-stat-subtitle' },
};

const GROUP_ORDER: PreflightSeverity[] = ['blocker', 'high', 'warning', 'info'];

/** The header summary card: a single read on the overall result. */
function summaryMeta(report: PreflightReport): { label: string; icon: LucideIcon; tone: string; line: string } {
  if (!report.renderable) {
    return {
      label: 'cannot render',
      icon: ShieldAlert,
      tone: 'border-destructive/40 bg-destructive/[0.06] text-destructive',
      line: report.renderError ?? 'Sencho could not render the effective Compose model.',
    };
  }
  if (report.findings.length === 0) {
    return { label: 'all clear', icon: Check, tone: 'border-success/40 bg-success/[0.06] text-success', line: 'No issues found in the effective model.' };
  }
  const meta = SEVERITY_META[report.highestSeverity ?? 'info'];
  const counts = GROUP_ORDER
    .map(sev => ({ sev, n: report.findings.filter(f => f.severity === sev).length }))
    .filter(c => c.n > 0)
    .map(c => `${c.n} ${SEVERITY_META[c.sev].label}`)
    .join(' · ');
  return { label: meta.label, icon: meta.icon, tone: meta.tone, line: counts };
}

function FindingRow({ finding }: { finding: PreflightFinding }) {
  return (
    <div className="border-t border-muted py-2 first:border-t-0">
      <div className="flex flex-wrap items-center gap-2">
        {finding.service && (
          <span className="rounded-md bg-brand/15 px-1.5 py-0.5 font-mono text-[11px] text-brand">{finding.service}</span>
        )}
        <span className="text-[12px] font-medium text-foreground/90">{finding.title}</span>
      </div>
      <div className="mt-1 text-[12px] leading-relaxed text-foreground/80">{finding.message}</div>
      {finding.remediation && (
        <div className="mt-1 text-[11px] text-stat-subtitle">
          <span className="font-mono text-[10px] uppercase tracking-wide">fix</span> · {finding.remediation}
        </div>
      )}
      {finding.sourcePath && (
        <div className="mt-0.5 font-mono text-[10px] text-stat-subtitle">{finding.sourcePath}</div>
      )}
    </div>
  );
}

export default function PreflightPanel({ stackName }: { stackName: string }) {
  const { activeNode } = useNodes();
  const nodeId = activeNode?.id;
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [running, setRunning] = useState(false);

  // Passive load of the last stored run when the stack or active node changes.
  // Read-only: opening the tab never renders or stores anything.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setLoadError(false);
      try {
        const res = await apiFetch(`/stacks/${stackName}/preflight`);
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(true);
          toast.error('Failed to load the preflight report.');
          return;
        }
        setReport((await res.json()) as PreflightReport);
        setLoadError(false);
      } catch {
        if (!cancelled) {
          setLoadError(true);
          toast.error('Failed to load the preflight report.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [stackName, nodeId, reloadKey]);

  // Running preflight renders the effective model and stores the result.
  const runPreflight = async () => {
    setRunning(true);
    try {
      const res = await apiFetch(`/stacks/${stackName}/preflight/run`, { method: 'POST' });
      if (!res.ok) {
        toast.error('Failed to run preflight.');
        return;
      }
      setReport((await res.json()) as PreflightReport);
      setLoadError(false);
    } catch {
      toast.error('Failed to run preflight.');
    } finally {
      setRunning(false);
    }
  };

  const summary = report && report.status !== 'never-run' ? summaryMeta(report) : null;
  const SummaryIcon = summary?.icon;
  const busy = loading || running;

  return (
    <div data-testid="preflight-panel" className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className={LABEL_CLASS}>compose doctor</span>
        <button
          type="button"
          data-testid="preflight-run-btn"
          onClick={runPreflight}
          disabled={busy}
          className={ACTION_CLASS}
        >
          <RefreshCw className={cn('h-3 w-3', running && 'animate-spin')} strokeWidth={1.5} /> run preflight
        </button>
      </div>

      {loadError ? (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/[0.06] px-3 py-3">
          <span className="font-mono text-[11px] text-destructive">Could not load the preflight report.</span>
          <button
            type="button"
            onClick={() => setReloadKey(k => k + 1)}
            className="font-mono text-[10px] uppercase tracking-wide text-destructive hover:underline"
          >
            retry
          </button>
        </div>
      ) : !report ? (
        <div className="py-3 font-mono text-[11px] text-stat-subtitle">Loading preflight…</div>
      ) : report.status === 'never-run' ? (
        <div className={cn(CARD_CLASS, 'border-muted bg-card/40 flex flex-col items-start gap-2')}>
          <div className="flex items-center gap-2 text-stat-subtitle">
            <Stethoscope className="h-4 w-4" strokeWidth={1.5} />
            <span className="font-mono text-[11px] uppercase tracking-wide">no preflight yet</span>
          </div>
          <p className="text-[12px] leading-relaxed text-foreground/80">
            Run preflight to render the effective model and check this stack for common deploy problems before you apply it.
          </p>
        </div>
      ) : (
        <>
          {summary && SummaryIcon && (
            <div data-testid="preflight-status" data-status={report.status} className={cn(CARD_CLASS, summary.tone)}>
              <div className="flex items-center gap-2">
                <SummaryIcon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                <span className="font-mono text-[11px] uppercase tracking-wide">{summary.label}</span>
                {report.ranAt && (
                  <span className="font-mono text-[10px] text-stat-subtitle">
                    · ran {formatTimeAgo(report.ranAt)}{report.ranBy ? ` by ${report.ranBy}` : ''}
                  </span>
                )}
              </div>
              <div className="mt-1 font-mono text-[11px] leading-relaxed text-foreground/80">{summary.line}</div>
            </div>
          )}

          {GROUP_ORDER.map(sev => {
            const items = report.findings.filter(f => f.severity === sev);
            if (items.length === 0) return null;
            return (
              <section key={sev}>
                <div className={cn(LABEL_CLASS, 'mb-1.5')}>{SEVERITY_META[sev].label} · {items.length}</div>
                <div className="rounded-lg border border-muted bg-card/40 px-3 py-1">
                  {items.map((f, i) => <FindingRow key={`${f.ruleId}-${f.service ?? ''}-${i}`} finding={f} />)}
                </div>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
