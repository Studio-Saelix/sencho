import { useEffect, useState } from 'react';
import { Lock, Copy, Info, TriangleAlert, ShieldAlert } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast-store';
import { copyToClipboard } from '@/lib/clipboard';
import { useNodes } from '@/context/NodeContext';
import {
  buildEnvChecklistMarkdown,
  SOURCE_LABELS,
  STATUS_LABELS,
  type EnvInventory,
  type EnvInventoryItem,
  type EnvItemStatus,
  type EnvFileExistence,
} from '@/lib/envChecklist';

const LABEL_CLASS = 'font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle';
const ACTION_CLASS =
  'inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-stat-subtitle hover:text-brand transition-colors disabled:opacity-40';
const CARD_CLASS = 'rounded-lg border px-3 py-2.5';

const STATUS_META: Record<EnvItemStatus, { tone: string }> = {
  present: { tone: 'border-muted bg-card/40 text-stat-subtitle' },
  missing: { tone: 'border-destructive/40 bg-destructive/[0.06] text-destructive' },
  duplicate: { tone: 'border-warning/40 bg-warning/[0.06] text-warning' },
  unpersisted: { tone: 'border-warning/40 bg-warning/[0.06] text-warning' },
  unused: { tone: 'border-info/40 bg-info/[0.06] text-info' },
};

const EXISTENCE_TONE: Record<EnvFileExistence, string> = {
  present: 'border-muted bg-card/40 text-stat-subtitle',
  missing: 'border-destructive/40 bg-destructive/[0.06] text-destructive',
  unverifiable: 'border-warning/40 bg-warning/[0.06] text-warning',
};

/** Local status pill. Env statuses are not vuln-scan severities, so this is its own badge. */
function EnvironmentStatusBadge({ status }: { status: EnvItemStatus }) {
  return (
    <span
      data-testid="env-status-badge"
      data-status={status}
      className={cn('inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px]', STATUS_META[status].tone)}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

function scopeLabel(item: EnvInventoryItem): string {
  const parts: string[] = [];
  if (item.usedForInterpolation) parts.push('interpolation');
  if (item.injectedIntoService) parts.push('injected');
  return parts.join(' + ') || 'unused';
}

function ItemRow({ item }: { item: EnvInventoryItem }) {
  const sources = item.sources.map(s => SOURCE_LABELS[s] ?? s).join(', ') || '-';
  return (
    <div className="border-t border-muted py-2 first:border-t-0" data-testid="env-item-row" data-key={item.key}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[12px] font-medium text-foreground/90">{item.key}</span>
        {item.likelySecret && (
          <span
            data-testid="env-secret-badge"
            title="Likely a secret. Its value is never read or shown."
            className="inline-flex items-center gap-1 rounded border border-muted bg-card/40 px-1.5 py-0.5 font-mono text-[10px] text-stat-subtitle"
          >
            <Lock className="h-2.5 w-2.5" strokeWidth={1.5} /> secret
          </span>
        )}
        {item.required && (
          <span className="rounded border border-muted px-1.5 py-0.5 font-mono text-[10px] text-stat-subtitle">required</span>
        )}
        <EnvironmentStatusBadge status={item.status} />
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[10px] text-stat-subtitle">
        <span>source: {sources}</span>
        <span>scope: {scopeLabel(item)}</span>
      </div>
    </div>
  );
}

const STATUS_GROUPS: { status: EnvItemStatus; label: string }[] = [
  { status: 'missing', label: 'missing' },
  { status: 'duplicate', label: 'duplicate' },
  { status: 'unpersisted', label: 'shell-only' },
  { status: 'unused', label: 'unused' },
  { status: 'present', label: 'present' },
];

export default function EnvironmentPanel({ stackName }: { stackName: string }) {
  const { activeNode } = useNodes();
  const nodeId = activeNode?.id;
  const [inventory, setInventory] = useState<EnvInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setLoadError(false);
      try {
        const res = await apiFetch(`/stacks/${stackName}/env-inventory`);
        if (cancelled) return;
        if (!res.ok) {
          setLoadError(true);
          toast.error('Failed to load the environment inventory.');
          return;
        }
        setInventory((await res.json()) as EnvInventory);
      } catch {
        if (!cancelled) {
          setLoadError(true);
          toast.error('Failed to load the environment inventory.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [stackName, nodeId]);

  const copyChecklist = async () => {
    if (!inventory) return;
    setCopying(true);
    try {
      await copyToClipboard(buildEnvChecklistMarkdown(inventory));
      toast.success('Env checklist copied. Names and status only, no values.');
    } catch {
      toast.error('Failed to copy the env checklist.');
    } finally {
      setCopying(false);
    }
  };

  return (
    <div data-testid="environment-panel" className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className={LABEL_CLASS}>environment</span>
        <button
          type="button"
          data-testid="env-copy-checklist-btn"
          onClick={copyChecklist}
          disabled={!inventory || copying}
          className={ACTION_CLASS}
        >
          <Copy className="h-3 w-3" strokeWidth={1.5} /> copy env checklist
        </button>
      </div>

      <p className="text-[11px] leading-relaxed text-stat-subtitle">
        Compose reads <span className="font-mono">.env</span> and the shell for <span className="font-mono">{'${VAR}'}</span> interpolation,
        while <span className="font-mono">env_file</span> and inline <span className="font-mono">environment</span> are injected into the container.
        Values are never read or shown: likely secrets show presence only.
      </p>

      {loadError ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/[0.06] px-3 py-3">
          <ShieldAlert className="h-4 w-4 text-destructive" strokeWidth={1.5} />
          <span className="font-mono text-[11px] text-destructive">Could not load the environment inventory.</span>
        </div>
      ) : loading || !inventory ? (
        <div className="py-3 font-mono text-[11px] text-stat-subtitle">Loading environment…</div>
      ) : (
        <>
          {!inventory.renderable && (
            <div className={cn(CARD_CLASS, 'border-warning/40 bg-warning/[0.06] text-warning flex items-center gap-2')}>
              <TriangleAlert className="h-4 w-4 shrink-0" strokeWidth={1.5} />
              <span className="font-mono text-[11px]">Effective model unavailable. Showing the authored env surface only.</span>
            </div>
          )}

          <div className={cn(CARD_CLASS, 'border-muted bg-card/40 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-stat-subtitle')}>
            <span>{inventory.summary.total} vars</span>
            {inventory.summary.missing > 0 && <span className="text-destructive">{inventory.summary.missing} missing</span>}
            {inventory.summary.duplicate > 0 && <span className="text-warning">{inventory.summary.duplicate} duplicate</span>}
            {inventory.summary.unpersisted > 0 && <span className="text-warning">{inventory.summary.unpersisted} shell-only</span>}
            {inventory.summary.unused > 0 && <span className="text-info">{inventory.summary.unused} unused</span>}
            {inventory.summary.likelySecret > 0 && <span>{inventory.summary.likelySecret} likely secret</span>}
          </div>

          {(() => {
            // Declared env files plus anything not cleanly present, so a missing or
            // unreadable env_file is visible right here, alongside the variables.
            const files = inventory.envFiles.filter(f => f.isInjectionSource || f.existence !== 'present');
            if (files.length === 0) return null;
            return (
              <section data-testid="env-files-section">
                <div className={cn(LABEL_CLASS, 'mb-1.5')}>env files · {files.length}</div>
                <div className="rounded-lg border border-muted bg-card/40 px-3 py-1">
                  {files.map((f, i) => (
                    <div key={`${f.rawPaths.join(',')}-${i}`} className="flex flex-wrap items-center gap-2 border-t border-muted py-2 first:border-t-0">
                      <span className="font-mono text-[12px] text-foreground/90">{f.rawPaths.join(', ')}</span>
                      <span className={cn('inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[10px]', EXISTENCE_TONE[f.existence])}>
                        {f.existence}
                      </span>
                      {f.declaringServices.length > 0 && (
                        <span className="font-mono text-[10px] text-stat-subtitle">{f.declaringServices.join(', ')}</span>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            );
          })()}

          {inventory.items.length === 0 ? (
            <div className={cn(CARD_CLASS, 'border-muted bg-card/40 flex items-center gap-2 text-stat-subtitle')}>
              <Info className="h-4 w-4" strokeWidth={1.5} />
              <span className="text-[12px]">No environment variables are referenced or defined for this stack.</span>
            </div>
          ) : (
            STATUS_GROUPS.map(({ status, label }) => {
              const items = inventory.items.filter(i => i.status === status);
              if (items.length === 0) return null;
              return (
                <section key={status}>
                  <div className={cn(LABEL_CLASS, 'mb-1.5')}>{label} · {items.length}</div>
                  <div className="rounded-lg border border-muted bg-card/40 px-3 py-1">
                    {items.map(item => <ItemRow key={item.key} item={item} />)}
                  </div>
                </section>
              );
            })
          )}
        </>
      )}
    </div>
  );
}
