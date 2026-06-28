import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import type { NodeOption, ScheduledTask } from '@/types/scheduling';
import { resolveTaskAction, scheduleTargetDescriptor } from '@/lib/scheduledActions';
import { Masthead, SectionHead, StateDot, type Tone } from './mobile-ui';

interface MobileSchedulesProps {
  headerActions: ReactNode;
}

function actionTone(task: ScheduledTask): Tone {
  return resolveTaskAction(task)?.tone ?? 'brand';
}

function actionShortLabel(task: ScheduledTask): string {
  return resolveTaskAction(task)?.shortLabel ?? task.action;
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function relative(ts: number, now: number): string {
  const diff = ts - now;
  if (diff <= 0) return 'now';
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `in ${hours}h` : `in ${hours}h ${rem}m`;
}

function dayLabel(ts: number, now: number): string {
  const d = new Date(ts);
  const n = new Date(now);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOf(d) - startOf(n)) / 86_400_000);
  if (dayDiff <= 0) return 'Today';
  if (dayDiff === 1) return 'Tomorrow';
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

interface UpcomingRun {
  task: ScheduledTask;
  runAt: number;
}

export function MobileSchedules({ headerActions }: MobileSchedulesProps) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [nodes, setNodes] = useState<NodeOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);

  const fetchNodes = useCallback(async () => {
    try {
      const res = await apiFetch('/nodes', { localOnly: true });
      if (!res.ok) {
        console.error('Node poll failed:', res.status);
        return;
      }
      const data = await res.json();
      if (!Array.isArray(data)) {
        console.error('Unexpected /nodes response shape');
        return;
      }
      setNodes((data as { id: number; name: string; type: 'local' | 'remote' }[])
        .map(n => ({ id: n.id, name: n.name, type: n.type })));
    } catch (error) {
      console.error('Failed to fetch nodes:', error);
    }
  }, []);

  const fetchTasks = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const res = await apiFetch('/scheduled-tasks', { localOnly: true, signal: controller.signal });
      if (res.ok) {
        setTasks(await res.json() as ScheduledTask[]);
      } else {
        console.error('Scheduled tasks poll failed:', res.status);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      console.error('Failed to fetch scheduled tasks:', error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // fetchTasks sets state only after an await, so it does not cause the
    // synchronous cascading render this rule guards against; the rule flags the
    // call conservatively because it can't follow the async boundary.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchTasks();
    const id = setInterval(() => void fetchTasks(), 60_000);
    return () => {
      clearInterval(id);
      abortRef.current?.abort();
    };
  }, [fetchTasks]);

  useEffect(() => {
    // Node names rarely change, so fetch once on mount rather than on the poll.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchNodes();
  }, [fetchNodes]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const nodeNameById = useMemo(() => new Map(nodes.map(n => [n.id, n.name])), [nodes]);
  const describeTarget = useCallback(
    (task: ScheduledTask) =>
      scheduleTargetDescriptor(task, task.node_id != null ? nodeNameById.get(task.node_id) : undefined),
    [nodeNameById],
  );

  const enabledCount = tasks.filter(t => t.enabled === 1).length;
  const upcoming: UpcomingRun[] = tasks
    .filter(t => t.enabled === 1 && t.next_runs && t.next_runs.length > 0)
    .flatMap(task => (task.next_runs ?? []).map(runAt => ({ task, runAt })))
    .filter(p => p.runAt >= now)
    .sort((a, b) => a.runAt - b.runAt)
    .slice(0, 60);

  const next = upcoming[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Masthead
        kicker={`schedules · ${enabledCount} active`}
        state={next ? hhmm(next.runAt) : '--:--'}
        stateTone="brand"
        live={false}
        meta={next ? `${relative(next.runAt, now)} · ${actionShortLabel(next.task)} ${describeTarget(next.task)}` : 'nothing scheduled'}
        right={headerActions}
      />

      <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden p-[14px]">
        {loading && tasks.length === 0 ? (
          <div className="flex items-center justify-center py-10 text-stat-subtitle">
            <Loader2 className="h-5 w-5 animate-spin" strokeWidth={1.5} />
          </div>
        ) : upcoming.length === 0 ? (
          <p className="px-1 py-4 font-mono text-[12px] text-stat-subtitle">
            Nothing scheduled. Create a schedule on desktop to automate recurring operations.
          </p>
        ) : (
          upcoming.map((run, i) => {
            const prevDay = i > 0 ? dayLabel(upcoming[i - 1].runAt, now) : null;
            const day = dayLabel(run.runAt, now);
            const tone = actionTone(run.task);
            return (
              <div key={`${run.task.id}-${run.runAt}`}>
                {day !== prevDay ? <SectionHead>{day}</SectionHead> : null}
                <div className="flex items-center gap-2.5 py-2">
                  <span className="w-[46px] shrink-0 font-mono tabular-nums text-[13px] text-stat-value">{hhmm(run.runAt)}</span>
                  <StateDot tone={tone} size={7} glow />
                  <span className="min-w-0 flex-1 truncate font-mono text-[13px] text-stat-subtitle">
                    <span className="text-stat-value">{actionShortLabel(run.task)}</span>{` ${describeTarget(run.task)}`}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-stat-icon">{relative(run.runAt, now)}</span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
