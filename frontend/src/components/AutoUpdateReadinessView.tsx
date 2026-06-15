import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, Shield, AlertTriangle, ShieldAlert, CircleSlash, Clock, Play, CalendarClock, Monitor, Globe } from 'lucide-react';
import { toast } from '@/components/ui/toast-store';
import { apiFetch, fetchForNode } from '@/lib/api';
import { useNodes } from '@/context/NodeContext';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { Masthead, Kicker } from '@/components/mobile/mobile-ui';
import { ImageSourceMenu } from './ImageSourceMenu';
import type { ScheduledTask } from '@/types/scheduling';

type SemverBump = 'none' | 'patch' | 'minor' | 'major' | 'unknown';

interface UpdatePreviewImage {
  service: string;
  image: string;
  current_tag: string;
  next_tag: string | null;
  has_update: boolean;
  semver_bump: SemverBump;
}

type UpdateKind = 'tag' | 'digest' | 'none';

interface UpdatePreview {
  stack_name: string;
  images: UpdatePreviewImage[];
  summary: {
    has_update: boolean;
    primary_image: string | null;
    current_tag: string | null;
    next_tag: string | null;
    semver_bump: SemverBump;
    update_kind: UpdateKind;
    blocked: boolean;
    blocked_reason: string | null;
  };
  rollback_target: string | null;
  changelog: string | null;
}

export interface StackCard {
  stack: string;
  nodeId: number;
  preview: UpdatePreview | null;
  previewLoaded: boolean;
  scheduledTask: ScheduledTask | null;
  applying: boolean;
  // True when at least one enabled action='update' scheduled task covers this
  // stack on this node (per-stack row or fleet row). Drives the Auto: Off pill
  // and the Apply now button's disabled state.
  autoUpdateEnabled: boolean;
}

interface NodeGroup {
  nodeId: number;
  nodeName: string;
  nodeType: 'local' | 'remote';
  cards: StackCard[];
}

interface FleetUpdateResponse {
  [nodeId: string]: Record<string, boolean>;
}

function formatRelative(ts: number | null): string {
  if (ts == null) return '';
  const delta = ts - Date.now();
  if (delta <= 0) return 'due now';
  const mins = Math.round(delta / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins > 0 ? `in ${hours}h ${remMins}m` : `in ${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `in ${days}d ${remHours}h` : `in ${days}d`;
}

function formatClock(ts: number | null): string {
  if (ts == null) return '';
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function RiskBadge({ bump, blocked }: { bump: SemverBump; blocked: boolean }) {
  if (blocked || bump === 'major') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/10 px-2.5 py-0.5 font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-destructive">
        <ShieldAlert className="h-3 w-3" strokeWidth={1.5} />
        Blocked · major
      </span>
    );
  }
  if (bump === 'minor') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/40 bg-warning/10 px-2.5 py-0.5 font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-warning">
        <AlertTriangle className="h-3 w-3" strokeWidth={1.5} />
        Review · minor
      </span>
    );
  }
  if (bump === 'patch') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-success/40 bg-success/10 px-2.5 py-0.5 font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-success">
        <Shield className="h-3 w-3" strokeWidth={1.5} />
        Safe · patch
      </span>
    );
  }
  if (bump === 'unknown') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-card-border bg-muted/30 px-2.5 py-0.5 font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">
        Digest rebuild
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-card-border bg-muted/30 px-2.5 py-0.5 font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">
      None
    </span>
  );
}

function VersionDiff({ current, next }: { current: string | null; next: string | null }) {
  if (!current) return null;
  const changed = next && next !== current;
  return (
    <div className="flex items-baseline gap-2 font-mono text-sm">
      <span className="text-stat-subtitle">{current}</span>
      <span className="text-stat-subtitle/60">→</span>
      <span className={changed ? 'text-brand font-medium' : 'text-stat-subtitle'}>
        {next ?? current}
      </span>
    </div>
  );
}

function StackReadinessCard({
  card,
  onApply,
}: {
  card: StackCard;
  onApply: (stack: string, nodeId: number) => void;
}) {
  const { stack, nodeId, preview, previewLoaded, scheduledTask, applying, autoUpdateEnabled } = card;
  const loading = !previewLoaded;
  const failed = previewLoaded && preview === null;
  const blocked = preview?.summary.blocked ?? false;
  const bump = preview?.summary.semver_bump ?? 'none';
  const updatingImageCount = preview?.images.filter(i => i.has_update).length ?? 0;
  const nextRun = scheduledTask?.next_run_at ?? null;

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1 min-w-0">
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-stat-subtitle/80">
            Stack
          </span>
          <span className="font-display italic text-2xl leading-tight tracking-tight text-stat-value truncate">
            {stack}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {!autoUpdateEnabled && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-card-border bg-muted/30 px-2.5 py-0.5 font-mono text-[10px] leading-3 uppercase tracking-[0.18em] text-stat-subtitle">
              <CircleSlash className="h-3 w-3" strokeWidth={1.5} />
              Auto: Off
            </span>
          )}
          {previewLoaded && preview && <RiskBadge bump={bump} blocked={blocked} />}
        </div>
      </div>

      {loading ? (
        <div className="font-mono text-xs text-stat-subtitle/80">Checking registry...</div>
      ) : failed ? (
        <div className="font-mono text-xs text-destructive/80">
          Preview failed. Registry may be unreachable.
        </div>
      ) : (
        (() => {
          const p = preview!;
          const blockedReason = p.summary.blocked_reason;
          return (
            <>
              {p.summary.update_kind === 'digest' ? (
                <div className="flex items-baseline gap-2 font-mono text-sm">
                  <span className="text-stat-subtitle">{p.summary.current_tag}</span>
                  <span className="text-brand text-[10px] leading-3 uppercase tracking-[0.18em]">
                    Rebuild available
                  </span>
                </div>
              ) : (
                <VersionDiff
                  current={p.summary.current_tag}
                  next={p.summary.next_tag}
                />
              )}

              <div className="flex items-center gap-1.5 font-mono text-[11px] text-stat-subtitle/80">
                <span>{p.summary.primary_image ?? '-'}</span>
                {updatingImageCount > 1 && (
                  <span className="text-stat-subtitle/60">
                    · {updatingImageCount} services
                  </span>
                )}
                <ImageSourceMenu imageRef={p.summary.primary_image} />
              </div>

              <div className="border-t border-dashed border-card-border pt-3 text-xs text-stat-subtitle/90 leading-relaxed">
                {p.changelog ?? 'No changelog available from the registry yet.'}
              </div>

              {blocked && blockedReason && (
                <div className="rounded border border-destructive/25 bg-destructive/5 px-3 py-2 text-[11px] text-destructive/90">
                  {blockedReason}
                </div>
              )}

              <div className="mt-auto flex items-center justify-between gap-3 pt-1">
                <div className="flex items-center gap-1.5 font-mono text-[11px] text-stat-subtitle">
                  {nextRun ? (
                    <>
                      <CalendarClock className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
                      <span>Scheduled · <span className="text-stat-value">{formatClock(nextRun)}</span></span>
                      <span className="text-stat-subtitle/70">· {formatRelative(nextRun)}</span>
                    </>
                  ) : (
                    <>
                      <Clock className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
                      <span>No schedule</span>
                    </>
                  )}
                </div>
                <Button
                  size="sm"
                  onClick={() => onApply(stack, nodeId)}
                  disabled={blocked || applying || !autoUpdateEnabled}
                  title={
                    !autoUpdateEnabled
                      ? 'No schedule covers this stack. Create one in Schedules → Auto-update Stack.'
                      : (blocked ? (blockedReason ?? undefined) : undefined)
                  }
                  className="gap-1.5"
                >
                  <Play className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
                  {applying ? 'Applying...' : 'Apply now'}
                </Button>
              </div>
            </>
          );
        })()
      )}
    </Card>
  );
}

function ReadinessHero({
  total,
  ready,
  nodeCount,
  refreshing,
  onRefresh,
}: {
  total: number;
  ready: number;
  nodeCount: number;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const headline = total === 0
    ? 'Everything is up to date'
    : total === 1
      ? '1 update pending'
      : `${total} updates pending`;
  const acrossNodes = nodeCount > 1
    ? ` across ${nodeCount} nodes`
    : nodeCount === 1
      ? ' across 1 node'
      : '';

  return (
    <div className="relative overflow-hidden rounded-lg border border-brand/25 border-t-brand/35 bg-card shadow-card-bevel">
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-brand/[0.10] via-brand/[0.02] to-transparent" />
      <div className="absolute inset-y-0 left-0 w-[3px] bg-brand" />
      <div className="relative grid grid-cols-[1fr_auto] items-center gap-6 py-5 pl-7 pr-6">
        <div className="flex flex-col gap-1 min-w-0">
          <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-brand">
            Fleet readiness
          </span>
          <span className="font-display italic text-3xl leading-tight tracking-tight text-stat-value">
            {headline}
          </span>
          {total > 0 && (
            <span className="font-mono text-[11px] text-stat-subtitle/90">
              {ready} of {total} ready to apply automatically{acrossNodes}
              {total - ready > 0 ? ` · ${total - ready} need a schedule or review` : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {total > 0 && (
            <div className="text-right">
              <div className="font-mono tabular-nums text-2xl text-stat-value">
                {ready}<span className="text-stat-subtitle/60"> / {total}</span>
              </div>
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
                Ready
              </div>
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
            aria-label="Recheck registries"
            className="gap-2"
          >
            <RefreshCw
              className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`}
              strokeWidth={1.5}
              aria-hidden="true"
            />
            Recheck
          </Button>
        </div>
      </div>
    </div>
  );
}

function NodeGroupSection({
  group,
  onApply,
}: {
  group: NodeGroup;
  onApply: (stack: string, nodeId: number) => void;
}) {
  const TypeIcon = group.nodeType === 'local' ? Monitor : Globe;
  const stackCount = group.cards.length;
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-baseline gap-3 border-b border-card-border/60 pb-2">
        <TypeIcon className="h-4 w-4 text-stat-subtitle self-center" strokeWidth={1.5} aria-hidden="true" />
        <span className="font-display italic text-xl leading-tight tracking-tight text-stat-value truncate">
          {group.nodeName}
        </span>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 shrink-0 self-center">
          {group.nodeType}
        </Badge>
        <span className="font-mono text-[11px] text-stat-subtitle/80">
          {stackCount} {stackCount === 1 ? 'stack' : 'stacks'}
        </span>
      </div>
      <div className="grid gap-4 grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3">
        {group.cards.map(card => (
          <StackReadinessCard key={`${card.nodeId}::${card.stack}`} card={card} onApply={onApply} />
        ))}
      </div>
    </section>
  );
}

// --- mobile (<md) bespoke pieces ---------------------------------------------

/** One-up readiness card for the phone screen. Reuses RiskBadge + VersionDiff
 *  and the same apply/disabled logic as the desktop card. Exported for tests. */
export function MobileReadinessCard({ card, onApply }: { card: StackCard; onApply: (stack: string, nodeId: number) => void }) {
  const { stack, nodeId, preview, previewLoaded, scheduledTask, applying, autoUpdateEnabled } = card;
  const failed = previewLoaded && preview === null;
  const blocked = preview?.summary.blocked ?? false;
  const bump = preview?.summary.semver_bump ?? 'none';
  const nextRun = scheduledTask?.next_run_at ?? null;
  const changelog = preview?.changelog ?? 'No changelog available from the registry yet.';
  const dot = changelog.indexOf('.');
  const lead = dot > 0 ? changelog.slice(0, dot + 1) : '';
  const rest = dot > 0 ? changelog.slice(dot + 1) : changelog;

  return (
    <div className="flex flex-col gap-[10px] rounded-xl border border-card-border border-t-card-border-top bg-card p-[14px] shadow-card-bevel">
      <div className="flex items-start justify-between gap-[10px]">
        <div className="min-w-0 flex-1">
          <Kicker>stack</Kicker>
          <div className="mt-px truncate font-display italic text-[23px] leading-[26px] text-stat-value">{stack}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {!autoUpdateEnabled && (
            <span className="inline-flex items-center gap-1 rounded-full border border-card-border px-2 py-[3px] font-mono text-[10px] uppercase tracking-[0.1em] text-stat-subtitle">
              <CircleSlash className="h-3 w-3" strokeWidth={1.5} />Auto: Off
            </span>
          )}
          {previewLoaded && preview && <RiskBadge bump={bump} blocked={blocked} />}
        </div>
      </div>

      {!previewLoaded ? (
        <div className="font-mono text-xs text-stat-subtitle/80">Checking registry...</div>
      ) : failed ? (
        <div className="font-mono text-xs text-destructive/80">Preview failed. Registry may be unreachable.</div>
      ) : (
        <>
          {preview!.summary.update_kind === 'digest' ? (
            <div className="flex items-baseline gap-2 font-mono text-[13px]">
              <span className="text-stat-subtitle">{preview!.summary.current_tag}</span>
              <span className="text-[10px] uppercase tracking-[0.12em] text-brand">Rebuild available</span>
            </div>
          ) : (
            <VersionDiff current={preview!.summary.current_tag} next={preview!.summary.next_tag} />
          )}
          <div className="truncate font-mono text-[11px] text-stat-subtitle">{preview!.summary.primary_image ?? '-'}</div>
          <div className="border-t border-dashed border-card-border pt-[9px] text-[12.5px] leading-[18px] text-stat-subtitle">
            {lead && <b className="text-stat-title">{lead}</b>}{rest}
          </div>
          <div className="flex items-center justify-between gap-[10px] pt-0.5">
            <span className={`font-mono text-[11px] ${blocked ? 'text-destructive' : 'text-stat-subtitle'}`}>
              {nextRun ? <>{formatClock(nextRun)} · {formatRelative(nextRun)}</> : (blocked ? 'Held for review' : 'No schedule')}
            </span>
            <Button
              size="sm"
              variant={blocked || !autoUpdateEnabled ? 'outline' : 'default'}
              onClick={() => onApply(stack, nodeId)}
              disabled={blocked || applying || !autoUpdateEnabled}
              className="gap-1.5"
            >
              <Play className="h-3.5 w-3.5" strokeWidth={1.5} aria-hidden="true" />
              {applying ? 'Applying...' : 'Apply now'}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function MobileNodeSection({ group, onApply }: { group: NodeGroup; onApply: (stack: string, nodeId: number) => void }) {
  return (
    <section>
      <div className="mb-[13px] flex items-baseline gap-2 border-b border-hairline pb-2">
        <span className="truncate font-display italic text-[19px] leading-tight text-stat-value">{group.nodeName}</span>
        <span className="shrink-0 rounded-[5px] border border-card-border px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.1em] text-stat-subtitle">{group.nodeType}</span>
        <span className="shrink-0 font-mono text-[11px] text-stat-icon">{group.cards.length} {group.cards.length === 1 ? 'stack' : 'stacks'}</span>
      </div>
      <div className="flex flex-col gap-3">
        {group.cards.map(card => (
          <MobileReadinessCard key={`${card.nodeId}::${card.stack}`} card={card} onApply={onApply} />
        ))}
      </div>
    </section>
  );
}

interface AutoUpdateReadinessProps {
  /** Notifications + more-menu cluster for the mobile masthead, rehomed from the dropped TopBar. */
  headerActions?: ReactNode;
}

function AutoUpdateReadinessContent({ headerActions }: AutoUpdateReadinessProps) {
  const isMobile = useIsMobile();
  const { nodes } = useNodes();
  const [groups, setGroups] = useState<NodeGroup[]>([]);
  const [reachableNodeCount, setReachableNodeCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic token guards against stale setGroups from older fetches.
  const loadTokenRef = useRef(0);
  // Holds the latest nodes array so loadReadiness can reference it without
  // re-firing every time NodeContext rebuilds the array on a meta refresh.
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  // Stable signature: only changes when membership or node identity actually
  // changes, not when NodeContext reissues the same logical list.
  const nodesSignature = useMemo(
    () => nodes.map(n => `${n.id}:${n.type}:${n.status}`).sort().join('|'),
    [nodes],
  );

  const localNodeId = useMemo(() => nodes.find(n => n.type === 'local')?.id ?? null, [nodes]);
  const onlineNodeCount = useMemo(() => nodes.filter(n => n.status === 'online').length, [nodes]);

  const loadReadiness = useCallback(async () => {
    const token = ++loadTokenRef.current;
    setLoading(true);
    try {
      const [statusRes, tasksRes] = await Promise.all([
        apiFetch('/image-updates/fleet', { localOnly: true }),
        apiFetch('/scheduled-tasks?action=update', { localOnly: true }),
      ]);
      if (token !== loadTokenRef.current) return;

      if (!statusRes.ok) {
        throw new Error('Failed to load fleet update status');
      }
      const fleetStatus = await statusRes.json() as FleetUpdateResponse;
      setReachableNodeCount(Object.keys(fleetStatus).length);

      const tasks: ScheduledTask[] = tasksRes.ok ? await tasksRes.json() : [];
      // A stack is "covered" by an enabled action='update' row when either
      // a per-stack row targets it or a fleet row targets its node. We pick
      // the earliest next-run covering task so the readiness card renders
      // the next-run time accurately for both shapes.
      const taskByNodeStack = new Map<string, ScheduledTask>();
      const fleetTaskByNode = new Map<number, ScheduledTask>();
      for (const t of tasks) {
        if (!t.enabled) continue;
        // The fetch URL filters on action=update; this guard makes the
        // coverage check robust against a future regression there.
        if (t.action !== 'update') continue;
        const taskNodeId = t.node_id ?? localNodeId;
        if (taskNodeId == null) continue;
        if (t.target_type === 'fleet') {
          const existing = fleetTaskByNode.get(taskNodeId);
          if (!existing || (t.next_run_at ?? Infinity) < (existing.next_run_at ?? Infinity)) {
            fleetTaskByNode.set(taskNodeId, t);
          }
        } else if (t.target_type === 'stack' && t.target_id) {
          const key = `${taskNodeId}::${t.target_id}`;
          const existing = taskByNodeStack.get(key);
          if (!existing || (t.next_run_at ?? Infinity) < (existing.next_run_at ?? Infinity)) {
            taskByNodeStack.set(key, t);
          }
        }
      }

      const flatPairs: { nodeId: number; stack: string }[] = [];
      const initialGroups: NodeGroup[] = [];
      const currentNodes = nodesRef.current;
      for (const [nodeIdStr, stackMap] of Object.entries(fleetStatus)) {
        const nodeId = Number(nodeIdStr);
        const node = currentNodes.find(n => n.id === nodeId);
        if (!node) continue;
        const stacks = Object.entries(stackMap)
          .filter(([, hasUpdate]) => hasUpdate)
          .map(([stack]) => stack)
          .sort();
        if (stacks.length === 0) continue;
        const cards: StackCard[] = stacks.map(stack => {
          flatPairs.push({ nodeId, stack });
          const stackTask = taskByNodeStack.get(`${nodeId}::${stack}`) ?? null;
          const fleetTask = fleetTaskByNode.get(nodeId) ?? null;
          // Prefer whichever covering task fires next.
          // Earliest next-run wins; on a tie, the per-stack row beats the
          // fleet row so the user sees the more specific schedule.
          const scheduledTask = stackTask && fleetTask
            ? ((stackTask.next_run_at ?? Infinity) <= (fleetTask.next_run_at ?? Infinity) ? stackTask : fleetTask)
            : (stackTask ?? fleetTask);
          return {
            stack,
            nodeId,
            preview: null,
            previewLoaded: false,
            scheduledTask,
            applying: false,
            autoUpdateEnabled: scheduledTask !== null,
          };
        });
        initialGroups.push({
          nodeId,
          nodeName: node.name,
          nodeType: node.type,
          cards,
        });
      }
      initialGroups.sort((a, b) => {
        if (a.nodeType !== b.nodeType) return a.nodeType === 'local' ? -1 : 1;
        return a.nodeName.localeCompare(b.nodeName);
      });

      if (token !== loadTokenRef.current) return;
      setGroups(initialGroups);

      const previews = await Promise.all(
        flatPairs.map(async ({ nodeId, stack }) => {
          try {
            const res = await fetchForNode(`/stacks/${encodeURIComponent(stack)}/update-preview`, nodeId);
            if (!res.ok) return null;
            return await res.json() as UpdatePreview;
          } catch {
            return null;
          }
        }),
      );
      if (token !== loadTokenRef.current) return;

      const previewByKey = new Map<string, UpdatePreview | null>();
      flatPairs.forEach((pair, idx) => {
        previewByKey.set(`${pair.nodeId}::${pair.stack}`, previews[idx]);
      });

      setGroups(initialGroups.map(g => ({
        ...g,
        cards: g.cards.map(c => ({
          ...c,
          preview: previewByKey.get(`${c.nodeId}::${c.stack}`) ?? null,
          previewLoaded: true,
        })),
      })));
    } catch (err) {
      if (token !== loadTokenRef.current) return;
      toast.error((err as Error)?.message || 'Failed to load readiness');
    } finally {
      if (token === loadTokenRef.current) setLoading(false);
    }
  }, [localNodeId]);

  useEffect(() => {
    if (nodesSignature === '') return;
    loadReadiness();
    return () => {
      // Invalidate any in-flight fetch and cancel pending refresh timers on unmount.
      loadTokenRef.current++;
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [loadReadiness, nodesSignature]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await apiFetch('/image-updates/fleet/refresh', { method: 'POST', localOnly: true });
      if (!res.ok) {
        toast.error('Failed to trigger refresh');
        return;
      }
      const data = await res.json() as { triggered: number[]; rateLimited: number[]; failed: number[] };
      const tCount = data.triggered.length;
      const rCount = data.rateLimited.length;
      const fCount = data.failed.length;
      if (tCount > 0) {
        toast.success(`Rechecking ${tCount} ${tCount === 1 ? 'node' : 'nodes'}...`);
      }
      if (rCount > 0) {
        toast.warning(`${rCount} ${rCount === 1 ? 'node is' : 'nodes are'} rate-limited; try again shortly`);
      }
      if (fCount > 0) {
        toast.error(`${fCount} ${fCount === 1 ? 'node' : 'nodes'} failed to refresh`);
      }
      if (tCount === 0 && rCount === 0 && fCount === 0) {
        toast.info('No reachable nodes to refresh');
        return;
      }
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        loadReadiness();
      }, 2500);
    } catch (err) {
      toast.error((err as Error)?.message || 'Failed to trigger refresh');
    } finally {
      setRefreshing(false);
    }
  }, [loadReadiness]);

  const handleApply = useCallback(async (stack: string, nodeId: number) => {
    const setCardField = (predicate: (c: StackCard) => boolean, patch: Partial<StackCard>) =>
      setGroups(prev => prev.map(g => ({
        ...g,
        cards: g.cards.map(c => predicate(c) ? { ...c, ...patch } : c),
      })));

    setCardField(c => c.stack === stack && c.nodeId === nodeId, { applying: true });
    const loadingId = toast.loading(`Applying update to ${stack}...`);
    try {
      const res = await fetchForNode(
        `/stacks/${encodeURIComponent(stack)}/update`,
        nodeId,
        { method: 'POST' },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Update failed' }));
        throw new Error(data.error ?? 'Update failed');
      }
      toast.success(`${stack} updated successfully`);
      setGroups(prev => prev
        .map(g => g.nodeId === nodeId
          ? { ...g, cards: g.cards.filter(c => c.stack !== stack) }
          : g)
        .filter(g => g.cards.length > 0));
    } catch (err) {
      toast.error((err as Error)?.message || 'Update failed');
      setCardField(c => c.stack === stack && c.nodeId === nodeId, { applying: false });
    } finally {
      toast.dismiss(loadingId);
    }
  }, []);

  const flatCards = useMemo(() => groups.flatMap(g => g.cards), [groups]);
  const { total, ready } = useMemo(() => {
    const t = flatCards.length;
    // "Ready" means a schedule covers the stack, the preview loaded without
    // error, and no major-bump blocked it. Without a covering schedule the
    // stack cannot apply automatically regardless of preview state.
    const r = flatCards.filter(c =>
      c.autoUpdateEnabled
      && c.previewLoaded
      && c.preview !== null
      && !c.preview.summary.blocked,
    ).length;
    return { total: t, ready: r };
  }, [flatCards]);

  const showPartialBanner = reachableNodeCount != null
    && onlineNodeCount > 0
    && reachableNodeCount < onlineNodeCount;

  if (isMobile) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <Masthead
          kicker="fleet · updates"
          state={total === 0 ? 'Up to date' : `${total} pending`}
          stateTone={total === 0 ? 'success' : 'warning'}
          live={total > 0}
          meta={total > 0 ? `${ready} ready · ${total - ready} in review` : 'all stacks current'}
          right={headerActions}
        />
        <div className="flex-1 min-h-0 overflow-y-auto p-4 [&>*+*]:mt-4">
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={handleRefresh} disabled={refreshing} aria-label="Recheck registries" className="gap-1.5">
              <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? 'animate-spin' : ''}`} strokeWidth={1.5} aria-hidden="true" />
              Recheck
            </Button>
          </div>
          {showPartialBanner && (
            <div className="font-mono text-[11px] text-stat-subtitle">
              {reachableNodeCount} of {onlineNodeCount} nodes reachable. Unreachable nodes are not shown.
            </div>
          )}
          {loading && groups.length === 0 ? (
            <div className="flex items-center justify-center py-16 font-mono text-xs text-stat-subtitle">Loading readiness...</div>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-card-border bg-card/40 py-16 text-center">
              <Shield className="h-8 w-8 text-success/70" strokeWidth={1.5} aria-hidden="true" />
              <div className="font-display italic text-xl text-stat-value">All stacks on current builds</div>
              <div className="font-mono text-[11px] text-stat-subtitle">Sencho rechecks on the scheduler interval.</div>
            </div>
          ) : (
            groups.map(group => <MobileNodeSection key={group.nodeId} group={group} onApply={handleApply} />)
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-[1600px] mx-auto w-full">
      <ReadinessHero
        total={total}
        ready={ready}
        nodeCount={groups.length}
        refreshing={refreshing}
        onRefresh={handleRefresh}
      />

      {showPartialBanner && (
        <div className="font-mono text-[11px] text-stat-subtitle/90 -mt-3 pl-7">
          {reachableNodeCount} of {onlineNodeCount} nodes reachable. Unreachable nodes are not shown.
        </div>
      )}

      {loading && groups.length === 0 ? (
        <div className="flex items-center justify-center py-16 font-mono text-xs text-stat-subtitle">
          Loading readiness...
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-card-border bg-card/40 py-16">
          <Shield className="h-8 w-8 text-success/70" strokeWidth={1.5} aria-hidden="true" />
          <div className="font-display italic text-xl text-stat-value">All stacks on current builds</div>
          <div className="font-mono text-[11px] text-stat-subtitle">
            Sencho will recheck registries on the scheduler interval.
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          {groups.map(group => (
            <NodeGroupSection key={group.nodeId} group={group} onApply={handleApply} />
          ))}
        </div>
      )}
    </div>
  );
}

export default function AutoUpdateReadinessView(props: AutoUpdateReadinessProps = {}) {
  return <AutoUpdateReadinessContent {...props} />;
}
