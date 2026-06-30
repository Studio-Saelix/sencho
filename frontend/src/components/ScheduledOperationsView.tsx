import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Modal, ModalHeader, ModalBody, ModalFooter, ConfirmModal } from '@/components/ui/modal';
import { SystemSheet, SheetSection } from '@/components/ui/system-sheet';
import { TogglePill } from '@/components/ui/toggle-pill';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Clock, Plus, Pencil, Trash2, History, RefreshCw, Play, ChevronLeft, ChevronRight, Download, CalendarClock, Table2 } from 'lucide-react';
import { toast } from '@/components/ui/toast-store';
import { apiFetch, fetchForNode } from '@/lib/api';
import { Combobox } from '@/components/ui/combobox';
import { SegmentedControl } from '@/components/ui/segmented-control';
import type { ScheduledTask, TaskRun, NodeOption } from '@/types/scheduling';
import {
  getCronDescription,
  getCronFieldError,
  formatTimestamp,
  buildCron,
  parseCron,
  getSimpleScheduleError,
  getOnceRunAt,
  type SimpleSchedule,
} from '@/lib/scheduling';
import { ScheduleSimplePanel } from './ScheduleSimplePanel';
import { cn } from '@/lib/utils';
import {
  SCHEDULED_ACTIONS,
  SCHEDULED_ACTION_CATEGORIES,
  getActionById,
  resolveTaskAction,
  scheduleTargetDescriptor,
  DEFAULT_SCHEDULED_ACTION_ID,
  RISK_BADGE_CLASSES,
  RISK_DOT_CLASSES,
  RISK_LABEL,
} from '@/lib/scheduledActions';

const DEFAULT_PRUNE_TARGETS = ['containers', 'images', 'networks', 'volumes'];
const DEFAULT_SIMPLE_SCHEDULE: SimpleSchedule = {
  frequency: 'daily', minute: 0, hour: 3, weekdays: [], dayOfMonth: 1, date: null,
};
const TIMELINE_WINDOW_HOURS = 24;
const TIMELINE_WINDOW_MS = TIMELINE_WINDOW_HOURS * 60 * 60 * 1000;

interface ContainerListItem {
  Id: string;
  Names?: string[];
  State?: string;
  Image?: string;
  Labels?: Record<string, string>;
}

function containerDisplayName(c: ContainerListItem): string {
  return c.Names?.[0]?.replace(/^\//, '') || c.Id.slice(0, 12);
}

function formatHourTick(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function formatRelative(ts: number, now: number): string {
  const diff = ts - now;
  if (diff <= 0) return 'now';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins === 0 ? `in ${hours}h` : `in ${hours}h ${remMins}m`;
}

export interface ScheduleTaskPrefill {
  stackName: string;
  nodeId: number | null;
}

interface ScheduledOperationsViewProps {
  filterNodeId?: number | null;
  onClearFilter?: () => void;
  prefill?: ScheduleTaskPrefill | null;
  onPrefillConsumed?: () => void;
}

export default function ScheduledOperationsView({ filterNodeId, onClearFilter, prefill, onPrefillConsumed }: ScheduledOperationsViewProps) {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'timeline' | 'table'>('timeline');
  const [now, setNow] = useState(() => Date.now());
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTask | null>(null);
  const [runsTask, setRunsTask] = useState<ScheduledTask | null>(null);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);

  // Form state
  const [formName, setFormName] = useState('');
  const [formAction, setFormAction] = useState('restart');
  const [formTargetId, setFormTargetId] = useState('');
  const [formNodeId, setFormNodeId] = useState('');
  const [formCron, setFormCron] = useState('0 3 * * *');
  const [scheduleMode, setScheduleMode] = useState<'simple' | 'advanced'>('simple');
  const [simpleSchedule, setSimpleSchedule] = useState<SimpleSchedule>(DEFAULT_SIMPLE_SCHEDULE);
  const [simpleReplacedCron, setSimpleReplacedCron] = useState(false);
  const [formEnabled, setFormEnabled] = useState(true);
  const [formDeleteAfterRun, setFormDeleteAfterRun] = useState(false);
  const [formPruneTargets, setFormPruneTargets] = useState<string[]>(DEFAULT_PRUNE_TARGETS);
  const [formTargetServices, setFormTargetServices] = useState<string[]>([]);
  const [formPruneLabelFilter, setFormPruneLabelFilter] = useState('');
  const [availableServices, setAvailableServices] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [runningTaskId, setRunningTaskId] = useState<number | null>(null);
  const [runsPage, setRunsPage] = useState(1);
  const [runsTotal, setRunsTotal] = useState(0);
  const runsLimit = 20;

  // Available stacks, containers, and nodes for selection
  const [stacks, setStacks] = useState<string[]>([]);
  const [containers, setContainers] = useState<ContainerListItem[]>([]);
  const [nodes, setNodes] = useState<NodeOption[]>([]);

  const filteredTasks = filterNodeId != null
    ? tasks.filter(t => t.node_id === filterNodeId)
    : tasks;
  const filterNodeName = filterNodeId != null
    ? nodes.find(n => n.id === filterNodeId)?.name
    : null;

  const consumedPrefillRef = useRef<ScheduleTaskPrefill | null>(null);

  const fetchTasks = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch('/scheduled-tasks', { localOnly: true });
      if (res.ok) {
        setTasks(await res.json());
      }
    } catch {
      // Non-critical
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchStacks = useCallback(async (nodeId?: string) => {
    try {
      const res = nodeId
        ? await fetchForNode('/stacks', parseInt(nodeId, 10))
        : await apiFetch('/stacks');
      if (res.ok) {
        setStacks(await res.json());
      }
    } catch {
      // Non-critical
    }
  }, []);

  const fetchContainers = useCallback(async (nodeId: string) => {
    try {
      const res = await fetchForNode('/containers?all=true', parseInt(nodeId, 10));
      if (res.ok) {
        setContainers(await res.json());
      } else {
        setContainers([]);
      }
    } catch {
      setContainers([]);
    }
  }, []);

  const fetchNodes = useCallback(async () => {
    try {
      const res = await apiFetch('/nodes', { localOnly: true });
      if (res.ok) {
        const data = await res.json();
        setNodes(data.map((n: { id: number; name: string; type: 'local' | 'remote' }) => ({ id: n.id, name: n.name, type: n.type })));
      }
    } catch {
      // Non-critical
    }
  }, []);

  useEffect(() => {
    fetchTasks();
    fetchStacks();
    fetchNodes();
  }, [fetchTasks, fetchStacks, fetchNodes]);

  useEffect(() => {
    if (!prefill || prefill === consumedPrefillRef.current) return;
    consumedPrefillRef.current = prefill;
    openCreate({ stackName: prefill.stackName, nodeId: prefill.nodeId != null ? String(prefill.nodeId) : '' });
    onPrefillConsumed?.();
  }, [prefill, onPrefillConsumed]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const actionDef = getActionById(formAction);
    if (!actionDef?.supportsServiceSelection || !formTargetId) {
      setAvailableServices([]);
      return;
    }
    let cancelled = false;
    const fetchServices = async () => {
      try {
        // Load services from the selected node so remote-node restart schedules
        // discover the right services instead of the hub's.
        const endpoint = `/stacks/${encodeURIComponent(formTargetId)}/services`;
        const res = formNodeId
          ? await fetchForNode(endpoint, parseInt(formNodeId, 10))
          : await apiFetch(endpoint);
        if (res.ok && !cancelled) {
          setAvailableServices(await res.json());
        }
      } catch {
        // Non-critical
      }
    };
    fetchServices();
    return () => { cancelled = true; };
  }, [formAction, formTargetId, formNodeId]);

  useEffect(() => {
    if (!dialogOpen) return;
    const actionDef = getActionById(formAction);
    if (actionDef?.requiresContainer && formNodeId) {
      fetchContainers(formNodeId);
      fetchStacks(formNodeId);
    } else if (formNodeId) {
      fetchStacks(formNodeId);
      setContainers([]);
    } else {
      setStacks([]);
      setContainers([]);
    }
  }, [formNodeId, formAction, dialogOpen, fetchStacks, fetchContainers]);

  const openCreate = (prefillData?: { stackName: string; nodeId: string }) => {
    const nodeId = prefillData?.nodeId ?? (filterNodeId != null ? String(filterNodeId) : '');
    setEditingTask(null);
    setFormName('');
    setFormAction(DEFAULT_SCHEDULED_ACTION_ID);
    setFormTargetId(prefillData?.stackName ?? '');
    setFormNodeId(nodeId);
    setFormCron('0 3 * * *');
    setScheduleMode('simple');
    setSimpleSchedule(DEFAULT_SIMPLE_SCHEDULE);
    setSimpleReplacedCron(false);
    setFormEnabled(true);
    setFormDeleteAfterRun(false);
    setFormPruneTargets(DEFAULT_PRUNE_TARGETS);
    setFormTargetServices([]);
    setFormPruneLabelFilter('');
    setDialogOpen(true);
    if (nodeId) fetchStacks(nodeId);
  };

  const openEdit = (task: ScheduledTask) => {
    setEditingTask(task);
    setFormName(task.name);
    setFormAction(resolveTaskAction(task)?.id ?? task.action);
    setFormTargetId(task.target_id || '');
    setFormNodeId(task.node_id != null ? String(task.node_id) : '');
    setFormCron(task.cron_expression);
    let parsed = parseCron(task.cron_expression, (task.delete_after_run ?? 0) === 1);
    // The cron has no year field, so parseCron reconstructs a one-shot's date in
    // the current year. Rebuild it from the persisted run_at instead, so editing
    // (and re-saving) preserves the originally chosen instant rather than moving
    // it to this year's occurrence.
    if (parsed && parsed.frequency === 'once' && task.run_at != null) {
      const pinned = new Date(task.run_at);
      parsed = { ...parsed, date: pinned, hour: pinned.getHours(), minute: pinned.getMinutes() };
    }
    setScheduleMode(parsed ? 'simple' : 'advanced');
    setSimpleSchedule(parsed ?? DEFAULT_SIMPLE_SCHEDULE);
    setSimpleReplacedCron(false);
    setFormEnabled(task.enabled === 1);
    setFormDeleteAfterRun((task.delete_after_run ?? 0) === 1);
    setFormPruneTargets(
      task.prune_targets ? JSON.parse(task.prune_targets) : DEFAULT_PRUNE_TARGETS
    );
    setFormTargetServices(
      task.target_services ? JSON.parse(task.target_services) : []
    );
    setFormPruneLabelFilter(task.prune_label_filter || '');
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const actionDef = getActionById(formAction);
    if (!actionDef) {
      toast.error('This scheduled action is no longer supported.');
      return;
    }

    // Re-assert schedule validity at the action, not just via the disabled
    // button, so the cron is never compiled from an invalid simple schedule.
    if (scheduleMode === 'simple') {
      const scheduleError = getSimpleScheduleError(simpleSchedule);
      if (scheduleError) {
        toast.error(scheduleError);
        return;
      }
    }

    // Simple mode compiles its structured fields to the same cron string the
    // backend stores; Advanced mode sends the raw expression as-is.
    const cronExpression = scheduleMode === 'simple' ? buildCron(simpleSchedule) : formCron;

    // A one-time ('once') Simple schedule pins its exact run instant (including
    // year) via run_at, because the 5-field cron cannot encode a year. null for
    // every recurring shape and for Advanced mode, where the cron is authoritative.
    const runAt = scheduleMode === 'simple' ? getOnceRunAt(simpleSchedule) : null;

    const body: Record<string, unknown> = {
      name: formName,
      target_type: actionDef.targetType,
      action: actionDef.backendAction,
      cron_expression: cronExpression,
      enabled: formEnabled,
      delete_after_run: formDeleteAfterRun,
      run_at: runAt,
      target_id: (actionDef.requiresStack || actionDef.requiresContainer) ? formTargetId : null,
      node_id: actionDef.requiresNode && formNodeId ? parseInt(formNodeId, 10) : null,
      prune_targets: formAction === 'prune' && formPruneTargets.length > 0 ? formPruneTargets : null,
      target_services: actionDef.supportsServiceSelection && formTargetServices.length > 0 ? formTargetServices : null,
      prune_label_filter: formAction === 'prune' && formPruneLabelFilter.trim() ? formPruneLabelFilter.trim() : null,
    };

    setSaving(true);
    try {
      const res = editingTask
        ? await apiFetch(`/scheduled-tasks/${editingTask.id}`, { method: 'PUT', body: JSON.stringify(body), localOnly: true })
        : await apiFetch('/scheduled-tasks', { method: 'POST', body: JSON.stringify(body), localOnly: true });

      if (res.ok) {
        toast.success(editingTask ? 'Task updated' : 'Task created');
        setDialogOpen(false);
        fetchTasks();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error || 'Failed to save task');
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Something went wrong.';
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (task: ScheduledTask) => {
    try {
      const res = await apiFetch(`/scheduled-tasks/${task.id}/toggle`, { method: 'PATCH', localOnly: true });
      if (res.ok) {
        fetchTasks();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error || 'Failed to toggle task');
      }
    } catch {
      toast.error('Something went wrong.');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const res = await apiFetch(`/scheduled-tasks/${deleteTarget.id}`, { method: 'DELETE', localOnly: true });
      if (res.ok) {
        toast.success('Task deleted');
        fetchTasks();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error || 'Failed to delete task');
      }
    } catch {
      toast.error('Something went wrong.');
    } finally {
      setDeleteTarget(null);
    }
  };

  const openRuns = async (task: ScheduledTask, page = 1) => {
    setRunsTask(task);
    setRunsPage(page);
    setRunsLoading(true);
    const offset = (page - 1) * runsLimit;
    try {
      const res = await apiFetch(`/scheduled-tasks/${task.id}/runs?limit=${runsLimit}&offset=${offset}`, { localOnly: true });
      if (res.ok) {
        const data = await res.json();
        setRuns(data.runs);
        setRunsTotal(data.total);
      }
    } catch {
      // Non-critical
    } finally {
      setRunsLoading(false);
    }
  };

  const handleRunNow = async (task: ScheduledTask) => {
    setRunningTaskId(task.id);
    try {
      const res = await apiFetch(`/scheduled-tasks/${task.id}/run`, { method: 'POST', localOnly: true });
      if (res.ok) {
        toast.success(`Task "${task.name}" triggered`);
        fetchTasks();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error(data?.error || 'Failed to run task');
      }
    } catch {
      toast.error('Something went wrong.');
    } finally {
      setRunningTaskId(null);
    }
  };

  const currentAction = getActionById(formAction);
  const cronFieldError = getCronFieldError(formCron);
  const simpleCronError = scheduleMode === 'simple' ? getSimpleScheduleError(simpleSchedule) : null;
  // In Advanced mode the saved value is the raw input; in Simple mode it is the
  // compiled cron, short-circuited to '' on a validation error so buildCron is
  // never reached with an invalid (e.g. dateless one-time) schedule.
  const derivedCron = scheduleMode === 'simple'
    ? (simpleCronError ? '' : buildCron(simpleSchedule))
    : formCron;

  // Top-level Simple/Advanced toggle. Advanced -> Simple re-parses the typed
  // cron and pre-fills when it maps to a simple shape, otherwise flags that the
  // custom expression will be replaced. Simple -> Advanced seeds the cron input
  // from what Simple produced so the user keeps what they configured.
  const handleScheduleModeChange = (mode: 'simple' | 'advanced') => {
    if (mode === scheduleMode) return;
    if (mode === 'simple') {
      const parsed = parseCron(formCron, formDeleteAfterRun);
      if (parsed) {
        setSimpleSchedule(parsed);
        setSimpleReplacedCron(false);
      } else {
        setSimpleReplacedCron(true);
      }
    } else {
      if (!simpleCronError) setFormCron(buildCron(simpleSchedule));
      setSimpleReplacedCron(false);
    }
    setScheduleMode(mode);
  };

  // Selecting the one-time frequency defaults delete-after-run on (the only way
  // a fully-pinned cron behaves as a single run). Leaving it does not revert.
  const handleSimpleScheduleChange = (next: SimpleSchedule) => {
    if (next.frequency === 'once' && simpleSchedule.frequency !== 'once') {
      setFormDeleteAfterRun(true);
    }
    setSimpleSchedule(next);
  };
  const nodeOptions = useMemo(() => nodes.map(n => ({ value: String(n.id), label: n.name })), [nodes]);
  const nodeNameById = useMemo(() => new Map(nodes.map(n => [n.id, n.name])), [nodes]);
  const actionOptions = useMemo(
    () =>
      SCHEDULED_ACTIONS.map(o => ({
        value: o.id,
        label: o.label,
        group: SCHEDULED_ACTION_CATEGORIES.find(c => c.key === o.category)?.label,
      })),
    [],
  );
  // Scan and prune run on the hub-local Docker daemon only; remote nodes are excluded from their pickers.
  const localNodeOptions = useMemo(
    () => nodes.filter(n => n.type === 'local').map(n => ({ value: String(n.id), label: n.name })),
    [nodes],
  );
  const currentNodeOptions = currentAction?.nodeScope === 'local' ? localNodeOptions : nodeOptions;
  const containerOptions = useMemo(
    () => containers.map(c => {
      const name = containerDisplayName(c);
      const state = c.State ?? 'unknown';
      const image = (c.Image ?? '').split('@')[0];
      return { value: name, label: `${name} · ${state} · ${image}` };
    }),
    [containers],
  );
  const selectedContainer = useMemo(
    () => containers.find(c => containerDisplayName(c) === formTargetId),
    [containers, formTargetId],
  );
  const selectedContainerStack = selectedContainer?.Labels?.['com.docker.compose.project'];
  const isUnmanagedContainer = !!selectedContainer && (
    !selectedContainerStack || !stacks.includes(selectedContainerStack)
  );
  const scheduleInvalid = scheduleMode === 'simple'
    ? !!simpleCronError
    : (!formCron || !!cronFieldError);
  const isSaveDisabled =
    saving || !currentAction || !formName || scheduleInvalid
    || (!!currentAction?.requiresStack && (!formTargetId || !formNodeId))
    || (!!currentAction?.requiresContainer && (!formTargetId || !formNodeId))
    || (!!currentAction?.requiresNode && !currentAction.requiresStack && !currentAction.requiresContainer && !formNodeId)
    || (formAction === 'prune' && formPruneTargets.length === 0);

  const windowEnd = now + TIMELINE_WINDOW_MS;
  const timelinePills = filteredTasks
    .filter(t => t.enabled === 1 && t.next_runs && t.next_runs.length > 0)
    .flatMap(task => (task.next_runs ?? []).map(runAt => ({ task, runAt })))
    .filter(p => p.runAt >= now && p.runAt <= windowEnd)
    .sort((a, b) => a.runAt - b.runAt);

  const nextPill = timelinePills[0] ?? null;
  const hourTicks = Array.from({ length: 6 }, (_, i) => now + (i / 5) * TIMELINE_WINDOW_MS);
  const windowStartLabel = new Date(now).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const windowEndLabel = new Date(windowEnd).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Clock className="w-5 h-5" strokeWidth={1.5} />
              <CardTitle>Scheduled Operations</CardTitle>
            </div>
            <div className="flex items-center gap-2">
              <div className="inline-flex items-center rounded-md border border-card-border bg-card p-0.5 shadow-btn-glow">
                <Button
                  variant={view === 'timeline' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 px-2.5 gap-1.5"
                  onClick={() => setView('timeline')}
                >
                  <CalendarClock className="w-3.5 h-3.5" strokeWidth={1.5} />
                  <span className="text-xs">Timeline</span>
                </Button>
                <Button
                  variant={view === 'table' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 px-2.5 gap-1.5"
                  onClick={() => setView('table')}
                >
                  <Table2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                  <span className="text-xs">All tasks</span>
                </Button>
              </div>
              <Button variant="outline" size="sm" onClick={fetchTasks} disabled={loading}>
                <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} strokeWidth={1.5} />
                Refresh
              </Button>
              <Button size="sm" onClick={() => openCreate()}>
                <Plus className="w-4 h-4 mr-2" strokeWidth={1.5} />
                New Schedule
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {filterNodeId != null && filterNodeName && (
            <div className="flex items-center gap-2 mb-4 px-1">
              <Badge variant="outline" className="gap-1.5 text-xs">
                Filtered to node: <span className="font-medium">{filterNodeName}</span>
              </Badge>
              <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={onClearFilter}>
                Clear filter
              </Button>
            </div>
          )}
          {view === 'timeline' ? (
            <div className="space-y-5">
              <div className="flex items-end justify-between gap-6 border-b border-card-border pb-4">
                <div>
                  <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-stat-subtitle mb-1">
                    Next 24 hours
                  </div>
                  <div className="font-heading text-3xl text-foreground leading-tight">
                    Next <em className="not-italic text-brand">24 hours</em>
                  </div>
                  <div className="text-xs font-mono text-stat-subtitle mt-1 tabular-nums">
                    {windowStartLabel} {formatHourTick(now)} → {windowEndLabel} {formatHourTick(windowEnd)}
                  </div>
                </div>
                {nextPill ? (
                  <div className="text-right">
                    <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-stat-subtitle mb-1">
                      Next
                    </div>
                    <div className="font-mono tabular-nums text-2xl text-brand leading-tight">
                      {formatHourTick(nextPill.runAt)}
                    </div>
                    <div className="text-xs font-mono text-stat-subtitle mt-1 truncate max-w-[220px]">
                      {nextPill.task.name} · {formatRelative(nextPill.runAt, now)}
                    </div>
                  </div>
                ) : (
                  <div className="text-right">
                    <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-stat-subtitle mb-1">
                      Next
                    </div>
                    <div className="font-mono tabular-nums text-2xl text-stat-subtitle leading-tight">
                      --:--
                    </div>
                    <div className="text-xs font-mono text-stat-subtitle mt-1">
                      Nothing scheduled
                    </div>
                  </div>
                )}
              </div>

              {loading && filteredTasks.length === 0 ? (
                <div className="text-center text-muted-foreground py-12">Loading...</div>
              ) : (
                <div className="relative">
                  <div className="space-y-1.5">
                    {SCHEDULED_ACTION_CATEGORIES.map(lane => {
                      const lanePills = timelinePills.filter(p => resolveTaskAction(p.task)?.category === lane.key);
                      return (
                        <div key={lane.key} className="grid grid-cols-[80px_1fr] items-center gap-3">
                          <div className="flex items-center gap-2">
                            <span
                              className="w-1.5 h-1.5 rounded-full"
                              style={{ backgroundColor: lane.color }}
                              aria-hidden="true"
                            />
                            <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-stat-subtitle">
                              {lane.label}
                            </span>
                          </div>
                          <div
                            className="relative h-8 rounded-md border border-card-border bg-background/40 shadow-[inset_0_1px_2px_0_oklch(0_0_0/0.15)]"
                          >
                            {lanePills.map((pill, idx) => {
                              const leftPct = ((pill.runAt - now) / TIMELINE_WINDOW_MS) * 100;
                              const clamped = Math.max(0, Math.min(100, leftPct));
                              const nodeName = pill.task.node_id != null ? nodeNameById.get(pill.task.node_id) : undefined;
                              const targetLabel = scheduleTargetDescriptor(pill.task, nodeName);
                              const actionLabel = resolveTaskAction(pill.task)?.label ?? pill.task.action;
                              const tooltip = `${actionLabel} · ${pill.task.name} · ${formatHourTick(pill.runAt)}`
                                + (nodeName ? ` · ${nodeName}` : '');
                              return (
                                <button
                                  key={`${pill.task.id}-${idx}-${pill.runAt}`}
                                  type="button"
                                  onClick={() => openRuns(pill.task)}
                                  className="absolute top-1/2 -translate-y-1/2 h-6 px-2 rounded-sm text-[10px] font-mono tabular-nums flex items-center gap-1.5 border transition-transform hover:scale-105 hover:z-10 focus:outline-none focus-visible:ring-1 focus-visible:ring-brand"
                                  style={{
                                    left: `${clamped}%`,
                                    backgroundColor: lane.bg,
                                    borderColor: lane.color,
                                    color: lane.color,
                                    transform: clamped > 90
                                      ? 'translate(-100%, -50%)'
                                      : 'translate(0, -50%)',
                                  }}
                                  title={tooltip}
                                >
                                  <span>{formatHourTick(pill.runAt)}</span>
                                  <span className="opacity-70 max-w-[100px] truncate">{targetLabel}</span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {/* Now rail */}
                  <div
                    className="absolute top-0 bottom-6 w-px pointer-events-none"
                    style={{
                      left: 'calc(80px + 0.75rem)',
                      backgroundColor: 'var(--brand)',
                      boxShadow: '0 0 6px 0 var(--brand), 0 0 2px 0 var(--brand)',
                    }}
                    aria-hidden="true"
                  />
                  {/* Axis ticks */}
                  <div className="grid grid-cols-[80px_1fr] gap-3 mt-3">
                    <div />
                    <div className="relative h-4">
                      {hourTicks.map((ts, i) => {
                        const leftPct = (i / 5) * 100;
                        return (
                          <div
                            key={ts}
                            className="absolute top-0 text-[10px] font-mono tabular-nums text-stat-subtitle"
                            style={{
                              left: `${leftPct}%`,
                              transform: i === 0 ? 'translateX(0)' : i === 5 ? 'translateX(-100%)' : 'translateX(-50%)',
                            }}
                          >
                            {formatHourTick(ts)}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  {timelinePills.length === 0 && (
                    <div className="text-center text-muted-foreground text-sm py-6 mt-2">
                      Nothing scheduled in the next 24 hours. Toggle to All tasks to see every schedule, or create a new one.
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : loading && filteredTasks.length === 0 ? (
            <div className="text-center text-muted-foreground py-12">Loading...</div>
          ) : filteredTasks.length === 0 ? (
            <div className="text-center text-muted-foreground py-12">
              {filterNodeId != null
                ? 'No scheduled tasks for this node. Create one to automate recurring operations.'
                : 'No scheduled tasks yet. Create one to automate recurring operations.'}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Next Run</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTasks.map((task) => (
                  <TableRow key={task.id}>
                    <TableCell className="font-medium">{task.name}</TableCell>
                    <TableCell>
                      <Badge variant="outline">
                        {resolveTaskAction(task)?.label || task.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {task.target_type === 'stack'
                        ? task.target_services
                          ? `${task.target_id} (${(JSON.parse(task.target_services) as string[]).join(', ')})`
                          : task.target_id
                        : task.target_type === 'container'
                          ? task.target_id
                        : task.action === 'update'
                          ? 'All eligible stacks'
                          : task.target_type}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{getCronDescription(task.cron_expression)}</div>
                      <div className="text-xs text-muted-foreground font-mono">{task.cron_expression}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        {task.last_status === 'success' ? (
                          <Badge className="bg-success-muted text-success border-success/20">Success</Badge>
                        ) : task.last_status === 'failure' ? (
                          <Badge variant="destructive">Failed</Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">Never run</span>
                        )}
                        {task.delete_after_run === 1 && (
                          <Badge
                            variant="outline"
                            className="text-[10px] text-muted-foreground"
                            title={
                              task.last_status === 'failure'
                                ? 'One-shot task kept after a failed run so you can retry or debug. Deletes itself after a successful run.'
                                : 'One-shot task. Deletes itself after a successful run.'
                            }
                          >
                            One-shot
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatTimestamp(task.next_run_at)}
                    </TableCell>
                    <TableCell>
                      <TogglePill
                        checked={task.enabled === 1}
                        onChange={() => handleToggle(task)}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => handleRunNow(task)} title="Run now" disabled={runningTaskId === task.id}>
                          <Play className={`w-4 h-4 ${runningTaskId === task.id ? 'animate-pulse' : ''}`} strokeWidth={1.5} />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => openRuns(task)} title="Execution history">
                          <History className="w-4 h-4" strokeWidth={1.5} />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => openEdit(task)} title="Edit">
                          <Pencil className="w-4 h-4" strokeWidth={1.5} />
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(task)} title="Delete" className="text-destructive/60 hover:bg-destructive hover:text-destructive-foreground">
                          <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create/Edit Modal */}
      <Modal open={dialogOpen} onOpenChange={setDialogOpen} size="lg">
        <ModalHeader
          kicker={editingTask ? 'SCHEDULER · EDIT TASK' : 'SCHEDULER · NEW TASK'}
          title={editingTask ? 'Edit scheduled task' : 'New scheduled task'}
          description="Configure a scheduled operation task."
        />
        <ModalBody>
            <div className="space-y-2">
              <Label>Name</Label>
              <Input placeholder="e.g. Nightly stack restart" value={formName} onChange={e => setFormName(e.target.value)} />
            </div>

            <div className="space-y-2">
              <Label>Action</Label>
              <Combobox
                options={actionOptions}
                value={formAction}
                onValueChange={(val) => { setFormAction(val); setFormTargetId(''); setFormNodeId(''); setFormTargetServices([]); setFormPruneLabelFilter(''); }}
                placeholder="Select action..."
              />
              {currentAction && (
                <div className="flex items-start gap-2">
                  <span className={cn(
                    'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium shrink-0 mt-0.5',
                    RISK_BADGE_CLASSES[currentAction.riskLevel],
                  )}>
                    <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', RISK_DOT_CLASSES[currentAction.riskLevel])} />
                    {RISK_LABEL[currentAction.riskLevel]}
                  </span>
                  <p className="text-xs text-muted-foreground">{currentAction.helperText}</p>
                </div>
              )}
            </div>

            {currentAction?.requiresContainer && (
              <>
                <div className="space-y-2">
                  <Label>Node</Label>
                  <Combobox
                    options={nodeOptions}
                    value={formNodeId}
                    onValueChange={(val) => { setFormNodeId(val); setFormTargetId(''); }}
                    placeholder="Select node..."
                  />
                </div>
                <div className="space-y-2">
                  <Label>Container</Label>
                  <Combobox
                    options={containerOptions}
                    value={formTargetId}
                    onValueChange={setFormTargetId}
                    placeholder={formNodeId ? 'Select container...' : 'Select a node first'}
                    disabled={!formNodeId}
                  />
                </div>
                {isUnmanagedContainer && (
                  <p className="text-xs text-muted-foreground">
                    This container is not associated with a Sencho stack. The schedule will target the container by node and name.
                  </p>
                )}
                {selectedContainerStack && stacks.includes(selectedContainerStack) && (
                  <p className="text-xs text-muted-foreground">
                    Part of stack: {selectedContainerStack}
                  </p>
                )}
              </>
            )}

            {currentAction?.requiresStack && (
              <>
                <div className="space-y-2">
                  <Label>Node</Label>
                  <Combobox
                    options={nodeOptions}
                    value={formNodeId}
                    onValueChange={(val) => { setFormNodeId(val); setFormTargetId(''); }}
                    placeholder="Select node..."
                  />
                </div>
                <div className="space-y-2">
                  <Label>Stack</Label>
                  <Combobox
                    options={stacks.map(s => ({ value: s, label: s }))}
                    value={formTargetId}
                    onValueChange={setFormTargetId}
                    placeholder={formNodeId ? "Select stack..." : "Select a node first"}
                    disabled={!formNodeId}
                  />
                </div>
                {currentAction.supportsServiceSelection && formTargetId && availableServices.length > 0 && (
                  <div className="space-y-2">
                    <Label>Services <span className="text-xs text-muted-foreground">(leave empty for all)</span></Label>
                    <div className="grid grid-cols-2 gap-2">
                      {availableServices.map(svc => (
                        <label key={svc} className="flex items-center gap-2 text-sm cursor-pointer">
                          <Checkbox
                            checked={formTargetServices.includes(svc)}
                            onCheckedChange={(checked) => {
                              setFormTargetServices(prev =>
                                checked ? [...prev, svc] : prev.filter(s => s !== svc)
                              );
                            }}
                          />
                          <span className="font-mono text-xs">{svc}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {formAction === 'snapshot' && (
              <div className="space-y-2">
                <Label>Scope</Label>
                <div className="flex h-9 w-full items-center rounded-md border border-glass-border bg-input px-3 text-sm text-muted-foreground">
                  Entire fleet
                </div>
                <p className="text-xs text-muted-foreground">Captures every node's compose and .env files. No node or stack to choose.</p>
              </div>
            )}

            {currentAction?.requiresNode && !currentAction.requiresStack && !currentAction.requiresContainer && (
              <div className="space-y-2">
                <Label>Node</Label>
                <Combobox
                  options={currentNodeOptions}
                  value={formNodeId}
                  onValueChange={setFormNodeId}
                  placeholder="Select node..."
                />
              </div>
            )}

            {formAction === 'prune' && (
              <>
                <div className="space-y-2">
                  <Label>Prune Targets</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {DEFAULT_PRUNE_TARGETS.map(target => (
                      <label key={target} className="flex items-center gap-2 text-sm cursor-pointer">
                        <Checkbox
                          checked={formPruneTargets.includes(target)}
                          onCheckedChange={(checked) => {
                            setFormPruneTargets(prev =>
                              checked ? [...prev, target] : prev.filter(t => t !== target)
                            );
                          }}
                        />
                        {target.charAt(0).toUpperCase() + target.slice(1)}
                      </label>
                    ))}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Label Filter <span className="text-xs text-muted-foreground">(optional)</span></Label>
                  <Input
                    placeholder="e.g. com.docker.compose.project=mystack"
                    value={formPruneLabelFilter}
                    onChange={e => setFormPruneLabelFilter(e.target.value)}
                    className="font-mono text-xs"
                  />
                  <p className="text-xs text-muted-foreground">Only prune resources matching this Docker label.</p>
                </div>
              </>
            )}

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label>Schedule</Label>
                <SegmentedControl<'simple' | 'advanced'>
                  value={scheduleMode}
                  options={[{ value: 'simple', label: 'Simple' }, { value: 'advanced', label: 'Advanced' }]}
                  onChange={handleScheduleModeChange}
                  ariaLabel="Schedule mode"
                />
              </div>
              {scheduleMode === 'simple' ? (
                <>
                  <ScheduleSimplePanel
                    value={simpleSchedule}
                    onChange={handleSimpleScheduleChange}
                    derivedCron={derivedCron}
                    error={simpleCronError}
                  />
                  {simpleReplacedCron && (
                    <p className="text-xs text-muted-foreground">Switching to Simple mode replaces your custom cron expression.</p>
                  )}
                </>
              ) : (
                <>
                  <Input
                    placeholder="0 3 * * *"
                    value={formCron}
                    onChange={e => setFormCron(e.target.value)}
                    className="font-mono"
                  />
                  {cronFieldError
                    ? <p className="text-xs text-destructive">{cronFieldError}</p>
                    : <p className="text-xs text-muted-foreground">{getCronDescription(formCron)}</p>}
                </>
              )}
            </div>

            <div className="flex items-center gap-2">
              <TogglePill checked={formEnabled} onChange={setFormEnabled} id="task-enabled" />
              <Label htmlFor="task-enabled">Enabled</Label>
            </div>

            <label className="flex items-start gap-2 cursor-pointer">
              <Checkbox
                id="task-delete-after-run"
                checked={formDeleteAfterRun}
                onCheckedChange={(checked) => setFormDeleteAfterRun(checked === true)}
                disabled={scheduleMode === 'simple' && simpleSchedule.frequency === 'once'}
                className="mt-0.5"
              />
              <div>
                <span className="text-sm font-medium">Delete after successful run</span>
                <p className="text-xs text-muted-foreground">Task removes itself after its first successful execution. Failures keep the task so you can retry or debug.</p>
                {scheduleMode === 'simple' && simpleSchedule.frequency === 'once' && (
                  <p className="mt-1 text-xs text-muted-foreground">Required for one-time schedules: the task fires on the chosen date, then deletes itself once it succeeds. Cron has no year field, so without this it would repeat on that date every year. A failed run is kept so you can retry.</p>
                )}
              </div>
            </label>
        </ModalBody>
        <ModalFooter
          secondary={
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
          }
          primary={
            <Button onClick={handleSave} disabled={isSaveDisabled}>
              {saving ? 'Saving...' : editingTask ? 'Update' : 'Create'}
            </Button>
          }
        />
      </Modal>

      {/* Delete Confirmation */}
      <ConfirmModal
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        variant="destructive"
        kicker="SCHEDULER · DELETE · IRREVERSIBLE"
        title="Delete scheduled task"
        confirmLabel="Delete"
        onConfirm={handleDelete}
      >
        <p className="text-sm text-stat-subtitle">
          Permanently deletes <span className="font-mono font-medium text-stat-value">{deleteTarget?.name}</span> and all of its execution history.
        </p>
      </ConfirmModal>

      {/* Run History Sheet */}
      <SystemSheet
        open={!!runsTask}
        onOpenChange={(open) => { if (!open) setRunsTask(null); }}
        crumb={['Schedules', runsTask?.name ?? '—', 'Runs']}
        name={runsTask?.name ?? 'Run history'}
        meta={`${runsTotal} run${runsTotal === 1 ? '' : 's'}`}
        secondaryActions={runsTask && runs.length > 0 ? [{
          label: 'Download CSV',
          icon: Download,
          onClick: () => window.open(`/api/scheduled-tasks/${runsTask.id}/runs/export`, '_blank'),
        }] : undefined}
        footerContext={runsTask?.next_run_at ? `Next run ${formatTimestamp(runsTask.next_run_at)}` : undefined}
        size="lg"
      >
        <SheetSection title="Executions" hideHeader>
          {runsLoading ? (
            <div className="text-center text-muted-foreground py-8">Loading...</div>
          ) : runs.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">No executions yet.</div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Duration</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {runs.map((run) => {
                    const duration = run.completed_at && run.started_at
                      ? `${((run.completed_at - run.started_at) / 1000).toFixed(1)}s`
                      : '-';
                    return (
                      <TableRow key={run.id}>
                        <TableCell className="text-xs font-mono text-muted-foreground">
                          {new Date(run.started_at).toLocaleString()}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {run.triggered_by === 'manual' ? 'Manual' : 'Scheduled'}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {run.status === 'success' ? (
                            <Badge className="bg-success-muted text-success border-success/20">Success</Badge>
                          ) : run.status === 'failure' ? (
                            <Badge variant="destructive">Failed</Badge>
                          ) : (
                            <Badge variant="outline">Running</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">{duration}</TableCell>
                        <TableCell className="text-xs text-muted-foreground max-w-[200px] truncate" title={run.output || run.error || ''}>
                          {run.error || run.output || '-'}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {Math.ceil(runsTotal / runsLimit) > 1 && runsTask && (
                <div className="flex items-center justify-between mt-4">
                  <p className="text-sm text-muted-foreground">
                    Page {runsPage} of {Math.ceil(runsTotal / runsLimit)}
                  </p>
                  <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={() => openRuns(runsTask, runsPage - 1)} disabled={runsPage <= 1}>
                      <ChevronLeft className="w-4 h-4" strokeWidth={1.5} />
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => openRuns(runsTask, runsPage + 1)} disabled={runsPage >= Math.ceil(runsTotal / runsLimit)}>
                      <ChevronRight className="w-4 h-4" strokeWidth={1.5} />
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </SheetSection>
      </SystemSheet>
    </div>
  );
}
