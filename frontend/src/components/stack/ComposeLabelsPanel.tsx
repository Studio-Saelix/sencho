import { useCallback, useEffect, useMemo, useState } from 'react';
import { Info, Lock, Search, SlidersHorizontal } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAuth } from '@/context/AuthContext';
import {
  LABEL_DISAMBIGUATION_COPY,
  SOURCE_LABELS,
  SOURCE_FACET_LABELS,
  matchesSearch,
  sourcesPresent,
  type LabelSource,
  type LabelValue,
  type StackLabelInventory,
} from '@/lib/labelInventory';

const LABEL_CLASS = 'font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle';
const CARD_CLASS = 'rounded-lg border border-muted px-3 py-2.5';
const FILTER_SECTION_LABEL_CLASS = 'text-[10px] leading-3 font-mono uppercase tracking-[0.18em] text-stat-subtitle';

/**
 * A label is visible when its source is not excluded AND either the text matches its
 * key/value or the parent matched the search (a service by name, a replica by name or id).
 * Parent matches bypass text matching only, never the source facets.
 */
function labelVisible(label: LabelValue, search: string, excluded: Set<LabelSource>, parentHit: boolean): boolean {
  if (excluded.has(label.source)) return false;
  return parentHit || matchesSearch(search, label.key, label.value);
}

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
  const [search, setSearch] = useState('');
  const [excludedSources, setExcludedSources] = useState<Set<LabelSource>>(new Set());
  const [hiddenServices, setHiddenServices] = useState<Set<string>>(new Set());

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

  // Reset filters when the stack changes so selections never leak between stacks. Not keyed on
  // reveal/refetch, so filters are preserved across a reveal on the same stack.
  useEffect(() => {
    setSearch('');
    setExcludedSources(new Set());
    setHiddenServices(new Set());
  }, [stackName]);

  const filtersActive = search.trim() !== '' || excludedSources.size > 0;
  // Count of active facet filters for the Filters popover badge (search is its own control).
  const filterCount = excludedSources.size + hiddenServices.size;

  const sourceFacets = useMemo(() => {
    const srcs: LabelSource[] = [];
    for (const svc of inventory?.services ?? []) {
      for (const l of svc.declaredLabels) srcs.push(l.source);
      for (const rep of svc.replicas) for (const l of rep.runtimeLabels) srcs.push(l.source);
    }
    return sourcesPresent(srcs);
  }, [inventory]);

  const serviceNames = useMemo(() => (inventory?.services ?? []).map(s => s.service), [inventory]);

  // Filter-aware view model: computed before render so badges reflect only visible labels and
  // empty/failure states stay truthful. Per-service checkbox is the only thing that hides a card.
  const serviceViews = useMemo(() => {
    return (inventory?.services ?? [])
      .filter(svc => !hiddenServices.has(svc.service))
      .map(svc => {
        const serviceHit = matchesSearch(search, svc.service);
        const declaredVisible = svc.declaredLabels.filter(l => labelVisible(l, search, excludedSources, serviceHit));
        const declaredVisibleKeys = new Set(declaredVisible.map(l => l.key));
        const replicas = svc.replicas.map(rep => {
          if (rep.inspectFailed) {
            return { rep, inspectFailed: true as const, runtimeVisible: [] as LabelValue[], badges: { onlyInCompose: 0, onlyOnContainer: 0, inBoth: 0, changed: 0 }, render: true };
          }
          const replicaHit = serviceHit || matchesSearch(search, rep.name, rep.id);
          const runtimeVisible = rep.runtimeLabels.filter(l => labelVisible(l, search, excludedSources, replicaHit));
          const rtKeys = new Set(runtimeVisible.map(l => l.key));
          const badges = {
            onlyInCompose: rep.onlyInCompose.filter(k => declaredVisibleKeys.has(k)).length,
            onlyOnContainer: rep.onlyOnContainer.filter(k => rtKeys.has(k)).length,
            inBoth: rep.inBoth.filter(k => rtKeys.has(k)).length,
            changed: (rep.changed ?? []).filter(k => rtKeys.has(k)).length,
          };
          const anyBadge = badges.onlyInCompose + badges.onlyOnContainer + badges.inBoth + badges.changed > 0;
          const render = runtimeVisible.length > 0 || anyBadge || !filtersActive;
          return { rep, inspectFailed: false as const, runtimeVisible, badges, render };
        });
        const renderedReplicas = replicas.filter(r => r.render);
        const noRunning = svc.replicas.length === 0 && svc.declaredLabels.length > 0 && (!filtersActive || declaredVisible.length > 0);
        const hasContent = declaredVisible.length > 0 || renderedReplicas.length > 0 || noRunning;
        return { svc, declaredVisible, replicas: renderedReplicas, noRunning, hasContent };
      });
  }, [inventory, hiddenServices, search, excludedSources, filtersActive]);

  const toggleSource = (s: LabelSource) => {
    setExcludedSources(prev => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  };
  const toggleService = (s: string) => {
    setHiddenServices(prev => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s); else next.add(s);
      return next;
    });
  };

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

  const noServices = (inventory?.services.length ?? 0) === 0;
  const allServicesHidden = !noServices && serviceNames.every(s => hiddenServices.has(s));

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-4" data-testid="compose-labels-panel">
      <div className="flex items-center justify-between gap-2">
        <span className={LABEL_CLASS}>compose labels</span>
      </div>
      <p className="text-[11px] leading-relaxed text-stat-subtitle">{LABEL_DISAMBIGUATION_COPY}</p>

      {!noServices && (
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.5} />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter labels, services..."
              className="h-9 pl-8"
              data-testid="compose-label-search"
            />
          </div>
          {(sourceFacets.length > 0 || serviceNames.length > 1) && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant={filterCount > 0 ? 'default' : 'outline'} size="sm" className="h-9 gap-2 shrink-0">
                  <SlidersHorizontal className="w-4 h-4" />
                  Filters
                  {filterCount > 0 && (
                    <Badge variant="secondary" className="h-5 min-w-[1.25rem] px-1.5 text-[10px] tabular-nums">{filterCount}</Badge>
                  )}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 space-y-4">
                {sourceFacets.length > 0 && (
                  <div className="space-y-1.5">
                    <label className={FILTER_SECTION_LABEL_CLASS}>Defined by</label>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {sourceFacets.map(s => (
                        <Button
                          key={s}
                          variant={!excludedSources.has(s) ? 'default' : 'outline'}
                          size="sm"
                          className="h-7 text-xs px-2.5"
                          aria-pressed={!excludedSources.has(s)}
                          onClick={() => toggleSource(s)}
                        >
                          {SOURCE_FACET_LABELS[s]}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
                {serviceNames.length > 1 && (
                  <div className="space-y-1.5">
                    <label className={FILTER_SECTION_LABEL_CLASS}>Services</label>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {serviceNames.map(name => (
                        <Button
                          key={name}
                          variant={!hiddenServices.has(name) ? 'default' : 'outline'}
                          size="sm"
                          className="h-7 text-xs px-2.5 font-mono"
                          aria-pressed={!hiddenServices.has(name)}
                          onClick={() => toggleService(name)}
                        >
                          {name}
                        </Button>
                      ))}
                    </div>
                  </div>
                )}
                {filterCount > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full h-8 text-xs"
                    onClick={() => { setExcludedSources(new Set()); setHiddenServices(new Set()); }}
                  >
                    Clear filters
                  </Button>
                )}
              </PopoverContent>
            </Popover>
          )}
        </div>
      )}

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

      {noServices && (
        <p className="text-sm text-stat-subtitle">No Compose or runtime labels found for this stack.</p>
      )}

      {allServicesHidden && (
        <p className="text-sm text-stat-subtitle" data-testid="compose-labels-no-services">No services selected.</p>
      )}

      {serviceViews.map(({ svc, declaredVisible, replicas, noRunning, hasContent }) => (
        <div key={svc.service} className={CARD_CLASS} data-testid="compose-label-service">
          <p className={LABEL_CLASS}>{svc.service}</p>

          {declaredVisible.length > 0 && (
            <div className="mt-3">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle mb-1">Declared in Compose</p>
              {declaredVisible.map((label) => (
                <LabelRow key={`decl-${label.key}`} label={label} onReveal={isAdmin && !revealSecrets ? handleReveal : undefined} />
              ))}
            </div>
          )}

          {replicas.map(({ rep, inspectFailed, runtimeVisible, badges }) => (
            <div key={rep.id || rep.name} className="mt-3 border-t border-muted pt-3 first:mt-0 first:border-t-0 first:pt-0">
              <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle mb-1">
                {rep.name || rep.id.slice(0, 12)} · {rep.state}
              </p>
              {inspectFailed ? (
                <p className="text-xs text-warning">Runtime labels unavailable for this container.</p>
              ) : (
                <>
                  {(badges.onlyInCompose > 0 || badges.onlyOnContainer > 0 || badges.changed > 0) && (
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      <MismatchBadge kind="only-compose" count={badges.onlyInCompose} />
                      <MismatchBadge kind="changed" count={badges.changed} />
                      <MismatchBadge kind="only-container" count={badges.onlyOnContainer} />
                      <MismatchBadge kind="both" count={badges.inBoth} />
                    </div>
                  )}
                  {runtimeVisible.length > 0 ? (
                    runtimeVisible.map((label) => (
                      <LabelRow key={`rt-${label.key}`} label={label} onReveal={isAdmin && !revealSecrets ? handleReveal : undefined} />
                    ))
                  ) : (
                    !filtersActive && <p className="text-xs text-stat-subtitle">No runtime labels on this container.</p>
                  )}
                </>
              )}
            </div>
          ))}

          {noRunning && (
            <p className="mt-2 text-xs text-stat-subtitle">
              No running containers for this service. Container may need redeploy for Compose label changes to apply.
            </p>
          )}

          {filtersActive && !hasContent && (
            <p className="mt-2 text-xs text-stat-subtitle" data-testid="compose-label-service-no-match">No labels match the filter.</p>
          )}
        </div>
      ))}

      <p className="text-[10px] text-stat-subtitle leading-relaxed">
        Runtime labels are static until the container is recreated. Container may need redeploy for Compose label changes to apply.
      </p>
    </div>
  );
}
