import { useEffect, useRef, useState, useCallback } from 'react';
import { Network, Globe, Lock, ShieldQuestion, RefreshCw, ArrowRight, Plus } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui/toast-store';
import { useNodes } from '@/context/NodeContext';
import { CreateNetworkDialog } from '@/components/resources/CreateNetworkDialog';
import { SENCHO_NAVIGATE_EVENT, type SenchoNavigateDetail } from '@/components/NodeManager';
import { ExposureIntentPicker } from '@/components/networking/ExposureIntentPicker';
import { asIntents, saveExposureIntent, type IntentEntry } from '@/hooks/useExposureIntent';
import { conflictChip, proofLine } from '@/lib/detectedExposure';
import { isRoutingUnverified, tunnelProviderLabel, tunnelScopeLabel } from '@/lib/tunnelExposure';
import type {
  DetectedPath, DetectedServiceExposure, ExposureIntent, ServiceTunnelExposure, TunnelConnector,
} from '@/types/networking';

// Mirrors the backend networking payload shapes (the frontend never imports
// backend).

interface NetworkFactNetwork { key: string; name: string; external: boolean; internal: boolean; createdByStack: boolean }
interface NetworkFactPort { hostIp: string; startPort: number; endPort: number; protocol: string; dynamic?: true; allInterfaces: boolean; loopbackOnly: boolean }
interface NetworkFactService {
  name: string;
  networks: { key: string; aliases: string[] }[];
  publishedPorts: NetworkFactPort[];
  networkMode?: string;
  extraHosts: string[];
  tunnel?: ServiceTunnelExposure;
  /** Absent from nodes that predate detected exposure. */
  detected?: DetectedServiceExposure;
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
  missingExternalNetworks?: Array<{
    name: string;
    keys: string[];
    safe: boolean;
    blockReason?: string;
    unsupportedFeatures: string[];
  }>;
  /** Absent from nodes that predate tunnel detection. */
  tunnels?: TunnelConnector[];
}

const LABEL_CLASS = 'font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle';
const ACTION_CLASS = 'inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide text-stat-subtitle hover:text-brand transition-colors disabled:opacity-40';
const CARD_CLASS = 'rounded-lg border px-3 py-2.5';

function portLabel(p: NetworkFactPort): string {
  // Docker assigns the host port at start, so no number exists to show.
  if (p.dynamic) return `auto-assigned/${p.protocol}`;
  const range = p.startPort === p.endPort ? `${p.startPort}` : `${p.startPort}-${p.endPort}`;
  return `${range}/${p.protocol}`;
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

const CHIP_CLASS = 'rounded border px-1 py-0.5 font-mono text-[10px]';
const CHIP_TONE: Record<'conflict' | 'possible' | 'note', string> = {
  conflict: 'border-warning/40 bg-warning/[0.08] text-warning',
  possible: 'border-warning/30 bg-warning/[0.05] text-warning/90',
  note: 'border-muted bg-card/40 text-stat-subtitle',
};

/** Every tunnel path that reaches a service. A node that predates detected
 *  exposure only reports its strongest one. */
type DetectedTunnelPath = Extract<DetectedPath, { kind: 'tunnel' }>;

function isTunnelPath(path: DetectedPath): path is DetectedTunnelPath {
  return path.kind === 'tunnel';
}

function tunnelPathsOf(service: NetworkFactService): ServiceTunnelExposure[] {
  const detected = service.detected;
  if (!detected) return service.tunnel ? [service.tunnel] : [];
  const paths: DetectedPath[] = detected.paths;
  return paths.filter(isTunnelPath)
    .map(path => ({ connector: path.connector, provider: path.provider, scope: path.scope, path: path.path }));
}

/** Tunnel facts for one service: the connector it runs, or every tunnel that reaches it.
 *  A public edge reads as a warning; a private overlay stays neutral. */
function TunnelBadges({ connector, tunnels }: { connector?: TunnelConnector; tunnels: ServiceTunnelExposure[] }) {
  if (!connector && tunnels.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {connector && (
        <span className={cn(CHIP_CLASS, 'border-brand/40 bg-brand/[0.08] text-brand')}>
          {tunnelProviderLabel(connector.provider)} connector · {tunnelScopeLabel(connector.scope)}
        </span>
      )}
      {tunnels.map(tunnel => (
        <span key={`${tunnel.connector}:${tunnel.path}`} className="flex flex-wrap items-center gap-2">
          <span className={cn(CHIP_CLASS, tunnel.scope === 'public-edge'
            ? 'border-warning/40 bg-warning/[0.08] text-warning'
            : 'border-muted bg-card/40 text-foreground/80')}
          >
            via {tunnelProviderLabel(tunnel.provider)} ({tunnel.connector}) · {tunnelScopeLabel(tunnel.scope)}
          </span>
          {isRoutingUnverified(tunnel) && (
            <span className={cn(CHIP_CLASS, 'border-muted bg-card/40 text-stat-subtitle')}>routing unverified</span>
          )}
        </span>
      ))}
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
  const [intentsUnavailable, setIntentsUnavailable] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [showCreateNetwork, setShowCreateNetwork] = useState(false);

  // Which stack on which node the panel is showing. A load or a write that
  // resolves after a switch belongs to the previous view and is dropped; a
  // refresh of the same view keeps its result.
  const viewKey = `${nodeId ?? ''}::${stackName}`;
  const viewKeyRef = useRef(viewKey);
  useEffect(() => {
    viewKeyRef.current = viewKey;
    setFacts(null);
    setIntents([]);
    setIntentsUnavailable(false);
    setLoadError(false);
  }, [viewKey]);

  useEffect(() => {
    let cancelled = false;
    const requestedKey = viewKey;
    const run = async () => {
      setLoadError(false);
      setRefreshing(true);
      try {
        const [factsRes, exposureRes] = await Promise.all([
          apiFetch(`/stacks/${stackName}/networking`),
          apiFetch(`/stacks/${stackName}/exposure`),
        ]);
        if (cancelled || viewKeyRef.current !== requestedKey) return;
        if (!factsRes.ok) {
          setLoadError(true);
          toast.error('Failed to load the networking view.');
          return;
        }
        setFacts((await factsRes.json()) as StackNetworkFacts);
        // The exposure overlay is secondary: a bad exposure body must not tear
        // down a working facts view, so its parse is tolerated on its own. An
        // unreadable intent list is said out loud, never shown as "unset".
        if (exposureRes.ok) {
          try {
            setIntents(asIntents(await exposureRes.json()) ?? []);
            setIntentsUnavailable(false);
          } catch {
            setIntents([]);
            setIntentsUnavailable(true);
          }
        } else {
          setIntents([]);
          setIntentsUnavailable(true);
        }
      } catch {
        if (!cancelled && viewKeyRef.current === requestedKey) {
          setLoadError(true);
          toast.error('Failed to load the networking view.');
        }
      } finally {
        if (!cancelled) setRefreshing(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [stackName, nodeId, reloadKey, viewKey]);

  const stackIntent = intents.find(i => i.service === '')?.intent ?? null;
  const intentFor = (service: string): ExposureIntent | null => intents.find(i => i.service === service)?.intent ?? null;

  const saveIntent = useCallback(async (service: string, intent: ExposureIntent | null) => {
    const requestedKey = `${nodeId ?? ''}::${stackName}`;
    const next = await saveExposureIntent(stackName, service, intent);
    if (next !== null && viewKeyRef.current === requestedKey) {
      setIntents(next);
      setIntentsUnavailable(false);
    }
  }, [stackName, nodeId]);

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
        {intentsUnavailable && (
          <div className="font-mono text-[10px] text-warning/90">exposure intent could not be read; refresh to retry</div>
        )}
        <div className={cn(CARD_CLASS, 'border-muted bg-card/40 flex flex-col gap-2')}>
          <div className="flex flex-col gap-1">
            <span className="font-mono text-[11px] text-foreground/80">stack</span>
            <ExposureIntentPicker
              value={stackIntent}
              canEdit={canEdit}
              autoLabel={!intentsUnavailable && facts.services.some(s => s.detected) ? 'auto (detected)' : undefined}
              onChange={intent => saveIntent('', intent)}
            />
          </div>
          {facts.services.map(svc => {
            const detected = svc.detected;
            const effectiveIntent = intentFor(svc.name) ?? stackIntent;
            const chip = !intentsUnavailable && detected && effectiveIntent ? conflictChip(detected, effectiveIntent) : null;
            const offerAdoption = !intentsUnavailable && effectiveIntent === null && canEdit && detected?.suggestedIntent === 'same-node';
            return (
              <div key={svc.name} data-testid={`service-intent-${svc.name}`} className="flex flex-col gap-1 border-t border-muted pt-2">
                <span className="font-mono text-[11px] text-foreground/80">{svc.name}</span>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[10px] text-stat-subtitle">
                    {detected ? `detected: ${detected.answer}` : 'detected exposure is not reported by this node'}
                  </span>
                  {chip && <span className={cn(CHIP_CLASS, CHIP_TONE[chip.level])}>{chip.text}</span>}
                  {offerAdoption && (
                    <button type="button" onClick={() => saveIntent(svc.name, 'same-node')} className={ACTION_CLASS}>
                      <ArrowRight className="h-3 w-3" strokeWidth={1.5} /> use same-node
                    </button>
                  )}
                </div>
                <ExposureIntentPicker
                  value={intentFor(svc.name)}
                  inherited={stackIntent}
                  autoLabel={!intentsUnavailable && detected ? 'auto (detected)' : undefined}
                  canEdit={canEdit}
                  onChange={intent => saveIntent(svc.name, intent)}
                />
              </div>
            );
          })}
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
          {facts.services.map(svc => {
            const proof = svc.detected ? proofLine(svc.detected) : null;
            return (
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
              <TunnelBadges connector={facts.tunnels?.find(c => c.service === svc.name)} tunnels={tunnelPathsOf(svc)} />
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
              {proof && (
                <div className="font-mono text-[10px] leading-relaxed text-stat-subtitle/80">{proof}</div>
              )}
            </div>
            );
          })}
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
      <button
        type="button"
        onClick={() => {
          window.dispatchEvent(new CustomEvent<SenchoNavigateDetail>(SENCHO_NAVIGATE_EVENT, {
            detail: { view: 'networking' },
          }));
        }}
        className="flex items-center gap-1 font-mono text-[10px] text-stat-subtitle hover:text-stat-value transition-colors"
      >
        <ArrowRight className="h-3 w-3" strokeWidth={1.5} /> view node networking
      </button>
    </div>
  );
}
