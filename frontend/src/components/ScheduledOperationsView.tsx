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
import type { ScheduledTask, TaskRun, NodeOption } from '@/types/scheduling';
import { getCronDescription, formatTimestamp } from '@/lib/scheduling';

const UPDATE_FLEET_ACTION = 'update-fleet' as const;

const ACTION_OPTIONS: Array<{
  value: string;
  label: string;
  targetType: 'stack' | 'fleet' | 'system';
  backendAction?: 'restart' | 'snapshot' | 'prune' | 'update' | 'scan';
}> = [
  { value: 'restart', label: 'Restart Stack', targetType: 'stack' },
  { value: 'update', label: 'Auto-update Stack', targetType: 'stack' },
  { value: UPDATE_FLEET_ACTION, label: 'Auto-update All Stacks', targetType: 'fleet', backendAction: 'update' },
  { value: 'snapshot', label: 'Fleet Snapshot', targetType: 'fleet' },
  { value: 'prune', label: 'System Prune', targetType: 'system' },
  { value: 'scan', label: 'Vulnerability Scan', targetType: 'system' },
  { value: 'auto_backup', label: 'Backup Stack Files', targetType: 'stack' },
  { value: 'auto_stop', label: 'Stop Stack (keep containers)', targetType: 'stack' },
  { value: 'auto_down', label: 'Take Stack Down (remove containers)', targetType: 'stack' },
  { value: 'auto_start', label: 'Start Stack', targetType: 'stack' },
];

const TIMELINE_LANES: { key: ScheduledTask['action']; label: string; color: string; bg: string; actions: ScheduledTask['action'][] }[] = [
  { key: 'restart', label: 'Restart', color: 'var(--brand)', bg: 'oklch(from var(--brand) l c h / 0.18)', actions: ['restart'] },
  { key: 'update', label: 'Update', color: 'var(--success)', bg: 'oklch(from var(--success) l c h / 0.18)', actions: ['update'] },
  { key: 'scan', label: 'Scan', color: 'var(--label-purple)', bg: 'var(--label-purple-bg)', actions: ['scan'] },
  { key: 'prune', label: 'Prune', color: 'var(--warning)', bg: 'oklch(from var(--warning) l c h / 0.18)', actions: ['prune', 'snapshot'] },
  { key: 'auto_stop', label: 'Lifecycle', color: 'var(--label-blue)', bg: 'var(--label-blue-bg)', actions: ['auto_stop', 'auto_down', 'auto_start', 'auto_backup'] },
];

const TIMELINE_WINDOW_HOURS = 24;
const TIMELINE_WINDOW_MS = TIMELINE_WINDOW_HOURS * 60 * 60 * 1000;

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
  const [formEnabled, setFormEnabled] = useState(true);
  const [formDeleteAfterRun, setFormDeleteAfterRun] = useState(false);
  const [formPruneTargets, setFormPruneTargets] = useState<string[]>(['containers', 'images', 'networks', 'volumes']);
  const [formTargetServices, setFormTargetServices] = useState<string[]>([]);
  const [formPruneLabelFilter, setFormPruneLabelFilter] = useState('');
  const [availableServices, setAvailableServices] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [runningTaskId, setRunningTaskId] = useState<number | null>(null);
  const [runsPage, setRunsPage] = useState(1);
  const [runsTotal, setRunsTotal] = useState(0);
  const runsLimit = 20;

  // Available stacks and nodes for selection
  const [stacks, setStacks] = useState<string[]>([]);
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

  const fetchNodes = useCallback(async () => {
    try {
      const res = await apiFetch('/nodes', { localOnly: true });
      if (res.ok) {
        const data = await res.json();
        setNodes(data.map((n: { id: number; name: string }) => ({ id: n.id, name: n.name })));
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
    if (formAction !== 'restart' || !formTargetId) {
      setAvailableServices([]);
      return;
    }
    let cancelled = false;
    const fetchServices = async () => {
      try {
        const res = await apiFetch(`/stacks/${encodeURIComponent(formTargetId)}/services`);
        if (res.ok && !cancelled) {
          setAvailableServices(await res.json());
        }
      } catch {
        // Non-critical
      }
    };
    fetchServices();
    return () => { cancelled = true; };
  }, [formAction, formTargetId]);

  // Re-fetch stacks when node changes
  useEffect(() => {
    if (!dialogOpen) return;
    if (formNodeId) {
      fetchStacks(formNodeId);
      setFormTargetId('');
    } else {
      setStacks([]);
    }
  }, [formNodeId, dialogOpen, fetchStacks]);

  const openCreate = (prefillData?: { stackName: string; nodeId: string }) => {
    const nodeId = prefillData?.nodeId ?? (filterNodeId != null ? String(filterNodeId) : '');
    setEditingTask(null);
    setFormName('');
    setFormAction(ACTION_OPTIONS[0]?.value ?? 'restart');
    setFormTargetId(prefillData?.stackName ?? '');
    setFormNodeId(nodeId);
    setFormCron('0 3 * * *');
    setFormEnabled(true);
    setFormDeleteAfterRun(false);
    setFormPruneTargets(['containers', 'images', 'networks', 'volumes']);
    setFormTargetServices([]);
    setFormPruneLabelFilter('');
    setDialogOpen(true);
    if (nodeId) fetchStacks(nodeId);
  };

  const openEdit = (task: ScheduledTask) => {
    setEditingTask(task);
    setFormName(task.name);
    setFormAction(task.action === 'update' && task.target_type === 'fleet' ? UPDATE_FLEET_ACTION : task.action);
    setFormTargetId(task.target_id || '');
    setFormNodeId(task.node_id != null ? String(task.node_id) : '');
    setFormCron(task.cron_expression);
    setFormEnabled(task.enabled === 1);
    setFormDeleteAfterRun((task.delete_after_run ?? 0) === 1);
    setFormPruneTargets(
      task.prune_targets ? JSON.parse(task.prune_targets) : ['containers', 'images', 'networks', 'volumes']
    );
    setFormTargetServices(
      task.target_services ? JSON.parse(task.target_services) : []
    );
    setFormPruneLabelFilter(task.prune_label_filter || '');
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const actionOption = ACTION_OPTIONS.find(a => a.value === formAction);
    if (!actionOption) return;

    const body: Record<string, unknown> = {
      name: formName,
      target_type: actionOption.targetType,
      action: actionOption.backendAction ?? formAction,
      cron_expression: formCron,
      enabled: formEnabled,
      delete_after_run: formDeleteAfterRun,
    };

    if (actionOption.targetType === 'stack') {
      body.target_id = formTargetId;
      body.node_id = formNodeId ? parseInt(formNodeId, 10) : null;
    }
    if (formAction === 'scan' || formAction === UPDATE_FLEET_ACTION) {
      body.node_id = formNodeId ? parseInt(formNodeId, 10) : null;
    }
    if (formAction === 'prune' && formPruneTargets.length > 0) {
      body.prune_targets = formPruneTargets;
    }
    if (formAction === 'restart' && formTargetServices.length > 0) {
      body.target_services = formTargetServices;
    }
    if (formAction === 'prune' && formPruneLabelFilter.trim()) {
      body.prune_label_filter = formPruneLabelFilter.trim();
    }

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

  const targetType = ACTION_OPTIONS.find(a => a.value === formAction)?.targetType;
  const cronDescription = getCronDescription(formCron);
  const nodeOptions = useMemo(() => nodes.map(n => ({ value: String(n.id), label: n.name })), [nodes]);
  const isSaveDisabled =
    saving || !formName || !formCron
    || (targetType === 'stack' && (!formTargetId || !formNodeId))
    || (formAction === 'scan' && !formNodeId)
    || (formAction === UPDATE_FLEET_ACTION && !formNodeId)
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
                  <div className="font-display italic text-3xl text-foreground leading-tight">
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
                    {TIMELINE_LANES.map(lane => {
                      const lanePills = timelinePills.filter(p => lane.actions.includes(p.task.action));
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
                              const targetLabel = pill.task.target_type === 'stack'
                                ? pill.task.target_id ?? pill.task.name
                                : pill.task.name;
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
                                  title={`${pill.task.name} · ${formatHourTick(pill.runAt)} · ${targetLabel}`}
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
                        {(task.action === 'update' && task.target_type === 'fleet'
                          ? ACTION_OPTIONS.find(a => a.value === UPDATE_FLEET_ACTION)
                          : ACTION_OPTIONS.find(a => a.value === task.action)
                        )?.label || task.action}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {task.target_type === 'stack'
                        ? task.target_services
                          ? `${task.target_id} (${(JSON.parse(task.target_services) as string[]).join(', ')})`
                          : task.target_id
                        : task.action === 'update'
                          ? 'All eligible stacks'
                          : task.target_type}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{getCronDescription(task.cron_expression)}</div>
                      <div className="text-xs text-muted-foreground font-mono">{task.cron_expression}</div>
                    </TableCell>
                    <TableCell>
                      {task.last_status === 'success' ? (
                        <Badge className="bg-success-muted text-success border-success/20">Success</Badge>
                      ) : task.last_status === 'failure' ? (
                        <Badge variant="destructive">Failed</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">Never run</span>
                      )}
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
                options={ACTION_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
                value={formAction}
                onValueChange={(val) => { setFormAction(val); setFormTargetId(''); setFormNodeId(''); setFormTargetServices([]); setFormPruneLabelFilter(''); }}
                placeholder="Select action..."
              />
            </div>

            {targetType === 'stack' && (
              <>
                <div className="space-y-2">
                  <Label>Node</Label>
                  <Combobox
                    options={nodeOptions}
                    value={formNodeId}
                    onValueChange={setFormNodeId}
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
                {formAction === 'restart' && formTargetId && availableServices.length > 0 && (
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

            {formAction === UPDATE_FLEET_ACTION && (
              <div className="space-y-2">
                <Label>Node</Label>
                <Combobox
                  options={nodeOptions}
                  value={formNodeId}
                  onValueChange={setFormNodeId}
                  placeholder="Select node..."
                />
                <p className="text-xs text-muted-foreground">Every stack on the selected node will be checked and updated when new images are available.</p>
              </div>
            )}

            {formAction === 'scan' && (
              <div className="space-y-2">
                <Label>Node</Label>
                <Combobox
                  options={nodeOptions}
                  value={formNodeId}
                  onValueChange={setFormNodeId}
                  placeholder="Select node..."
                />
                <p className="text-xs text-muted-foreground">Every image on the selected node will be scanned.</p>
              </div>
            )}

            {formAction === 'prune' && (
              <>
                <div className="space-y-2">
                  <Label>Prune Targets</Label>
                  <div className="grid grid-cols-2 gap-2">
                    {['containers', 'images', 'networks', 'volumes'].map(target => (
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
              <Label>Cron Expression</Label>
              <Input
                placeholder="0 3 * * *"
                value={formCron}
                onChange={e => setFormCron(e.target.value)}
                className="font-mono"
              />
              <p className="text-xs text-muted-foreground">{cronDescription}</p>
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
                className="mt-0.5"
              />
              <div>
                <span className="text-sm font-medium">Delete after successful run</span>
                <p className="text-xs text-muted-foreground">Task removes itself after its first successful execution. Failures keep the task so you can retry or debug.</p>
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
