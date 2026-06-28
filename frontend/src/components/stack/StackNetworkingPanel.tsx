import { useEffect, useState, useCallback } from 'react';
import { Network, Globe, Lock, ShieldQuestion, RefreshCw, ArrowRight, Plus } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast-store';
import { useNodes } from '@/context/NodeContext';
import { CreateNetworkDialog } from '@/components/resources/CreateNetworkDialog';

// Mirrors the backend networking payload shapes (the frontend never imports
// backend). IntentEntry intentionally keeps only the fields this panel reads.
type ExposureIntent = 'internal' | 'same-node' | 'lan' | 'reverse-proxy' | 'public' | 'temporary' | 'unknown';
const INTENTS: readonly ExposureIntent[] = ['internal', 'same-node', 'lan', 'reverse-proxy', 'public', 'temporary', 'unknown'];

interface NetworkFactNetwork { key: string; name: string; external: boolean; internal: boolean; createdByStack: boolean }
interface NetworkFactPort { hostIp: string; startPort: number; endPort: number; protocol: string; allInterfaces: boolean; loopbackOnly: boolean }
interface NetworkFactService {
  name: string;
  networks: { key: string; aliases: string[] }[];
  publishedPorts: NetworkFactPort[];
  networkMode?: string;
  extraHosts: string[];
}
interface NetworkDriftFacts {
  runtimeOnlyAttachments: { container: string; service: string | null; network: string }[];
  declaredButUnused: string[];
  missingFromRuntime: string[];
  foreignNetworkAttachments: { container: string; network: string }[];
}
interface StackNetworkFacts {
  stack: string;
  renderable: boolean;
  renderError: string | null;
  runtime: 'available' | 'unavailable';
  networks: NetworkFactNetwork[];
  services: NetworkFactService[];
  drift: NetworkDriftFacts;
}
interface IntentEntry { service: string; intent: ExposureIntent }

const LABEL_CLASS = 'font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle';
const ACTION_CLASS = 'inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-stat-subtitle hover:text-brand transition-colors disabled:opacity-40';
const CARD_CLASS = 'rounded-lg border px-3 py-2.5';

function portLabel(p: NetworkFactPort): string {
  const range = p.startPort === p.endPort ? `${p.startPort}` : `${p.startPort}-${p.endPort}`;
  return `${range}/${p.protocol}`;
}

/** Defensively read the intents array from an exposure response body. */
function asIntents(body: unknown): IntentEntry[] {
  const list = (body as { intents?: unknown })?.intents;
  return Array.isArray(list) ? (list as IntentEntry[]) : [];
}

/** A small chip that states the binding scope of a published port. */
function BindingBadge({ port }: { port: NetworkFactPort }) {
  if (port.allInterfaces) {
    return <span className="rounded border border-warning/40 bg-warning/[0.08] px-1 py-0.5 font-mono text-[10px] text-warning">all interfaces</span>;
  }
  if (port.loopbackOnly) {
    return <span className="rounded border border-success/30 bg-success/[0.06] px-1 py-0.5 font-mono text-[10px] text-success">loopback</span>;
  }
  return <span className="rounded border border-muted bg-card/40 px-1 py-0.5 font-mono text-[10px] text-stat-subtitle">{port.hostIp}</span>;
}

/**
 * Exposure-intent picker: a row of pills plus a clear option. `value` null means
 * the scope is cleared. The clear option reads "unset" on the stack row and
 * "inherit" on a per-service row, where the service then falls back to the stack
 * intent. Disabled and read-only when the user cannot edit the stack.
 */
function IntentControl({ value, inherited, canEdit, onChange }: {
  value: ExposureIntent | null;
  inherited?: ExposureIntent | null;
  canEdit: boolean;
  onChange: (intent: ExposureIntent | null) => void;
}) {
  const pill = (active: boolean) => cn(
    'rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide border transition-colors',
    active ? 'border-brand/50 bg-brand/15 text-brand' : 'border-muted bg-card/40 text-stat-subtitle',
    canEdit ? 'hover:border-brand/40' : 'cursor-default opacity-90',
  );
  const clearLabel = inherited !== undefined ? 'inherit' : 'unset';
  const cleared = value === null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {INTENTS.map(opt => (
        <button key={opt} type="button" disabled={!canEdit} className={pill(value === opt)} onClick={() => canEdit && onChange(opt)}>
          {opt}
        </button>
      ))}
      <button type="button" disabled={!canEdit} className={pill(cleared)} onClick={() => canEdit && onChange(null)}>
        {clearLabel}
      </button>
      {cleared && inherited && (
        <span className="font-mono text-[10px] text-stat-subtitle">→ {inherited}</span>
      )}
    </div>
  );
}

export default function StackNetworkingPanel({ stackName, canEdit, doctorEnabled }: {
  stackName: string;
  canEdit: boolean;
  doctorEnabled: boolean;
}) {
  const { activeNode } = useNodes();
  const nodeId = activeNode?.id;
  const [facts, setFacts] = useState<StackNetworkFacts | null>(null);
  const [intents, setIntents] = useState<IntentEntry[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [showCreateNetwork, setShowCreateNetwork] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoadError(false);
      setRefreshing(true);
      try {
        const [factsRes, exposureRes] = await Promise.all([
          apiFetch(`/stacks/${stackName}/networking`),
          apiFetch(`/stacks/${stackName}/exposure`),
        ]);
        if (cancelled) return;
        if (!factsRes.ok) {
          setLoadError(true);
          toast.error('Failed to load the networking view.');
          return;
        }
        setFacts((await factsRes.json()) as StackNetworkFacts);
        // The exposure overlay is secondary: a bad exposure body must not tear
        // down a working facts view, so its parse is tolerated on its own.
        if (exposureRes.ok) {
          try { setIntents(asIntents(await exposureRes.json())); } catch { /* keep intents unset */ }
        }
      } catch {
        if (!cancelled) {
          setLoadError(true);
          toast.error('Failed to load the networking view.');
        }
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [stackName, nodeId, reloadKey]);

  const stackIntent = intents.find(i => i.service === '')?.intent ?? null;
  const intentFor = (service: string): ExposureIntent | null => intents.find(i => i.service === service)?.intent ?? null;

  const saveIntent = useCallback(async (service: string, intent: ExposureIntent | null) => {
    try {
      const res = await apiFetch(`/stacks/${stackName}/exposure`, {
        method: 'PUT',
        body: JSON.stringify({ service, intent }),
      });
      if (!res.ok) {
        toast.error('Failed to save the exposure intent.');
        return;
      }
      setIntents(asIntents(await res.json()));
    } catch {
      toast.error('Failed to save the exposure intent.');
    }
  }, [stackName]);

  if (loadError) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
        <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/[0.06] px-3 py-3">
          <span className="font-mono text-[11px] text-destructive">Could not load the networking view.</span>
          <button type="button" onClick={() => setReloadKey(k => k + 1)} className="font-mono text-[10px] uppercase tracking-wide text-destructive hover:underline">retry</button>
        </div>
      </div>
    );
  }
  if (!facts) {
    return <div className="flex-1 min-h-0 px-3 py-3 font-mono text-[11px] text-stat-subtitle">Loading networking…</div>;
  }
  if (!facts.renderable) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3">
        <div className={cn(CARD_CLASS, 'border-destructive/40 bg-destructive/[0.06]')}>
          <div className="flex items-center gap-2 text-destructive"><Network className="h-4 w-4" strokeWidth={1.5} /><span className="font-mono text-[11px] uppercase tracking-wide">cannot render</span></div>
          <p className="mt-1 text-[12px] leading-relaxed text-foreground/80">{facts.renderError ?? 'Sencho could not render the effective Compose model.'}</p>
        </div>
      </div>
    );
  }

  const drift = facts.drift;
  const hasDrift = drift.runtimeOnlyAttachments.length > 0 || drift.foreignNetworkAttachments.length > 0
    || drift.declaredButUnused.length > 0 || drift.missingFromRuntime.length > 0;

  return (
    <div data-testid="networking-panel" className="flex-1 min-h-0 overflow-y-auto px-3 py-3 flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <span className={LABEL_CLASS}>networking</span>
        <div className="flex items-center gap-3">
          {canEdit && (
            <button type="button" onClick={() => setShowCreateNetwork(true)} className={ACTION_CLASS}>
              <Plus className="h-3 w-3" strokeWidth={1.5} /> create network
            </button>
          )}
          <button type="button" onClick={() => setReloadKey(k => k + 1)} disabled={refreshing} className={ACTION_CLASS}>
            <RefreshCw className={cn('h-3 w-3', refreshing && 'animate-spin')} strokeWidth={1.5} /> refresh
          </button>
        </div>
      </div>

      <CreateNetworkDialog
        open={showCreateNetwork}
        onOpenChange={setShowCreateNetwork}
        onCreated={() => setReloadKey(k => k + 1)}
      />

      {/* Exposure intent */}
      <section className="flex flex-col gap-2">
        <div className={LABEL_CLASS}>exposure intent</div>
        <div className={cn(CARD_CLASS, 'border-muted bg-card/40 flex flex-col gap-2')}>
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[11px] text-foreground/80">stack</span>
            <IntentControl value={stackIntent} canEdit={canEdit} onChange={intent => saveIntent('', intent)} />
          </div>
          {facts.services.map(svc => (
            <div key={svc.name} className="flex flex-col gap-1 border-t border-muted pt-2">
              <span className="font-mono text-[11px] text-foreground/80">{svc.name}</span>
              <IntentControl value={intentFor(svc.name)} inherited={stackIntent} canEdit={canEdit} onChange={intent => saveIntent(svc.name, intent)} />
            </div>
          ))}
        </div>
      </section>

      {/* Networks */}
      <section className="flex flex-col gap-2">
        <div className={LABEL_CLASS}>networks</div>
        <div className="rounded-lg border border-muted bg-card/40">
          {facts.networks.length === 0 && <div className="px-3 py-2 font-mono text-[11px] text-stat-subtitle">default network only</div>}
          {facts.networks.map(net => (
            <div key={net.key} className="flex flex-wrap items-center gap-2 border-t border-muted px-3 py-2 first:border-t-0">
              <span className="font-mono text-[12px] text-foreground/90">{net.name}</span>
              {net.key !== net.name && <span className="font-mono text-[10px] text-stat-subtitle">({net.key})</span>}
              {net.external && <span className="rounded border border-info/40 bg-info/[0.06] px-1 py-0.5 font-mono text-[10px] text-info">external</span>}
              {net.internal && <span className="rounded border border-muted px-1 py-0.5 font-mono text-[10px] text-stat-subtitle"><Lock className="inline h-2.5 w-2.5" /> internal</span>}
              {net.createdByStack && <span className="rounded border border-muted px-1 py-0.5 font-mono text-[10px] text-stat-subtitle">created by stack</span>}
            </div>
          ))}
        </div>
      </section>

      {/* Services */}
      <section className="flex flex-col gap-2">
        <div className={LABEL_CLASS}>services</div>
        <div className="flex flex-col gap-2">
          {facts.services.map(svc => (
            <div key={svc.name} className={cn(CARD_CLASS, 'border-muted bg-card/40 flex flex-col gap-1.5')}>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[12px] text-foreground/90">{svc.name}</span>
                {svc.networkMode && <span className="rounded border border-warning/40 bg-warning/[0.08] px-1 py-0.5 font-mono text-[10px] text-warning">network_mode: {svc.networkMode}</span>}
              </div>
              {svc.networks.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {svc.networks.map(n => (
                    <span key={n.key} className="font-mono text-[11px] text-foreground/80">
                      {n.key}{n.aliases.length > 0 && <span className="text-stat-subtitle"> ({n.aliases.join(', ')})</span>}
                    </span>
                  ))}
                </div>
              )}
              {svc.networkMode === 'host' && (
                // Host networking publishes every container port on the host, so
                // the service is host-exposed even with no published-port rows.
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11px] text-foreground/80">all container ports</span>
                  <span className="rounded border border-warning/40 bg-warning/[0.08] px-1 py-0.5 font-mono text-[10px] text-warning">host-exposed</span>
                </div>
              )}
              {svc.publishedPorts.length > 0 && (
                <div className="flex flex-col gap-1">
                  {svc.publishedPorts.map((p, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[11px] text-foreground/80">{portLabel(p)}</span>
                      <BindingBadge port={p} />
                    </div>
                  ))}
                </div>
              )}
              {svc.extraHosts.length > 0 && (
                <div className="font-mono text-[10px] text-stat-subtitle">extra_hosts: {svc.extraHosts.join(', ')}</div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Runtime drift */}
      <section className="flex flex-col gap-2">
        <div className={LABEL_CLASS}>runtime drift</div>
        {facts.runtime === 'unavailable' ? (
          <div className={cn(CARD_CLASS, 'border-muted bg-card/40 flex items-center gap-2 text-stat-subtitle')}>
            <ShieldQuestion className="h-4 w-4" strokeWidth={1.5} />
            <span className="font-mono text-[11px]">runtime unavailable, showing the declared model only</span>
          </div>
        ) : !hasDrift ? (
          <div className={cn(CARD_CLASS, 'border-success/30 bg-success/[0.06] flex items-center gap-2 text-success')}>
            <Globe className="h-4 w-4" strokeWidth={1.5} />
            <span className="font-mono text-[11px] uppercase tracking-wide">runtime matches compose</span>
          </div>
        ) : (
          <div className="rounded-lg border border-muted bg-card/40 flex flex-col">
            {drift.runtimeOnlyAttachments.map((d, i) => (
              <div key={`ro-${i}`} className="border-t border-muted px-3 py-2 first:border-t-0 text-[12px] text-foreground/80">
                <span className="rounded bg-brand/15 px-1.5 py-0.5 font-mono text-[11px] text-brand">{d.service ?? d.container}</span> attached to undeclared network <span className="font-mono">{d.network}</span>
              </div>
            ))}
            {drift.foreignNetworkAttachments.map((d, i) => (
              <div key={`fn-${i}`} className="border-t border-muted px-3 py-2 first:border-t-0 text-[12px] text-foreground/80">
                <span className="font-mono">{d.container}</span> attached to a network owned by another stack: <span className="font-mono">{d.network}</span>
              </div>
            ))}
            {drift.declaredButUnused.length > 0 && (
              <div className="border-t border-muted px-3 py-2 first:border-t-0 text-[12px] text-foreground/80">declared but unused by any running service: <span className="font-mono">{drift.declaredButUnused.join(', ')}</span></div>
            )}
            {drift.missingFromRuntime.length > 0 && (
              <div className="border-t border-muted px-3 py-2 first:border-t-0 text-[12px] text-foreground/80">declared but missing from the runtime: <span className="font-mono">{drift.missingFromRuntime.join(', ')}</span></div>
            )}
          </div>
        )}
      </section>

      {doctorEnabled && (
        <div className="flex items-center gap-1 font-mono text-[10px] text-stat-subtitle">
          <ArrowRight className="h-3 w-3" strokeWidth={1.5} /> deploy and security findings are in the Doctor tab
        </div>
      )}
    </div>
  );
}
