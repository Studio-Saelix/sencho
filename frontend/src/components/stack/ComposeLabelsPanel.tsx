import { useCallback, useEffect, useState } from 'react';
import { Info, Lock } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';
import { useAuth } from '@/context/AuthContext';
import {
  LABEL_DISAMBIGUATION_COPY,
  SOURCE_LABELS,
  type LabelValue,
  type StackLabelInventory,
} from '@/lib/labelInventory';

const LABEL_CLASS = 'font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle';
const CARD_CLASS = 'rounded-lg border border-muted px-3 py-2.5';

function LabelRow({ label, onReveal }: { label: LabelValue; onReveal?: () => void }) {
  const { isAdmin } = useAuth();
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-muted py-2 first:border-t-0" data-testid="compose-label-row">
      <span className="font-mono text-[12px] font-medium text-foreground/90">{label.key}</span>
      <span className="text-muted-foreground">=</span>
      <span className="inline-flex items-center gap-1 font-mono text-xs text-foreground/80">
        {label.redacted && <Lock className="h-3 w-3 text-stat-subtitle" strokeWidth={1.5} />}
        {label.value}
      </span>
      <span className="rounded border border-muted px-1.5 py-0.5 font-mono text-[10px] text-stat-subtitle">
        {SOURCE_LABELS[label.source]}
      </span>
      {label.redacted && isAdmin && onReveal && (
        <button type="button" onClick={onReveal} className="font-mono text-[10px] uppercase text-brand hover:underline">
          Reveal
        </button>
      )}
    </div>
  );
}

function MismatchBadge({ kind, count }: { kind: 'only-compose' | 'only-container' | 'both' | 'changed'; count: number }) {
  const labels = {
    'only-compose': 'only in Compose',
    'only-container': 'only on running container',
    both: 'present in both',
    changed: 'value changed',
  };
  const tones = {
    'only-compose': 'border-warning/40 bg-warning/[0.06] text-warning',
    'only-container': 'border-info/40 bg-info/[0.06] text-info',
    both: 'border-muted bg-card/40 text-stat-subtitle',
    changed: 'border-warning/40 bg-warning/[0.06] text-warning',
  };
  if (count === 0) return null;
  return (
    <span className={cn('inline-flex rounded border px-1.5 py-0.5 font-mono text-[10px]', tones[kind])} data-testid={`mismatch-${kind}`}>
      {count} {labels[kind]}
    </span>
  );
}

export default function ComposeLabelsPanel({ stackName }: { stackName: string }) {
  const { isAdmin } = useAuth();
  const [inventory, setInventory] = useState<StackLabelInventory | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [revealSecrets, setRevealSecrets] = useState(false);

  const fetchInventory = useCallback(async (reveal = revealSecrets) => {
    setLoading(true);
    setLoadError(false);
    try {
      const qs = reveal ? '?reveal=1' : '';
      const res = await apiFetch(`/stacks/${stackName}/label-inventory${qs}`);
      if (!res.ok) {
        setLoadError(true);
        throw new Error('Failed to load Compose label inventory');
      }
      setInventory(await res.json() as StackLabelInventory);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load Compose label inventory');
      setInventory(null);
    } finally {
      setLoading(false);
    }
  }, [stackName, revealSecrets]);

  useEffect(() => {
    void fetchInventory();
  }, [fetchInventory]);

  const handleReveal = () => {
    setRevealSecrets(true);
    void fetchInventory(true);
  };

  if (loading && !inventory) {
    return <p className="px-3 py-3 font-mono text-[11px] text-stat-subtitle">Loading Compose labels…</p>;
  }

  if (loadError) {
    return <p className="px-3 py-3 font-mono text-[11px] text-destructive">Could not load Compose labels for this stack.</p>;
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-4" data-testid="compose-labels-panel">
      <div className="flex items-center justify-between gap-2">
        <span className={LABEL_CLASS}>compose labels</span>
      </div>
      <p className="text-[11px] leading-relaxed text-stat-subtitle">{LABEL_DISAMBIGUATION_COPY}</p>

      {!inventory?.renderable && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/[0.06] px-3 py-2 text-xs text-warning">
          <Info className="h-4 w-4 shrink-0 mt-0.5" strokeWidth={1.5} />
          <span>Compose could not be fully rendered. Declared labels may be incomplete.</span>
        </div>
      )}

      {inventory?.partial && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/[0.06] px-3 py-2 text-xs text-warning">
          <Info className="h-4 w-4 shrink-0 mt-0.5" strokeWidth={1.5} />
          <span>Some containers or images could not be inspected. Label provenance may be incomplete.</span>
        </div>
      )}

      {inventory?.services.length === 0 && (
        <p className="text-sm text-stat-subtitle">No Compose or runtime labels found for this stack.</p>
      )}

      {inventory?.services.map((svc) => (
        <div key={svc.service} className={CARD_CLASS} data-testid="compose-label-service">
          <p className={LABEL_CLASS}>{svc.service}</p>

          {svc.declaredLabels.length > 0 && (
            <div className="mt-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle mb-1">Declared in Compose</p>
              {svc.declaredLabels.map((label) => (
                <LabelRow key={`decl-${label.key}`} label={label} onReveal={isAdmin && !revealSecrets ? handleReveal : undefined} />
              ))}
            </div>
          )}

          {svc.replicas.map((rep) => (
            <div key={rep.id || rep.name} className="mt-3 border-t border-muted pt-3 first:mt-0 first:border-t-0 first:pt-0">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle mb-1">
                {rep.name || rep.id.slice(0, 12)} · {rep.state}
              </p>
              {rep.inspectFailed ? (
                <p className="text-xs text-warning">Runtime labels unavailable for this container.</p>
              ) : (
                <>
                  {(rep.onlyInCompose.length > 0 || rep.onlyOnContainer.length > 0 || (rep.changed?.length ?? 0) > 0) && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      <MismatchBadge kind="only-compose" count={rep.onlyInCompose.length} />
                      <MismatchBadge kind="changed" count={rep.changed?.length ?? 0} />
                      <MismatchBadge kind="only-container" count={rep.onlyOnContainer.length} />
                      <MismatchBadge kind="both" count={rep.inBoth.length} />
                    </div>
                  )}
                  {rep.runtimeLabels.length > 0 ? (
                    rep.runtimeLabels.map((label) => (
                      <LabelRow key={`rt-${label.key}`} label={label} onReveal={isAdmin && !revealSecrets ? handleReveal : undefined} />
                    ))
                  ) : (
                    <p className="text-xs text-stat-subtitle">No runtime labels on this container.</p>
                  )}
                </>
              )}
            </div>
          ))}

          {svc.replicas.length === 0 && svc.declaredLabels.length > 0 && (
            <p className="mt-2 text-xs text-stat-subtitle">
              No running containers for this service. Container may need redeploy for Compose label changes to apply.
            </p>
          )}
        </div>
      ))}

      <p className="text-[10px] text-stat-subtitle leading-relaxed">
        Runtime labels are static until the container is recreated. Container may need redeploy for Compose label changes to apply.
      </p>
    </div>
  );
}
