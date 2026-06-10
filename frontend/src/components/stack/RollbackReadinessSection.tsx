import { useEffect, useState } from 'react';
import { Check, CircleHelp, Database, X, type LucideIcon } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useNodes } from '@/context/NodeContext';

// Mirrors the backend payload shape (the frontend never imports backend).
type RollbackItemState = 'ready' | 'missing' | 'unknown' | 'not_covered';
type RollbackOverall = 'ready' | 'partial' | 'not_ready';

interface RollbackReadinessItem {
  id: string;
  state: RollbackItemState;
  label: string;
  detail: string;
}

interface RollbackReadinessReport {
  stack: string;
  computedAt: number;
  overall: RollbackOverall;
  items: RollbackReadinessItem[];
}

const LABEL_CLASS = 'font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle';

const OVERALL_META: Record<RollbackOverall, { label: string; tone: string }> = {
  ready: { label: 'ready', tone: 'border-success/40 bg-success/[0.06] text-success' },
  partial: { label: 'partial', tone: 'border-warning/40 bg-warning/[0.06] text-warning' },
  not_ready: { label: 'not ready', tone: 'border-destructive/40 bg-destructive/[0.06] text-destructive' },
};

const STATE_META: Record<RollbackItemState, { icon: LucideIcon; tone: string }> = {
  ready: { icon: Check, tone: 'text-success' },
  missing: { icon: X, tone: 'text-destructive' },
  unknown: { icon: CircleHelp, tone: 'text-stat-subtitle' },
  not_covered: { icon: Database, tone: 'text-warning' },
};

/**
 * "Would the existing rollback actually save me?" disclosure for the Stack
 * Dossier. Read-only; renders nothing while loading, on error, or when the
 * active node does not advertise the update-guard capability.
 */
export function RollbackReadinessSection({ stackName }: { stackName: string }) {
  const { activeNode, hasCapability } = useNodes();
  const nodeId = activeNode?.id;
  const enabled = hasCapability('update-guard');
  const [report, setReport] = useState<RollbackReadinessReport | null>(null);

  useEffect(() => {
    setReport(null);
    if (!enabled) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await apiFetch(`/stacks/${stackName}/rollback-readiness`);
        if (cancelled) return;
        if (!res.ok) {
          console.warn('[RollbackReadiness] unavailable for %s:', stackName, res.status);
          return;
        }
        setReport(await res.json() as RollbackReadinessReport);
      } catch (e) {
        // Render-nothing on failure: the dossier remains fully usable without
        // this section. The warn keeps the cause findable in the console.
        if (!cancelled) console.warn('[RollbackReadiness] unavailable for %s:', stackName, e);
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [stackName, nodeId, enabled]);

  if (!enabled || !report) return null;

  const overall = OVERALL_META[report.overall] ?? OVERALL_META.partial;

  return (
    <section data-testid="dossier-rollback-readiness">
      <div className="mb-1.5 flex items-center gap-2">
        <span className={LABEL_CLASS}>rollback readiness</span>
        <span
          data-testid="rollback-overall"
          data-overall={report.overall}
          className={cn('rounded-md border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide', overall.tone)}
        >
          {overall.label}
        </span>
      </div>
      <div className="rounded-lg border border-muted bg-card/40 px-3 py-1">
        {report.items.map(item => {
          const meta = STATE_META[item.state] ?? STATE_META.unknown;
          const StateIcon = meta.icon;
          return (
            <div key={item.id} className="border-t border-muted py-2 first:border-t-0">
              <div className="flex items-center gap-2">
                <StateIcon className={cn('h-3.5 w-3.5 shrink-0', meta.tone)} strokeWidth={1.5} />
                <span className="text-[12px] font-medium text-foreground/90">{item.label}</span>
              </div>
              <div className="mt-0.5 pl-5 text-[12px] leading-relaxed text-foreground/80">{item.detail}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
