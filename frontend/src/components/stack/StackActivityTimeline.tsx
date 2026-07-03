import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Rocket, RefreshCcw, CircleStop, Play, ArrowUp, Activity, Loader2, AlertCircle,
  TriangleAlert, CircleCheck, HeartPulse, HeartCrack,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui/toast-store';
import { apiFetch } from '@/lib/api';
import { formatTimeAgo } from '@/lib/relativeTime';
import type { NotificationItem } from '@/components/dashboard/types';

type ActivityLevel = 'info' | 'warning' | 'error';
const ACTIVITY_LEVELS: readonly string[] = ['info', 'warning', 'error'];

interface SuppressionMatchSnapshot {
  rules: { id: number; name: string }[];
  bellSuppressed: boolean;
  externalSuppressed: boolean;
}

interface ActivityEvent {
  id: number;
  level: ActivityLevel;
  category?: string;
  message: string;
  timestamp: number;
  stack_name?: string;
  actor_username?: string | null;
  suppression_match?: string | SuppressionMatchSnapshot | null;
}

interface StackActivityTimelineProps {
  stackName: string;
  liveEvents?: NotificationItem[];
}

const CATEGORY_ICON: Record<string, LucideIcon> = {
  deploy_success: Rocket,
  stack_restarted: RefreshCcw,
  stack_stopped: CircleStop,
  stack_started: Play,
  image_update_applied: ArrowUp,
  drift_detected: TriangleAlert,
  drift_resolved: CircleCheck,
  update_started: ArrowUp,
  health_gate_passed: HeartPulse,
  health_gate_failed: HeartCrack,
};

const DAY_MS = 86_400_000;
const PAGE_SIZE = 50;
const DAY_BUCKET_REFRESH_MS = 60_000;

const SYSTEM_ACTOR_LABEL: Record<string, string> = {
  'system': 'System',
  'system:autoheal': 'Auto-Heal',
  'system:scheduler': 'Scheduler',
  'system:image-update': 'Image Update',
  'system:docker-events': 'Docker',
  'system:blueprint': 'Blueprint',
  'system:monitor': 'Monitor',
  'system:policy': 'Policy',
};

function formatActor(actor: string): { label: string; isSystem: boolean } {
  const isSystem = actor === 'system' || actor.startsWith('system:');
  return { label: SYSTEM_ACTOR_LABEL[actor] ?? actor, isSystem };
}

function parseSuppressionMatch(raw: ActivityEvent['suppression_match']): SuppressionMatchSnapshot | null {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw) as SuppressionMatchSnapshot;
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.rules)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function suppressionTooltip(match: SuppressionMatchSnapshot): string {
  const names = match.rules.map((r) => r.name).filter(Boolean);
  const ruleText = names.length > 0 ? names.join(', ') : 'Unnamed rule';
  return `Matched rule: ${ruleText}`;
}

function isActivityEvent(value: unknown): value is ActivityEvent {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'number'
    && typeof v.timestamp === 'number'
    && typeof v.message === 'string'
    && typeof v.level === 'string'
    && ACTIVITY_LEVELS.includes(v.level);
}

function dayLabel(ts: number, now: number): 'Today' | 'Yesterday' | 'Earlier' {
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const todayMs = todayStart.getTime();
  if (ts >= todayMs) return 'Today';
  if (ts >= todayMs - DAY_MS) return 'Yesterday';
  return 'Earlier';
}

function groupEvents(events: ActivityEvent[], now: number): { label: string; events: ActivityEvent[] }[] {
  const groups: Record<string, ActivityEvent[]> = {};
  const order: string[] = [];
  for (const e of events) {
    const label = dayLabel(e.timestamp, now);
    if (!groups[label]) { groups[label] = []; order.push(label); }
    groups[label].push(e);
  }
  return order.map(label => ({ label, events: groups[label] }));
}

export function StackActivityTimeline({ stackName, liveEvents }: StackActivityTimelineProps) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [liveDisconnected, setLiveDisconnected] = useState(false);
  const seenIdsRef = useRef(new Set<number>());

  const mergeEvents = useCallback((incoming: ActivityEvent[]) => {
    setEvents(prev => {
      const next = [...prev];
      let added = false;
      for (const e of incoming) {
        if (seenIdsRef.current.has(e.id)) continue;
        seenIdsRef.current.add(e.id);
        next.push(e);
        added = true;
      }
      if (!added) return prev;
      next.sort((a, b) => b.timestamp - a.timestamp || b.id - a.id);
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    seenIdsRef.current = new Set();
    setEvents([]);
    setHasMore(true);

    apiFetch(`/stacks/${stackName}/activity?limit=${PAGE_SIZE + 1}`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ events: ActivityEvent[] }>;
      })
      .then(data => {
        if (cancelled) return;
        const more = data.events.length > PAGE_SIZE;
        const trimmed = more ? data.events.slice(0, PAGE_SIZE) : data.events;
        setHasMore(more);
        trimmed.forEach(e => seenIdsRef.current.add(e.id));
        setEvents(trimmed);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        setHasMore(false);
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [stackName, reloadKey]);

  useEffect(() => {
    if (!liveEvents || liveEvents.length === 0) return;
    const safe = liveEvents.filter(isActivityEvent);
    if (safe.length === 0) return;
    mergeEvents(safe);
  }, [liveEvents, mergeEvents]);

  useEffect(() => {
    // Skip the day-bucket refresh while the tab is hidden so a backgrounded
    // panel does not re-render every minute for no visible effect.
    const id = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      setNow(Date.now());
    }, DAY_BUCKET_REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    // Upstream useNotifications dispatches this event when its WebSocket
    // flips. A single layout-level listener keeps the timeline honest about
    // whether new events would actually arrive.
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ connected: boolean }>).detail;
      setLiveDisconnected(detail?.connected === false);
    };
    window.addEventListener('sencho:notifications-connection', handler);
    return () => window.removeEventListener('sencho:notifications-connection', handler);
  }, []);

  const loadMore = useCallback(async () => {
    const oldestEvent = events[events.length - 1];
    if (!oldestEvent) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({
        limit: String(PAGE_SIZE + 1),
        before: String(oldestEvent.timestamp),
        beforeId: String(oldestEvent.id),
      });
      const r = await apiFetch(`/stacks/${stackName}/activity?${params.toString()}`);
      if (!r.ok) {
        toast.error('Failed to load more activity');
        // 5xx is likely server-side; stop offering a button that keeps failing.
        if (r.status >= 500) setHasMore(false);
        return;
      }
      const data: { events: ActivityEvent[] } = await r.json();
      const more = data.events.length > PAGE_SIZE;
      const trimmed = more ? data.events.slice(0, PAGE_SIZE) : data.events;
      setHasMore(more);
      mergeEvents(trimmed);
    } catch (err) {
      console.error('[StackActivity] loadMore failed:', err);
      toast.error('Failed to load more activity');
      setHasMore(false);
    } finally {
      setLoadingMore(false);
    }
  }, [events, stackName, mergeEvents]);

  const groups = useMemo(() => groupEvents(events, now), [events, now]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error && events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-2">
        <AlertCircle className="w-5 h-5 text-destructive/60" />
        <span className="font-mono text-[11px] text-muted-foreground">Activity unavailable</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 font-mono text-[10px]"
          onClick={() => setReloadKey(k => k + 1)}
        >
          Retry
        </Button>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 gap-2">
        <Activity className="w-5 h-5 text-muted-foreground/40" />
        <span className="font-mono text-[11px] text-muted-foreground">No activity recorded yet</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 py-3">
      {liveDisconnected && (
        <div
          role="status"
          className="font-mono text-[10px] text-stat-subtitle italic px-1"
        >
          Live updates offline; reconnecting…
        </div>
      )}
      {groups.map(g => (
        <div key={g.label} role="list" aria-label={`Stack activity, ${g.label}`}>
          <div className="font-mono text-[9px] uppercase tracking-[0.18em] text-stat-subtitle mb-1.5 px-1">{g.label}</div>
          {g.events.map(e => {
            const Icon = CATEGORY_ICON[e.category ?? ''] ?? Activity;
            const actor = e.actor_username ? formatActor(e.actor_username) : null;
            const suppression = parseSuppressionMatch(e.suppression_match);
            const showSuppressed = Boolean(
              suppression && (suppression.bellSuppressed || suppression.externalSuppressed),
            );
            return (
              <div
                key={e.id}
                role="listitem"
                className="flex items-start gap-2 py-1.5 px-1 rounded-md hover:bg-glass-highlight/30 transition-colors"
              >
                <Icon className="w-3 h-3 mt-0.5 shrink-0 text-brand/70" strokeWidth={1.5} />
                <div className="flex-1 min-w-0">
                  <span className="font-mono text-[11px] text-foreground/90">{e.message}</span>
                  {actor && (
                    <span className={`ml-1.5 font-mono text-[10px] text-stat-subtitle${actor.isSystem ? ' italic' : ''}`}>
                      {actor.isSystem ? `via ${actor.label}` : `by ${actor.label}`}
                    </span>
                  )}
                  {showSuppressed && suppression && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Badge variant="outline" className="ml-1.5 align-middle text-[9px] font-mono uppercase tracking-wide px-1 py-0 h-4">
                          Suppressed
                        </Badge>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="font-mono text-[10px] max-w-xs">
                        {suppressionTooltip(suppression)}
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
                <span className="font-mono text-[10px] text-stat-subtitle shrink-0">{formatTimeAgo(e.timestamp)}</span>
              </div>
            );
          })}
        </div>
      ))}
      {hasMore && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full h-7 font-mono text-[10px] text-muted-foreground"
          onClick={() => void loadMore()}
          disabled={loadingMore}
        >
          {loadingMore ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Load more'}
        </Button>
      )}
    </div>
  );
}
