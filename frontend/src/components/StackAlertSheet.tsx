import { useState, useEffect } from 'react';
import { SystemSheet, SheetSection } from '@/components/ui/system-sheet';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Combobox } from '@/components/ui/combobox';
import { TogglePill } from '@/components/ui/toggle-pill';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Trash2, HelpCircle, AlertTriangle, Info, CheckCircle2, Loader2, ChevronDown, ChevronUp } from 'lucide-react';
import { toast } from '@/components/ui/toast-store';
import { apiFetch } from '@/lib/api';
import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';

interface StackAlert {
    id?: number;
    stack_name: string;
    metric: string;
    operator: string;
    threshold: number;
    duration_mins: number;
    cooldown_mins: number;
}

interface AutoHealPolicy {
    id?: number;
    node_id: number;
    proxy_entitled_until: number;
    stack_name: string;
    service_name: string | null;
    unhealthy_duration_mins: number;
    cooldown_mins: number;
    max_restarts_per_hour: number;
    auto_disable_after_failures: number;
    enabled: number;
    consecutive_failures: number;
    last_fired_at: number;
    created_at: number;
    updated_at: number;
}

interface AutoHealHistoryEntry {
    id?: number;
    policy_id: number;
    stack_name: string;
    service_name: string | null;
    container_name: string;
    container_id: string;
    action: 'restarted' | 'skipped_user_action' | 'skipped_cooldown' | 'skipped_rate_limit' | 'failed' | 'policy_auto_disabled' | 'docker_unavailable';
    reason: string;
    success: number;
    error: string | null;
    timestamp: number;
}

type MonitorTab = 'alerts' | 'auto-heal';

interface StackAlertSheetProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    stackName: string;
    initialTab?: MonitorTab;
}

interface AgentStatus {
    loading: boolean;
    hasEnabled: boolean;
    enabledTypes: string[];
}

const metricOptions = [
    { value: 'cpu_percent', label: 'CPU Usage (%)' },
    { value: 'memory_percent', label: 'Memory Usage (%)' },
    { value: 'memory_mb', label: 'Memory Usage (MB)' },
    { value: 'net_rx', label: 'Network In (MB/s)' },
    { value: 'net_tx', label: 'Network Out (MB/s)' },
    { value: 'restart_count', label: 'Restart Count' },
];

const operatorOptions = [
    { value: '>', label: 'Greater than' },
    { value: '>=', label: 'Greater or eq' },
    { value: '<', label: 'Less than' },
    { value: '<=', label: 'Less or eq' },
    { value: '==', label: 'Equals' },
];

const metricLabels: Record<string, string> = Object.fromEntries(metricOptions.map(o => [o.value, o.label]));

const agentTypeLabels: Record<string, string> = {
    discord: 'Discord',
    slack: 'Slack',
    webhook: 'Webhook',
};

const clampNonNegative = (setter: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    let val = e.target.value;
    if (val !== '' && Number(val) < 0) val = '0';
    setter(val);
};

function actionColorClass(action: AutoHealHistoryEntry['action']): string {
    if (action === 'restarted') return 'text-success';
    if (action === 'failed' || action === 'policy_auto_disabled') return 'text-destructive';
    return 'text-muted-foreground';
}

function actionLabel(action: AutoHealHistoryEntry['action']): string {
    switch (action) {
        case 'restarted': return 'Restarted';
        case 'skipped_user_action': return 'Skipped (user action)';
        case 'skipped_cooldown': return 'Skipped (cooldown)';
        case 'skipped_rate_limit': return 'Skipped (rate limit)';
        case 'failed': return 'Failed';
        case 'policy_auto_disabled': return 'Auto-disabled';
        case 'docker_unavailable': return 'Docker unavailable';
    }
}

export function StackAlertSheet({ open, onOpenChange, stackName, initialTab = 'alerts' }: StackAlertSheetProps) {
    const [activeTab, setActiveTab] = useState<MonitorTab>(initialTab);

    useEffect(() => {
        if (open) setActiveTab(initialTab);
    }, [open, initialTab, stackName]);

    const tabs = [
        { id: 'alerts', label: 'Alerts' },
        { id: 'auto-heal', label: 'Auto-heal' },
    ];

    return (
        <SystemSheet
            open={open}
            onOpenChange={onOpenChange}
            crumb={['Stack', stackName || '—', 'Monitor']}
            name={stackName || 'Stack monitor'}
            meta={activeTab === 'alerts' ? 'Alert rules' : 'Auto-heal policies'}
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(id) => setActiveTab(id as MonitorTab)}
            size="md"
        >
            {activeTab === 'alerts' && <AlertsTab stackName={stackName} />}
            {activeTab === 'auto-heal' && <AutoHealTab stackName={stackName} open={open} />}
        </SystemSheet>
    );
}

function AlertsTab({ stackName }: { stackName: string }) {
    const { isAdmin } = useAuth();
    const { activeNode } = useNodes();
    const isRemote = activeNode?.type === 'remote';

    const [alerts, setAlerts] = useState<StackAlert[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
    const [agentStatus, setAgentStatus] = useState<AgentStatus>({
        loading: false,
        hasEnabled: false,
        enabledTypes: [],
    });

    const [metric, setMetric] = useState('cpu_percent');
    const [operator, setOperator] = useState('>');
    const [threshold, setThreshold] = useState('');
    const [duration, setDuration] = useState('5');
    const [cooldown, setCooldown] = useState('60');

    useEffect(() => {
        if (!stackName) return;
        fetchAlerts();
        fetchAgentStatus();
    }, [stackName]); // eslint-disable-line react-hooks/exhaustive-deps

    const fetchAlerts = async () => {
        try {
            const res = await apiFetch(`/alerts?stackName=${encodeURIComponent(stackName)}`);
            if (res.ok) {
                const data = await res.json();
                setAlerts(data);
            }
        } catch (e) {
            console.error('[StackAlertSheet] Failed to fetch alerts', e);
        }
    };

    const fetchAgentStatus = async () => {
        setAgentStatus(prev => ({ ...prev, loading: true }));
        try {
            const res = await apiFetch('/agents');
            if (res.ok) {
                const agents: Array<{ type: string; enabled: boolean }> = await res.json();
                const enabled = agents.filter(a => a.enabled);
                setAgentStatus({
                    loading: false,
                    hasEnabled: enabled.length > 0,
                    enabledTypes: enabled.map(a => a.type),
                });
            } else {
                setAgentStatus({ loading: false, hasEnabled: false, enabledTypes: [] });
            }
        } catch (e) {
            console.error('[StackAlertSheet] Failed to fetch agent status', e);
            setAgentStatus({ loading: false, hasEnabled: false, enabledTypes: [] });
        }
    };

    const addAlert = async () => {
        if (!threshold) {
            toast.error('Please enter a threshold.');
            return;
        }
        setIsLoading(true);
        const newAlert = {
            stack_name: stackName,
            metric,
            operator,
            threshold: parseFloat(threshold),
            duration_mins: parseInt(duration, 10),
            cooldown_mins: parseInt(cooldown, 10),
        };
        try {
            const res = await apiFetch('/alerts', {
                method: 'POST',
                body: JSON.stringify(newAlert),
            });
            if (res.ok) {
                toast.success('Alert rule added.');
                setThreshold('');
                fetchAlerts();
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Failed to add alert rule.');
                console.error('[StackAlertSheet] addAlert failed:', err);
            }
        } catch (e) {
            console.error('[StackAlertSheet] addAlert threw:', e);
            toast.error('Network error. Could not reach the node.');
        } finally {
            setIsLoading(false);
        }
    };

    const deleteAlert = async (id: number) => {
        setIsLoading(true);
        try {
            const res = await apiFetch(`/alerts/${id}`, { method: 'DELETE' });
            if (res.ok) {
                toast.success('Alert rule deleted.');
                fetchAlerts();
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || 'Failed to delete alert rule.');
            }
        } catch {
            toast.error('Network error. Could not reach the node.');
        } finally {
            setIsLoading(false);
        }
    };

    const renderAgentStatusBanner = () => {
        if (agentStatus.loading) {
            return (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50 border text-sm text-stat-subtitle">
                    <Loader2 className="h-4 w-4 animate-spin shrink-0" />
                    <span>Checking notification channels...</span>
                </div>
            );
        }

        if (isRemote) {
            return (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-brand/8 border border-brand/20 text-sm">
                    <Info className="h-4 w-4 text-brand shrink-0 mt-0.5" strokeWidth={1.5} />
                    <div className="space-y-0.5">
                        <p className="font-medium text-brand">
                            Remote node: <span className="font-medium">{activeNode?.name}</span>
                        </p>
                        <p className="text-muted-foreground">
                            Alert rules are stored and evaluated on this remote instance. Notifications are dispatched using that node's configured channels.
                        </p>
                        {!agentStatus.hasEnabled && (
                            <p className="text-warning font-medium mt-1">
                                No notification channels are configured on this remote node. Open Settings &rarr; Notifications to configure them.
                            </p>
                        )}
                        {agentStatus.hasEnabled && (
                            <p className="text-success font-medium mt-1">
                                Active channels: {agentStatus.enabledTypes.map(t => agentTypeLabels[t] ?? t).join(', ')}
                            </p>
                        )}
                    </div>
                </div>
            );
        }

        if (!agentStatus.hasEnabled) {
            return (
                <div className="flex items-start gap-2 p-3 rounded-lg bg-warning-muted border border-warning/20 text-sm">
                    <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" strokeWidth={1.5} />
                    <div>
                        <p className="font-medium text-warning">No notification channels configured</p>
                        <p className="text-muted-foreground mt-0.5">
                            Alert rules will be saved and evaluated, but no notifications will be dispatched. Configure Discord, Slack, or a webhook in{' '}
                            <span className="font-medium">Settings &rarr; Notifications</span>.
                        </p>
                    </div>
                </div>
            );
        }

        return (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-success-muted border border-success/20 text-sm">
                <CheckCircle2 className="h-4 w-4 text-success shrink-0" strokeWidth={1.5} />
                <div>
                    <p className="font-medium text-success">
                        Notifications active via {agentStatus.enabledTypes.map(t => agentTypeLabels[t] ?? t).join(', ')}
                    </p>
                </div>
            </div>
        );
    };

    return (
        <TooltipProvider>
            <SheetSection title="Notification channels">
                {renderAgentStatusBanner()}
            </SheetSection>

            <SheetSection title="Active rules">
                {alerts.length === 0 ? (
                    <div className="text-sm text-muted-foreground text-center py-4">
                        No active alert rules for this stack.
                    </div>
                ) : (
                    <div className="space-y-2">
                        {alerts.map(alert => (
                            <div key={alert.id} className="flex justify-between items-start gap-2 py-2 border-b border-card-border/40 last:border-b-0 text-sm">
                                <div>
                                    <span className="font-medium text-foreground">
                                        {metricLabels[alert.metric] || alert.metric} {alert.operator} {alert.threshold}
                                    </span>
                                    <div className="text-muted-foreground text-xs mt-0.5">
                                        Trigger after {alert.duration_mins}m &bull; Cooldown {alert.cooldown_mins}m
                                    </div>
                                </div>
                                {isAdmin && (
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                                        onClick={() => alert.id && setConfirmDeleteId(alert.id)}
                                        disabled={isLoading}
                                    >
                                        <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                                    </Button>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </SheetSection>

            {isAdmin && (
                <SheetSection title="Add new rule">
                    <div className="space-y-3">
                        <div className="space-y-2">
                            <div className="flex items-center gap-2">
                                <Label>Metric</Label>
                                <Tooltip>
                                    <TooltipTrigger asChild>
                                        <HelpCircle className="h-4 w-4 text-muted-foreground cursor-help" strokeWidth={1.5} />
                                    </TooltipTrigger>
                                    <TooltipContent>
                                        <p className="max-w-[200px] text-sm">The system resource or metric to monitor. Select from CPU, Memory, Network I/O, or Restarts.</p>
                                    </TooltipContent>
                                </Tooltip>
                            </div>
                            <Combobox
                                options={metricOptions}
                                value={metric}
                                onValueChange={setMetric}
                                placeholder="Select metric..."
                                searchPlaceholder="Search metrics..."
                            />
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-2">
                                <Label>Operator</Label>
                                <Combobox
                                    options={operatorOptions}
                                    value={operator}
                                    onValueChange={setOperator}
                                    placeholder="Select operator..."
                                />
                            </div>
                            <div className="space-y-2">
                                <Label>Threshold</Label>
                                <Input
                                    type="number"
                                    min={0}
                                    value={threshold}
                                    onChange={clampNonNegative(setThreshold)}
                                    placeholder="e.g. 90"
                                />
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-2">
                                <Label>Duration (mins)</Label>
                                <Input
                                    type="number"
                                    min={0}
                                    value={duration}
                                    onChange={clampNonNegative(setDuration)}
                                />
                            </div>
                            <div className="space-y-2">
                                <Label>Cooldown (mins)</Label>
                                <Input
                                    type="number"
                                    min={0}
                                    value={cooldown}
                                    onChange={clampNonNegative(setCooldown)}
                                />
                            </div>
                        </div>

                        <Button className="w-full mt-2" onClick={addAlert} disabled={isLoading}>
                            {isLoading ? (
                                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving...</>
                            ) : (
                                'Add Rule'
                            )}
                        </Button>
                    </div>
                </SheetSection>
            )}

            <AlertDialog open={!!confirmDeleteId} onOpenChange={(open) => !open && setConfirmDeleteId(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete Alert Rule</AlertDialogTitle>
                        <AlertDialogDescription>
                            This will permanently remove this alert rule. Notifications for this condition will no longer be sent.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                            onClick={() => { if (confirmDeleteId) deleteAlert(confirmDeleteId); setConfirmDeleteId(null); }}
                        >
                            Delete
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </TooltipProvider>
    );
}

function AutoHealTab({ stackName, open }: { stackName: string; open: boolean }) {
    const { isAdmin } = useAuth();
    const [policies, setPolicies] = useState<AutoHealPolicy[]>([]);
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [deleting, setDeleting] = useState(false);
    const [serviceOptions, setServiceOptions] = useState<{ value: string; label: string }[]>([]);

    const [service, setService] = useState('');
    const [unhealthyFor, setUnhealthyFor] = useState('5');
    const [cooldown, setCooldown] = useState('5');
    const [maxRestarts, setMaxRestarts] = useState('3');
    const [autoDisableAfter, setAutoDisableAfter] = useState('5');

    useEffect(() => {
        if (!open || !stackName) return;
        setLoading(true);
        apiFetch(`/auto-heal/policies?stackName=${encodeURIComponent(stackName)}`)
            .then(res => res.json() as Promise<AutoHealPolicy[]>)
            .then(data => setPolicies(data))
            .catch(() => toast.error('Failed to load auto-heal policies.'))
            .finally(() => setLoading(false));

        apiFetch(`/stacks/${encodeURIComponent(stackName)}/services`)
            .then(res => res.json() as Promise<string[]>)
            .then(names => setServiceOptions(names.map(n => ({ value: n, label: n }))))
            .catch(() => { /* services list is optional, silently skip */ });
    }, [open, stackName]);

    const handleToggle = async (id: number, enabled: boolean) => {
        setSaving(true);
        try {
            const res = await apiFetch(`/auto-heal/policies/${id}`, {
                method: 'PATCH',
                body: JSON.stringify({ enabled: enabled ? 1 : 0 }),
            });
            if (res.ok) {
                setPolicies(prev =>
                    prev.map(p => p.id === id ? { ...p, enabled: enabled ? 1 : 0 } : p)
                );
            } else {
                const err = await res.json().catch(() => ({})) as Record<string, unknown>;
                toast.error((err?.message as string) || (err?.error as string) || 'Failed to update policy.');
            }
        } catch (e) {
            console.error('[StackAlertSheet] Failed to toggle policy:', e);
            toast.error('Network error. Could not reach the node.');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (id: number) => {
        setDeleting(true);
        try {
            const res = await apiFetch(`/auto-heal/policies/${id}`, { method: 'DELETE' });
            if (res.ok) {
                toast.success('Policy deleted.');
                setPolicies(prev => prev.filter(p => p.id !== id));
            } else {
                const err = await res.json().catch(() => ({})) as Record<string, unknown>;
                toast.error((err?.message as string) || (err?.error as string) || 'Failed to delete policy.');
            }
        } catch (e) {
            console.error('[StackAlertSheet] Failed to delete policy:', e);
            toast.error('Network error. Could not reach the node.');
        } finally {
            setDeleting(false);
        }
    };

    const handleAddPolicy = async () => {
        setSaving(true);
        const body = {
            stack_name: stackName,
            service_name: service === '' ? null : service,
            unhealthy_duration_mins: parseInt(unhealthyFor, 10) || 5,
            cooldown_mins: parseInt(cooldown, 10) || 5,
            max_restarts_per_hour: parseInt(maxRestarts, 10) || 3,
            auto_disable_after_failures: parseInt(autoDisableAfter, 10) || 5,
        };
        try {
            const res = await apiFetch('/auto-heal/policies', {
                method: 'POST',
                body: JSON.stringify(body),
            });
            if (res.ok) {
                toast.success('Policy added.');
                setService('');
                setUnhealthyFor('5');
                setCooldown('5');
                setMaxRestarts('3');
                setAutoDisableAfter('5');
                apiFetch(`/auto-heal/policies?stackName=${encodeURIComponent(stackName)}`)
                    .then(res => res.json() as Promise<AutoHealPolicy[]>)
                    .then(data => setPolicies(data))
                    .catch(() => toast.error('Failed to reload policies.'));
            } else {
                const err = await res.json().catch(() => ({})) as Record<string, unknown>;
                toast.error((err?.message as string) || (err?.error as string) || 'Failed to add policy.');
                console.error('[StackAlertSheet] addPolicy failed:', err);
            }
        } catch (e) {
            console.error('[StackAlertSheet] addPolicy threw:', e);
            toast.error('Network error. Could not reach the node.');
        } finally {
            setSaving(false);
        }
    };

    const serviceComboOptions = [
        { value: '', label: 'All services' },
        ...serviceOptions,
    ];

    return (
        <>
            <SheetSection title="Active policies">
                {loading ? (
                    <div className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
                        <span>Loading policies...</span>
                    </div>
                ) : policies.length === 0 ? (
                    <div className="text-sm text-muted-foreground text-center py-4">
                        No auto-heal policies configured for this stack.
                    </div>
                ) : (
                    <div className="space-y-2">
                        {policies.map(policy => (
                            <PolicyRow
                                key={policy.id}
                                policy={policy}
                                onDelete={handleDelete}
                                onToggle={handleToggle}
                                deleting={deleting}
                                saving={saving}
                                isAdmin={isAdmin}
                            />
                        ))}
                    </div>
                )}
            </SheetSection>

            {isAdmin && (
            <SheetSection title="Add new policy">
                <div className="space-y-3">
                    <div className="space-y-2">
                        <Label>Service</Label>
                        <Combobox
                            options={serviceComboOptions}
                            value={service}
                            onValueChange={setService}
                            placeholder="All services"
                            searchPlaceholder="Search services..."
                            emptyText="No services found."
                        />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                            <Label htmlFor="unhealthy-duration">Unhealthy for (minutes)</Label>
                            <Input
                                id="unhealthy-duration"
                                type="text"
                                inputMode="numeric"
                                value={unhealthyFor}
                                onChange={clampNonNegative(setUnhealthyFor)}
                                placeholder="5"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="cooldown">Cooldown (minutes)</Label>
                            <Input
                                id="cooldown"
                                type="text"
                                inputMode="numeric"
                                value={cooldown}
                                onChange={clampNonNegative(setCooldown)}
                                placeholder="5"
                            />
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-2">
                            <Label htmlFor="max-restarts">Max restarts / hr</Label>
                            <Input
                                id="max-restarts"
                                type="text"
                                inputMode="numeric"
                                value={maxRestarts}
                                onChange={clampNonNegative(setMaxRestarts)}
                                placeholder="3"
                            />
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="auto-disable">Auto-disable after (failures)</Label>
                            <Input
                                id="auto-disable"
                                type="text"
                                inputMode="numeric"
                                value={autoDisableAfter}
                                onChange={clampNonNegative(setAutoDisableAfter)}
                                placeholder="5"
                            />
                        </div>
                    </div>

                    <Button
                        className="w-full mt-2"
                        onClick={handleAddPolicy}
                        disabled={saving}
                    >
                        {saving ? (
                            <><Loader2 className="h-4 w-4 mr-2 animate-spin" strokeWidth={1.5} />Saving...</>
                        ) : (
                            'Add Policy'
                        )}
                    </Button>
                </div>
            </SheetSection>
            )}
        </>
    );
}

interface PolicyRowProps {
    policy: AutoHealPolicy;
    onDelete: (id: number) => void;
    onToggle: (id: number, enabled: boolean) => void;
    deleting: boolean;
    saving: boolean;
    isAdmin: boolean;
}

function PolicyRow({ policy, onDelete, onToggle, deleting, saving, isAdmin }: PolicyRowProps) {
    const [historyOpen, setHistoryOpen] = useState(false);
    const [history, setHistory] = useState<AutoHealHistoryEntry[]>([]);
    const [loadingHistory, setLoadingHistory] = useState(false);

    const toggleHistory = async () => {
        if (!historyOpen && history.length === 0 && policy.id != null) {
            setLoadingHistory(true);
            try {
                const res = await apiFetch(`/auto-heal/policies/${policy.id}/history`);
                if (res.ok) {
                    const data: AutoHealHistoryEntry[] = await res.json();
                    setHistory(data);
                } else {
                    const err = await res.json().catch(() => ({})) as Record<string, unknown>;
                    toast.error((err?.message as string) || (err?.error as string) || 'Failed to load history.');
                }
            } catch (e) {
                console.error('[StackAlertSheet] Failed to fetch history:', e);
                toast.error('Network error. Could not reach the node.');
            } finally {
                setLoadingHistory(false);
            }
        }
        setHistoryOpen(prev => !prev);
    };

    return (
        <div className="flex flex-col gap-0 border-b border-card-border/40 last:border-b-0 text-sm py-2">
            <div className="flex items-center justify-between gap-2">
                <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="font-mono text-foreground truncate">
                        {policy.service_name ?? <span className="text-muted-foreground font-sans">All services</span>}
                    </span>
                    <span className="text-muted-foreground text-xs">
                        Unhealthy for {policy.unhealthy_duration_mins} min
                        &bull; Cooldown: {policy.cooldown_mins} min
                        &bull; Max {policy.max_restarts_per_hour}/hr
                    </span>
                    {policy.consecutive_failures > 0 && (
                        <span className="inline-flex items-center gap-1 mt-0.5">
                            <span className="px-1.5 py-0.5 rounded text-xs font-mono tabular-nums text-destructive bg-destructive/10 border border-destructive/20">
                                {policy.consecutive_failures} failure{policy.consecutive_failures !== 1 ? 's' : ''}
                            </span>
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {isAdmin && (
                        <TogglePill
                            checked={policy.enabled === 1}
                            onChange={(checked) => policy.id != null && onToggle(policy.id, checked)}
                            disabled={saving}
                            aria-label={`Toggle policy for ${policy.service_name ?? 'all services'}`}
                        />
                    )}
                    <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-muted-foreground hover:text-foreground"
                        onClick={toggleHistory}
                        aria-label="Toggle history"
                        disabled={loadingHistory}
                    >
                        {loadingHistory ? (
                            <Loader2 className="h-4 w-4 animate-spin" strokeWidth={1.5} />
                        ) : historyOpen ? (
                            <ChevronUp className="h-4 w-4" strokeWidth={1.5} />
                        ) : (
                            <ChevronDown className="h-4 w-4" strokeWidth={1.5} />
                        )}
                    </Button>
                    {isAdmin && (
                        <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive/60 hover:bg-destructive hover:text-destructive-foreground"
                            onClick={() => policy.id != null && onDelete(policy.id)}
                            disabled={deleting}
                            aria-label="Delete policy"
                        >
                            <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                        </Button>
                    )}
                </div>
            </div>

            {historyOpen && (
                <div className="border-t border-card-border/40 mt-2 pt-2 space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Recent activity</p>
                    {history.length === 0 ? (
                        <p className="text-xs text-muted-foreground text-center py-2">No history yet.</p>
                    ) : (
                        history.map((entry) => (
                            <div key={entry.id} className="flex items-start gap-2 text-xs">
                                <span className="text-muted-foreground shrink-0 tabular-nums font-mono">
                                    {new Date(entry.timestamp).toLocaleString()}
                                </span>
                                <span className="font-mono text-foreground shrink-0 truncate max-w-[100px]">
                                    {entry.container_name}
                                </span>
                                <span className={`shrink-0 font-medium ${actionColorClass(entry.action)}`}>
                                    {actionLabel(entry.action)}
                                </span>
                                <span className="text-muted-foreground truncate">
                                    {entry.reason}
                                </span>
                            </div>
                        ))
                    )}
                </div>
            )}
        </div>
    );
}
