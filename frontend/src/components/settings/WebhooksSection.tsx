import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { TogglePill } from '@/components/ui/toggle-pill';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui/toast-store';
import { useNodes } from '@/context/NodeContext';
import { apiFetch } from '@/lib/api';
import { copyToClipboard } from '@/lib/clipboard';
import {
    RefreshCw, CheckCircle, XCircle, Webhook, Copy, Trash2,
    Plus, ChevronDown, ChevronRight, History,
} from 'lucide-react';
import { SettingsSection } from './SettingsSection';
import { SettingsField } from './SettingsField';
import { SettingsCallout } from './SettingsCallout';
import { SettingsActions, SettingsPrimaryButton } from './SettingsActions';
import { useMastheadStats } from './MastheadStatsContext';

interface WebhookItem {
    id: number;
    node_id: number;
    name: string;
    stack_name: string;
    action: string;
    secret: string;
    enabled: boolean;
    created_at: number;
    updated_at: number;
}

interface WebhookExecution {
    id: number;
    webhook_id: number;
    action: string;
    status: 'success' | 'failure';
    trigger_source: string | null;
    duration_ms: number | null;
    error: string | null;
    executed_at: number;
}

export function WebhooksSection({ isPaid }: { isPaid: boolean }) {
    const { activeNode, nodes } = useNodes();
    const [webhooks, setWebhooks] = useState<WebhookItem[]>([]);
    const [loading, setLoading] = useState(true);
    const [creating, setCreating] = useState(false);
    const [showForm, setShowForm] = useState(false);
    const [newSecret, setNewSecret] = useState<{ id: number; secret: string } | null>(null);
    const [expandedHistory, setExpandedHistory] = useState<number | null>(null);
    const [history, setHistory] = useState<Record<number, WebhookExecution[]>>({});
    const [loadingHistory, setLoadingHistory] = useState<number | null>(null);

    const [formName, setFormName] = useState('');
    const [formStack, setFormStack] = useState('');
    const [formAction, setFormAction] = useState<string>('deploy');
    const [stacks, setStacks] = useState<string[]>([]);

    const fetchWebhooks = async () => {
        try {
            const res = await apiFetch('/webhooks', { localOnly: true });
            if (res.ok) setWebhooks(await res.json());
        } catch { /* ignore */ } finally { setLoading(false); }
    };

    const fetchStacks = async () => {
        try {
            const res = await apiFetch('/stacks');
            if (res.ok) setStacks(await res.json());
        } catch { /* ignore */ }
    };

    useEffect(() => { fetchWebhooks(); fetchStacks(); }, [activeNode?.id]);

    const enabledCount = webhooks.filter(w => w.enabled).length;
    useMastheadStats(
        loading
            ? null
            : [
                { label: 'WEBHOOKS', value: `${webhooks.length}` },
                {
                    label: 'ENABLED',
                    value: `${enabledCount}`,
                    tone: enabledCount > 0 ? 'value' : 'subtitle',
                },
            ],
    );

    const handleCreate = async () => {
        if (!formName || !formStack || !formAction) {
            toast.error('All fields are required.');
            return;
        }
        setCreating(true);
        try {
            const res = await apiFetch('/webhooks', {
                method: 'POST',
                localOnly: true,
                body: JSON.stringify({ name: formName, stack_name: formStack, action: formAction, node_id: activeNode?.id }),
            });
            if (res.ok) {
                const data = await res.json();
                setNewSecret({ id: data.id, secret: data.secret });
                setShowForm(false);
                setFormName(''); setFormStack(''); setFormAction('deploy');
                fetchWebhooks();
                toast.success('Webhook created.');
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Failed to create webhook.');
            }
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Network error.');
        } finally { setCreating(false); }
    };

    const handleDelete = async (id: number) => {
        try {
            const res = await apiFetch(`/webhooks/${id}`, { method: 'DELETE', localOnly: true });
            if (res.ok) { toast.success('Webhook deleted.'); fetchWebhooks(); }
            else { const err = await res.json().catch(() => ({})); toast.error(err?.error || 'Failed to delete.'); }
        } catch { toast.error('Network error.'); }
    };

    const handleToggle = async (id: number, enabled: boolean) => {
        try {
            const res = await apiFetch(`/webhooks/${id}`, {
                method: 'PUT', localOnly: true,
                body: JSON.stringify({ enabled }),
            });
            if (res.ok) fetchWebhooks();
        } catch { /* ignore */ }
    };

    const fetchHistory = async (webhookId: number) => {
        if (expandedHistory === webhookId) { setExpandedHistory(null); return; }
        setExpandedHistory(webhookId);
        setLoadingHistory(webhookId);
        try {
            const res = await apiFetch(`/webhooks/${webhookId}/history`, { localOnly: true });
            if (res.ok) {
                const data = await res.json();
                setHistory(prev => ({ ...prev, [webhookId]: data }));
            }
        } catch { /* ignore */ } finally { setLoadingHistory(null); }
    };

    const handleCopy = async (text: string, label: string) => {
        try {
            await copyToClipboard(text);
            toast.success(`${label} copied to clipboard.`);
        } catch {
            toast.error('Failed to copy to clipboard.');
        }
    };

    if (!isPaid) return null;

    return (
        <div className="flex flex-col gap-10">
            <div className="flex justify-end">
                <SettingsPrimaryButton size="sm" onClick={() => setShowForm(!showForm)}>
                    <Plus className="w-4 h-4" /> Create webhook
                </SettingsPrimaryButton>
            </div>

            {showForm && (
                <SettingsSection title="New webhook">
                    <SettingsField label="Name" helper="Shown in execution history and notifications." htmlFor="webhook-name">
                        <Input id="webhook-name" placeholder="Deploy on push" value={formName} onChange={e => setFormName(e.target.value)} />
                    </SettingsField>
                    <SettingsField label="Stack" helper="The webhook will operate on this stack." htmlFor="webhook-stack">
                        <Select value={formStack} onValueChange={setFormStack}>
                            <SelectTrigger id="webhook-stack"><SelectValue placeholder="Select a stack..." /></SelectTrigger>
                            <SelectContent>
                                {stacks.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </SettingsField>
                    {activeNode && (
                        <SettingsField label="Node" helper="Webhook execution is pinned to the currently active node.">
                            <div className="rounded-md border border-card-border bg-muted px-3 py-2 text-xs text-stat-subtitle">
                                {activeNode.name}
                            </div>
                        </SettingsField>
                    )}
                    <SettingsField label="Action" helper="What happens when the webhook is triggered." htmlFor="webhook-action">
                        <Select value={formAction} onValueChange={setFormAction}>
                            <SelectTrigger id="webhook-action"><SelectValue /></SelectTrigger>
                            <SelectContent>
                                <SelectItem value="deploy">Deploy (down + up)</SelectItem>
                                <SelectItem value="restart">Restart</SelectItem>
                                <SelectItem value="stop">Stop</SelectItem>
                                <SelectItem value="start">Start</SelectItem>
                                <SelectItem value="pull">Pull & Update</SelectItem>
                                <SelectItem value="git-pull">Git source sync</SelectItem>
                            </SelectContent>
                        </Select>
                    </SettingsField>
                    <SettingsActions>
                        <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>Cancel</Button>
                        <SettingsPrimaryButton size="sm" onClick={handleCreate} disabled={creating}>
                            {creating ? <><RefreshCw className="w-4 h-4 animate-spin" />Creating</> : 'Create'}
                        </SettingsPrimaryButton>
                    </SettingsActions>
                </SettingsSection>
            )}

            {newSecret && (
                <SettingsCallout
                    tone="success"
                    icon={<CheckCircle className="h-4 w-4" />}
                    title="Webhook created. Copy your secret now."
                    subtitle={
                        <div className="flex flex-col gap-2 mt-1">
                            <span>This secret will not be shown again. Store it securely.</span>
                            <div className="flex items-center gap-2">
                                <code className="flex-1 text-xs font-mono bg-muted px-3 py-2 rounded-md break-all">{newSecret.secret}</code>
                                <Button variant="outline" size="sm" onClick={() => handleCopy(newSecret.secret, 'Secret')}>
                                    <Copy className="w-4 h-4" />
                                </Button>
                            </div>
                        </div>
                    }
                    action={
                        <Button variant="outline" size="sm" onClick={() => setNewSecret(null)}>Dismiss</Button>
                    }
                />
            )}

            {loading && (
                <div className="space-y-3">
                    <Skeleton className="h-20 w-full rounded-lg" />
                    <Skeleton className="h-20 w-full rounded-lg" />
                </div>
            )}

            {!loading && webhooks.length === 0 && !showForm && (
                <SettingsCallout
                    icon={<Webhook className="h-4 w-4" />}
                    title="No webhooks yet"
                    subtitle="Create one to trigger stack actions from CI/CD."
                />
            )}

            {!loading && webhooks.length > 0 && (
                <SettingsSection title="Configured webhooks" kicker={`${webhooks.length} total`}>
                    <div className="pt-3 flex flex-col gap-3">
                        {webhooks.map(wh => {
                            const triggerUrl = `${window.location.origin}/api/webhooks/${wh.id}/trigger`;
                            const isExpanded = expandedHistory === wh.id;
                            const nodeName = nodes.find(n => n.id === wh.node_id)?.name ?? `Node ${wh.node_id}`;
                            return (
                                <div key={wh.id} className="border border-card-border rounded-md overflow-hidden bg-card">
                                    <div className="p-4 space-y-3">
                                        <div className="flex items-center justify-between gap-3">
                                            <div className="flex items-center gap-2 min-w-0">
                                                <Webhook className="w-4 h-4 text-stat-subtitle shrink-0" />
                                                <span className="font-medium text-sm truncate text-stat-value">{wh.name}</span>
                                                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle border border-card-border rounded px-1.5 py-0.5 shrink-0">
                                                    {wh.action}
                                                </span>
                                                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle border border-card-border rounded px-1.5 py-0.5 shrink-0">
                                                    {wh.stack_name}
                                                </span>
                                                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle border border-card-border rounded px-1.5 py-0.5 shrink-0">
                                                    {nodeName}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-2 shrink-0">
                                                <TogglePill checked={wh.enabled} onChange={(c) => handleToggle(wh.id!, c)} />
                                                <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => handleDelete(wh.id!)}>
                                                    <Trash2 className="w-4 h-4 text-stat-subtitle" />
                                                </Button>
                                            </div>
                                        </div>

                                        <div className="space-y-1">
                                            <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Trigger URL</div>
                                            <div className="flex items-center gap-2">
                                                <code className="flex-1 text-[11px] font-mono bg-muted px-2.5 py-1.5 rounded-md truncate">{triggerUrl}</code>
                                                <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => handleCopy(triggerUrl, 'URL')}>
                                                    <Copy className="w-3 h-3" />
                                                </Button>
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-2 text-xs">
                                            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Secret</span>
                                            <code className="font-mono text-stat-subtitle">{wh.secret}</code>
                                        </div>

                                        <button
                                            onClick={() => fetchHistory(wh.id!)}
                                            className="flex items-center gap-1.5 text-xs text-stat-subtitle hover:text-stat-value transition-colors"
                                        >
                                            {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                                            <History className="w-3 h-3" />
                                            Recent executions
                                        </button>
                                    </div>

                                    {isExpanded && (
                                        <div className="border-t border-card-border bg-muted/20 px-4 py-3">
                                            {loadingHistory === wh.id ? (
                                                <Skeleton className="h-8 w-full" />
                                            ) : (history[wh.id!] ?? []).length === 0 ? (
                                                <p className="text-xs text-stat-subtitle">No executions yet.</p>
                                            ) : (
                                                <div className="space-y-1.5 max-h-48 overflow-y-auto">
                                                    {(history[wh.id!] ?? []).map(ex => (
                                                        <div key={ex.id} className="flex items-center gap-2 text-xs">
                                                            {ex.status === 'success'
                                                                ? <CheckCircle className="w-3 h-3 text-success shrink-0" />
                                                                : <XCircle className="w-3 h-3 text-destructive shrink-0" />}
                                                            <span className="font-medium">{ex.action}</span>
                                                            <span className="text-stat-subtitle">
                                                                {new Date(ex.executed_at).toLocaleString()}
                                                            </span>
                                                            {ex.duration_ms !== null && (
                                                                <span className="text-stat-subtitle">{(ex.duration_ms / 1000).toFixed(1)}s</span>
                                                            )}
                                                            {ex.error && (
                                                                <span className="text-destructive truncate" title={ex.error}>{ex.error}</span>
                                                            )}
                                                        </div>
                                                    ))}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                </SettingsSection>
            )}
        </div>
    );
}
