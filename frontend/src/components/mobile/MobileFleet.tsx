import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { useLicense } from '@/context/LicenseContext';
import { useAuth } from '@/context/AuthContext';
import { useNodes } from '@/context/NodeContext';
import { cordonNode, uncordonNode } from '@/lib/nodesApi';
import { toast } from '@/components/ui/toast-store';
import { ConfirmModal } from '@/components/ui/modal';
import { formatBytes } from '@/lib/utils';
import { getNodeCpu, getNodeMem, getNodeDisk, isCritical } from '@/components/FleetView/nodeUtils';
import type { FleetNode } from '@/components/FleetView/types';
import { Bar, BackChip, Kicker, Masthead, MBtn, SectionHead, StateDot, StatePill } from './mobile-ui';
import type { Tone as UiTone } from './mobile-ui';

interface MobileFleetProps {
  headerActions: ReactNode;
  /** Switch the active node and drop to its stack list. */
  onInspectNode: (nodeId: number) => void;
  /** Switch the active node and open a specific stack on it. */
  onInspectStack: (nodeId: number, stackName: string) => void;
}

// Node health is a strict subset of the primitive tones (never brand-colored).
// Deriving it keeps the subset compiler-enforced if mobile-ui's tones change.
type Tone = Exclude<UiTone, 'brand'>;

function nodeTone(node: FleetNode): Tone {
  if (node.status !== 'online') return 'destructive';
  if (isCritical(node)) return 'warning';
  return 'success';
}

function formatAgo(ms: number): string {
  const c = Math.max(0, ms);
  if (c < 60_000) return `${Math.round(c / 1000)}s`;
  if (c < 3_600_000) return `${Math.round(c / 60_000)}m`;
  return `${Math.round(c / 3_600_000)}h`;
}

// Fetch + poll the fleet overview (same endpoint the desktop fleet uses).
function useMobileFleet() {
  const [nodes, setNodes] = useState<FleetNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchOverview = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await apiFetch('/fleet/overview', { localOnly: true, signal: controller.signal });
      if (res.ok) {
        setNodes(await res.json() as FleetNode[]);
        setLastSyncAt(Date.now());
      } else {
        // Leave the stale data and let the masthead "last sync" age visibly
        // rather than toast on every failed background poll, but log so a
        // wedged poll is traceable.
        console.error('Fleet overview poll failed:', res.status);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.error('Failed to fetch fleet overview:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // fetchOverview sets state only after an await, in a later tick, so it does
    // not cause the synchronous cascading render this rule guards against; the
    // rule can't follow the call through the async boundary and flags it here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchOverview();
    const id = setInterval(() => void fetchOverview(), 30_000);
    return () => {
      clearInterval(id);
      abortRef.current?.abort();
    };
  }, [fetchOverview]);

  return { nodes, loading, lastSyncAt, refetch: fetchOverview };
}

// One labeled metric cell in the masthead band / node card.
function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 flex-1 px-3 py-2.5 text-center">
      <div className="font-mono tabular-nums text-[17px] leading-none text-stat-value truncate">{value}</div>
      <div className="mt-1"><Kicker>{label}</Kicker></div>
    </div>
  );
}

function NodeCard({ node, isActive, onOpen }: { node: FleetNode; isActive: boolean; onOpen: () => void }) {
  const tone = nodeTone(node);
  const local = node.type === 'local';
  const stateLabel = node.status !== 'online' ? 'offline' : isCritical(node) ? 'critical' : 'online';
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`relative w-full overflow-hidden rounded-[12px] border border-card-border border-t-card-border-top bg-card text-left shadow-card-bevel ${node.status === 'online' ? '' : 'opacity-60'}`}
    >
      {local ? <span aria-hidden className="absolute inset-y-0 left-0 w-[2px] bg-brand" /> : null}
      <div className="flex items-center gap-2.5 px-[13px] pb-2.5 pt-3">
        <StateDot tone={tone} size={7} glow pulse={local} />
        <span className="min-w-0 flex-1 truncate font-mono text-[14px] text-stat-value">{node.name}</span>
        {local ? (
          <span className="rounded-[5px] bg-brand/[0.09] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-brand">
            you are here
          </span>
        ) : null}
        {isActive && !local ? (
          <span className="rounded-[5px] bg-brand/[0.09] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] text-brand">
            active
          </span>
        ) : null}
        <Kicker className={tone === 'destructive' ? 'text-destructive' : tone === 'warning' ? 'text-warning' : 'text-stat-subtitle'}>
          {node.cordoned ? 'cordoned' : stateLabel}
        </Kicker>
      </div>
      <div className="flex items-stretch divide-x divide-hairline border-t border-hairline">
        <StatCell label="stacks" value={`${node.stacks?.length ?? 0}`} />
        <StatCell label="cpu" value={node.status === 'online' && node.systemStats ? `${getNodeCpu(node).toFixed(0)}%` : '--'} />
        <StatCell label="mem" value={node.status === 'online' && node.systemStats ? `${getNodeMem(node).toFixed(0)}%` : '--'} />
      </div>
    </button>
  );
}

// One labeled resource bar in the node detail.
function ResourceRow({ label, pct, detail }: { label: string; pct: number; detail: string }) {
  return (
    <div className="py-2">
      <div className="flex items-baseline justify-between">
        <Kicker>{label}</Kicker>
        <span className="font-mono tabular-nums text-[12px] text-stat-subtitle">{detail}</span>
      </div>
      <Bar pct={pct} />
    </div>
  );
}

function NodeDetail({
  node,
  now,
  onBack,
  onInspectNode,
  onInspectStack,
  onCordonChange,
}: {
  node: FleetNode;
  now: number;
  onBack: () => void;
  onInspectNode: (nodeId: number) => void;
  onInspectStack: (nodeId: number, stackName: string) => void;
  onCordonChange: () => void;
}) {
  const { isPaid } = useLicense();
  const { can } = useAuth();
  const canCordon = isPaid && can('node:manage', 'node', String(node.id));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const tone = nodeTone(node);
  const online = node.status === 'online';
  const lastSeen = node.last_successful_contact ?? node.pilot_last_seen ?? null;
  const stacks = node.stacks ?? [];

  const handleCordon = async () => {
    setSubmitting(true);
    try {
      if (node.cordoned) {
        await uncordonNode(node.id);
        toast.success(`Uncordoned ${node.name}`);
      } else {
        await cordonNode(node.id, null);
        toast.success(`Cordoned ${node.name}`);
      }
      setConfirmOpen(false);
      onCordonChange();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update cordon state');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-2 pt-1">
        <BackChip label="Fleet" onClick={onBack} />
      </div>
      <div className="relative border-b border-hairline px-4 pb-[15px] pt-1">
        <span aria-hidden className={`absolute left-0 top-1 bottom-[15px] w-[3px] ${tone === 'destructive' ? 'bg-destructive' : tone === 'warning' ? 'bg-warning' : 'bg-brand'}`} />
        <div className="mb-1"><Kicker>{`fleet › node › ${node.name}`}</Kicker></div>
        <div className="flex items-center gap-2.5">
          <span className="min-w-0 truncate font-display italic text-[30px] leading-[34px] text-stat-value">{node.name}</span>
          <StatePill tone={tone} live={!online}>{node.cordoned ? 'cordoned' : online ? (isCritical(node) ? 'degraded' : 'online') : 'offline'}</StatePill>
        </div>
        <div className="mt-[7px] font-mono text-[12px] text-stat-subtitle">
          {`${node.type} · ${stacks.length} stacks${lastSeen ? ` · last seen ${formatAgo(now - lastSeen)}` : ''}`}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden p-[14px]">
        <div className="flex gap-2">
          <MBtn kind="primary" full onClick={() => onInspectNode(node.id)}>Inspect</MBtn>
          {canCordon ? (
            <MBtn kind="outline" full onClick={() => setConfirmOpen(true)}>
              {node.cordoned ? 'Uncordon' : 'Drain'}
            </MBtn>
          ) : null}
        </div>

        {online && node.systemStats ? (
          <div className="mt-[14px]">
            <SectionHead right="cpu · mem · disk">resources</SectionHead>
            <ResourceRow label="cpu" pct={getNodeCpu(node)} detail={`${getNodeCpu(node).toFixed(0)}%`} />
            <ResourceRow
              label="mem"
              pct={getNodeMem(node)}
              detail={`${formatBytes(node.systemStats.memory.used, 1)} / ${formatBytes(node.systemStats.memory.total, 1)}`}
            />
            {node.systemStats.disk ? (
              <ResourceRow
                label="disk"
                pct={getNodeDisk(node)}
                detail={`${formatBytes(node.systemStats.disk.used, 1)} / ${formatBytes(node.systemStats.disk.total, 1)}`}
              />
            ) : null}
          </div>
        ) : null}

        <div className="mt-[14px]">
          <SectionHead right={`${stacks.length}`}>stacks on node</SectionHead>
          {stacks.length === 0 ? (
            <p className="px-1 py-3 font-mono text-[12px] text-stat-subtitle">{online ? 'No stacks on this node.' : 'Node unreachable.'}</p>
          ) : (
            <div className="flex flex-col">
              {stacks.map(stack => (
                <button
                  key={stack}
                  type="button"
                  onClick={() => onInspectStack(node.id, stack)}
                  className="flex min-h-11 items-center gap-2 border-b border-hairline py-2 text-left last:border-b-0"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-stat-value">{stack.replace(/\.(ya?ml)$/, '')}</span>
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 text-stat-icon" strokeWidth={1.6} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="border-t border-hairline bg-band px-4 py-2.5">
        <Kicker>{`${lastSeen ? `last seen ${formatAgo(now - lastSeen)} ago · ` : ''}auto-refreshes every 30s`}</Kicker>
      </div>

      <ConfirmModal
        open={confirmOpen}
        onOpenChange={(open) => { if (!submitting) setConfirmOpen(open); }}
        kicker="Federation"
        title={node.cordoned ? `Uncordon ${node.name}` : `Cordon ${node.name}`}
        description={node.cordoned
          ? 'Re-enable this node for new blueprint placements. Existing deployments are unchanged.'
          : 'Mark this node as unschedulable. New blueprint deployments will skip it. Existing deployments remain in place.'}
        confirmLabel={node.cordoned ? 'Uncordon node' : 'Cordon node'}
        confirming={submitting}
        onConfirm={handleCordon}
      />
    </div>
  );
}

export function MobileFleet({ headerActions, onInspectNode, onInspectStack }: MobileFleetProps) {
  const { nodes, loading, lastSyncAt, refetch } = useMobileFleet();
  const { activeNode } = useNodes();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const selected = selectedId !== null ? nodes.find(n => n.id === selectedId) ?? null : null;
  if (selected) {
    return (
      <NodeDetail
        node={selected}
        now={now}
        onBack={() => setSelectedId(null)}
        onInspectNode={onInspectNode}
        onInspectStack={onInspectStack}
        onCordonChange={() => void refetch()}
      />
    );
  }

  const onlineNodes = nodes.filter(n => n.status === 'online');
  const criticalCount = onlineNodes.filter(isCritical).length;
  const offlineCount = nodes.length - onlineNodes.length;
  const level = criticalCount > 0 ? 'critical' : offlineCount > 0 ? 'degraded' : 'healthy';
  const label = level === 'critical' ? 'Critical' : level === 'degraded' ? 'Degraded' : 'Healthy';
  const tone: Tone = level === 'critical' ? 'destructive' : level === 'degraded' ? 'warning' : 'success';

  const totalStacks = nodes.reduce((sum, n) => sum + (n.stacks?.length ?? 0), 0);
  const running = nodes.reduce((sum, n) => sum + (n.stats?.active ?? 0), 0);
  const avgCpu = onlineNodes.length > 0 ? onlineNodes.reduce((s, n) => s + getNodeCpu(n), 0) / onlineNodes.length : 0;
  const memUsed = onlineNodes.reduce((s, n) => s + (n.systemStats?.memory.used ?? 0), 0);
  const memTotal = onlineNodes.reduce((s, n) => s + (n.systemStats?.memory.total ?? 0), 0);
  const memPct = memTotal > 0 ? (memUsed / memTotal) * 100 : 0;
  const syncLabel = lastSyncAt ? `last sync ${formatAgo(now - lastSyncAt)}` : 'connecting…';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Masthead
        kicker="fleet · overview"
        state={label}
        stateTone={tone}
        live={level !== 'healthy'}
        meta={`${nodes.length} ${nodes.length === 1 ? 'node' : 'nodes'} · ${totalStacks} stacks · ${syncLabel}`}
        right={headerActions}
      />

      <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden p-[14px] [&>*+*]:mt-[14px]">
        <div className="flex items-stretch divide-x divide-hairline overflow-hidden rounded-[12px] border border-card-border border-t-card-border-top bg-card shadow-card-bevel">
          <StatCell label="running" value={`${running}`} />
          <StatCell label="cpu" value={onlineNodes.length > 0 ? `${avgCpu.toFixed(0)}%` : '--'} />
          <StatCell label="mem" value={memTotal > 0 ? `${memPct.toFixed(0)}%` : '--'} />
        </div>

        {loading && nodes.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-stat-subtitle">
            <Loader2 className="h-5 w-5 animate-spin" strokeWidth={1.5} />
          </div>
        ) : nodes.length === 0 ? (
          <p className="px-1 py-4 font-mono text-[12px] text-stat-subtitle">No nodes configured.</p>
        ) : (
          <div className="flex flex-col gap-2.5">
            {nodes.map(node => (
              <NodeCard
                key={node.id}
                node={node}
                isActive={activeNode?.id === node.id}
                onOpen={() => setSelectedId(node.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
