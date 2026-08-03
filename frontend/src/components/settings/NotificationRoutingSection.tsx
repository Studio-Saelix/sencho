import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TogglePill } from '@/components/ui/toggle-pill';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Combobox } from '@/components/ui/combobox';
import type { ComboboxOption } from '@/components/ui/combobox';
import { Tabs, TabsList, TabsTrigger, TabsHighlight, TabsHighlightItem } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { springs } from '@/lib/motion';
import { Modal, ModalHeader, ModalBody, ModalFooter, ConfirmModal } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast-store';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { apiFetch } from '@/lib/api';
import { useNodes } from '@/context/NodeContext';
import { CapabilityGate } from '@/components/CapabilityGate';
import type { NotificationCategory } from '@/components/dashboard/types';
import type { Label as StackLabel } from '@/components/label-types';
import { CATEGORY_LABELS } from '@/lib/notificationCategories';
import { Plus, Trash2, Pencil, RefreshCw, Zap, X, Route } from 'lucide-react';
import { SettingsCallout } from './SettingsCallout';
import { SettingsPrimaryButton } from './SettingsActions';
import { useMastheadStats } from './MastheadStatsContext';
import { classifyAppriseEndpoint, isStatelessAppriseEndpoint } from '@/lib/appriseEndpoint';
import { PatternChips, type PatternChipsHandle } from './PatternChips';

type NotificationLevel = 'info' | 'warning' | 'error';

interface NotificationRoute {
    id: number;
    name: string;
    node_id: number | null;
    stack_patterns: string[];
    label_ids: number[] | null;
    categories: NotificationCategory[] | null;
    levels: NotificationLevel[] | null;
    channel_type: 'discord' | 'slack' | 'webhook' | 'apprise' | 'ntfy';
    channel_url: string;
    config: { mode: 'keyed' | 'stateless'; tags?: string; has_urls: boolean; providers?: string[]; url_count?: number } | null;
    priority: number;
    enabled: boolean;
    created_at: number;
    updated_at: number;
}

const LEVEL_LABELS: Record<NotificationLevel, string> = {
    info: 'Info',
    warning: 'Warning',
    error: 'Error',
};

const CHANNEL_LABELS: Record<string, string> = {
    discord: 'Discord',
    slack: 'Slack',
    webhook: 'Webhook',
    apprise: 'Apprise',
    ntfy: 'ntfy',
};

const CHANNEL_PLACEHOLDERS: Record<string, string> = {
    discord: 'https://discord.com/api/webhooks/...',
    slack: 'https://hooks.slack.com/services/...',
    webhook: 'https://example.com/webhook',
    apprise: 'http://apprise.local/notify',
    ntfy: 'https://ntfy.sh/mytopic',
};

export function NotificationRoutingSection() {
    const { nodes } = useNodes();
    const localNode = useMemo(() => nodes.find(n => n.type === 'local') ?? null, [nodes]);
    const [routes, setRoutes] = useState<NotificationRoute[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [showForm, setShowForm] = useState(false);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [testingId, setTestingId] = useState<number | null>(null);
    const [deleteRouteId, setDeleteRouteId] = useState<number | null>(null);
    const [stackOptions, setStackOptions] = useState<ComboboxOption[]>([]);
    const [labelOptions, setLabelOptions] = useState<StackLabel[]>([]);

    // Form state
    const [formName, setFormName] = useState('');
    const [formNodeId, setFormNodeId] = useState<number | null>(null);
    const [formStacks, setFormStacks] = useState<string[]>([]);
    const [formLabelIds, setFormLabelIds] = useState<number[]>([]);
    const [formCategories, setFormCategories] = useState<NotificationCategory[]>([]);
    const [formLevels, setFormLevels] = useState<NotificationLevel[]>([]);
    const [formChannelType, setFormChannelType] = useState<'discord' | 'slack' | 'webhook' | 'apprise' | 'ntfy'>('discord');
    const patternChipsRef = useRef<PatternChipsHandle>(null);
    const [formChannelUrl, setFormChannelUrl] = useState('');
    const [formAppriseUrls, setFormAppriseUrls] = useState('');
    const [formAppriseTags, setFormAppriseTags] = useState('');
    const [appriseEndpointDirty, setAppriseEndpointDirty] = useState(false);
    const [appriseConfigDirty, setAppriseConfigDirty] = useState(false);
    /** Original Apprise mode when editing; drives preserve hints and forces a config write on mode switch. */
    const [editAppriseOriginalMode, setEditAppriseOriginalMode] = useState<'keyed' | 'stateless' | null>(null);
    const [editOriginalChannelType, setEditOriginalChannelType] = useState<'discord' | 'slack' | 'webhook' | 'apprise' | 'ntfy' | null>(null);
    const [formPriority, setFormPriority] = useState(0);
    const [formEnabled, setFormEnabled] = useState(true);

    const fetchRoutes = useCallback(async () => {
        try {
            const res = await apiFetch('/notification-routes');
            if (res.ok) {
                setRoutes(await res.json());
            }
        } catch {
            toast.error('Failed to load notification routes.');
        } finally {
            setLoading(false);
        }
    }, []);

    const fetchStacks = useCallback(async () => {
        try {
            const res = await apiFetch('/stacks');
            if (res.ok) {
                const data: string[] = await res.json();
                setStackOptions(data.map((s) => ({ value: s, label: s })));
            }
        } catch {
            // Stacks may fail on remote nodes, non-critical
        }
    }, []);

    const fetchLabels = useCallback(async () => {
        try {
            const res = await apiFetch('/labels');
            if (res.ok) {
                setLabelOptions(await res.json());
            }
        } catch {
            // Labels non-critical
        }
    }, []);

    useEffect(() => {
        void Promise.all([fetchRoutes(), fetchStacks(), fetchLabels()]);
    }, [fetchRoutes, fetchStacks, fetchLabels]);

    const resetForm = () => {
        setFormName('');
        setFormNodeId(null);
        setFormStacks([]);
        setFormLabelIds([]);
        setFormCategories([]);
        setFormLevels([]);
        setFormChannelType('discord');
        setFormChannelUrl('');
        setFormAppriseUrls('');
        setFormAppriseTags('');
        setAppriseEndpointDirty(false);
        setAppriseConfigDirty(false);
        setEditAppriseOriginalMode(null);
        setEditOriginalChannelType(null);
        setFormPriority(0);
        setFormEnabled(true);
        setEditingId(null);
        setShowForm(false);
    };

    const startEdit = (route: NotificationRoute) => {
        setEditingId(route.id);
        setFormName(route.name);
        setFormNodeId(route.node_id);
        setFormStacks([...route.stack_patterns]);
        setFormLabelIds(route.label_ids ? [...route.label_ids] : []);
        setFormCategories(route.categories ? [...route.categories] : []);
        setFormLevels(route.levels ? [...route.levels] : []);
        setFormChannelType(route.channel_type);
        setFormChannelUrl(route.channel_url);
        setFormAppriseTags(route.config?.tags ?? '');
        setFormAppriseUrls('');
        setAppriseEndpointDirty(false);
        setAppriseConfigDirty(false);
        setEditAppriseOriginalMode(
            route.channel_type === 'apprise' ? (route.config?.mode ?? null) : null,
        );
        setEditOriginalChannelType(route.channel_type);
        setFormPriority(route.priority);
        setFormEnabled(route.enabled);
        setShowForm(true);
    };

    const handleSave = async () => {
        if (!formName.trim()) { toast.error('Name is required.'); return; }
        const preparedPatterns = patternChipsRef.current?.prepareSave();
        if (!preparedPatterns?.ok) {
            toast.error('Fix invalid stack patterns before saving.');
            return;
        }
        if (!formChannelUrl.trim() || (formChannelType !== 'apprise' && formChannelType !== 'ntfy' && !formChannelUrl.startsWith('https://'))) {
            toast.error(formChannelType === 'apprise' ? 'Enter a valid Apprise endpoint.' : formChannelType === 'ntfy' ? 'Enter a valid ntfy server and topic URL.' : 'Channel URL must be a valid HTTPS URL.');
            return;
        }

        const channelTypeChanged = Boolean(
            editingId
            && editOriginalChannelType
            && formChannelType !== editOriginalChannelType,
        );
        const appriseMode = formChannelType === 'apprise' ? classifyAppriseEndpoint(formChannelUrl) : null;
        const appriseModeChanged = Boolean(
            editingId
            && editAppriseOriginalMode
            && appriseMode
            && appriseMode !== editAppriseOriginalMode,
        );
        // Mode switch, type switch, or dirty tags/URLs need config; endpoint-only edits omit it so blank fields preserve destinations.
        const needsAppriseConfig = formChannelType === 'apprise'
            && (!editingId || appriseConfigDirty || appriseModeChanged || channelTypeChanged);
        if (
            appriseMode === 'stateless'
            && !formAppriseUrls.trim()
            && (!editingId || appriseModeChanged || appriseConfigDirty || channelTypeChanged)
        ) {
            toast.error('Destination URLs are required for a stateless Apprise endpoint.');
            return;
        }

        setSaving(true);
        try {
            const body = {
                name: formName.trim(),
                node_id: formNodeId,
                stack_patterns: preparedPatterns.patterns,
                label_ids: formLabelIds.length > 0 ? formLabelIds : null,
                categories: formCategories.length > 0 ? formCategories : null,
                levels: formLevels.length > 0 ? formLevels : null,
                channel_type: formChannelType,
                ...(formChannelType !== 'apprise' || !editingId || appriseEndpointDirty || channelTypeChanged
                    ? { channel_url: formChannelUrl.trim() }
                    : {}),
                ...(needsAppriseConfig
                    ? {
                        config: appriseMode === 'stateless'
                            ? { urls: formAppriseUrls }
                            : { tags: formAppriseTags },
                    }
                    : {}),
                priority: formPriority,
                enabled: formEnabled,
            };

            const url = editingId ? `/notification-routes/${editingId}` : '/notification-routes';
            const method = editingId ? 'PUT' : 'POST';

            const res = await apiFetch(url, {
                method,
                body: JSON.stringify(body),
            });

            if (res.ok) {
                toast.success(editingId ? 'Route updated.' : 'Route created.');
                resetForm();
                fetchRoutes();
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || err?.data?.error || 'Something went wrong.');
            }
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Network error.');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        if (deleteRouteId == null) return;
        try {
            const res = await apiFetch(`/notification-routes/${deleteRouteId}`, { method: 'DELETE' });
            if (res.ok) {
                toast.success('Route deleted.');
                fetchRoutes();
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || err?.data?.error || 'Something went wrong.');
            }
        } catch {
            toast.error('Network error.');
        } finally {
            setDeleteRouteId(null);
        }
    };

    const deleteTargetRoute = deleteRouteId != null ? routes.find(r => r.id === deleteRouteId) : null;

    const handleTest = async (id: number) => {
        setTestingId(id);
        try {
            const res = await apiFetch(`/notification-routes/${id}/test`, { method: 'POST' });
            if (res.ok) {
                toast.success('Test notification sent!');
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.details || err?.error || 'Test failed.');
            }
        } catch {
            toast.error('Network error.');
        } finally {
            setTestingId(null);
        }
    };

    const handleToggleEnabled = async (route: NotificationRoute) => {
        try {
            const res = await apiFetch(`/notification-routes/${route.id}`, {
                method: 'PUT',
                body: JSON.stringify({ enabled: !route.enabled }),
            });
            if (res.ok) {
                fetchRoutes();
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || err?.data?.error || 'Something went wrong.');
            }
        } catch {
            toast.error('Network error.');
        }
    };

    const addStack = (stackName: string) => {
        if (stackName && !formStacks.includes(stackName)) {
            setFormStacks(prev => [...prev, stackName]);
        }
    };

    const addLabel = (idStr: string) => {
        const id = Number(idStr);
        if (!isNaN(id) && id > 0 && !formLabelIds.includes(id)) {
            setFormLabelIds(prev => [...prev, id]);
        }
    };

    const removeLabel = (id: number) => {
        setFormLabelIds(prev => prev.filter(l => l !== id));
    };

    const addCategory = (cat: string) => {
        const c = cat as NotificationCategory;
        if (c && !formCategories.includes(c)) {
            setFormCategories(prev => [...prev, c]);
        }
    };

    const removeCategory = (cat: NotificationCategory) => {
        setFormCategories(prev => prev.filter(c => c !== cat));
    };

    const addLevel = (level: string) => {
        const l = level as NotificationLevel;
        if ((l === 'info' || l === 'warning' || l === 'error') && !formLevels.includes(l)) {
            setFormLevels(prev => [...prev, l]);
        }
    };

    const removeLevel = (level: NotificationLevel) => {
        setFormLevels(prev => prev.filter(l => l !== level));
    };

    const enabledRoutesCount = routes.filter(r => r.enabled).length;
    useMastheadStats(
        loading
            ? null
            : [
                { label: 'ROUTES', value: `${routes.length}` },
                {
                    label: 'ENABLED',
                    value: `${enabledRoutesCount}`,
                    tone: enabledRoutesCount > 0 ? 'value' : 'subtitle',
                },
            ],
    );

    const isAppriseStateless = isStatelessAppriseEndpoint(formChannelUrl);
    const availableStackOptions = stackOptions.filter(o => !formStacks.includes(o.value));
    const availableLabelOptions = useMemo<ComboboxOption[]>(
        () => labelOptions.filter(l => !formLabelIds.includes(l.id)).map(l => ({ value: String(l.id), label: l.name })),
        [labelOptions, formLabelIds],
    );
    const availableCategoryOptions = useMemo<ComboboxOption[]>(
        () => (Object.keys(CATEGORY_LABELS) as NotificationCategory[]).filter(c => !formCategories.includes(c)).map(c => ({ value: c, label: CATEGORY_LABELS[c] })),
        [formCategories],
    );
    const availableLevelOptions = useMemo<ComboboxOption[]>(
        () => (Object.keys(LEVEL_LABELS) as NotificationLevel[]).filter(l => !formLevels.includes(l)).map(l => ({ value: l, label: LEVEL_LABELS[l] })),
        [formLevels],
    );

    return (
        <CapabilityGate capability="notification-routing" featureName="Routing">
            <div className="space-y-6">
                <div className="flex justify-end">
                    <SettingsPrimaryButton size="sm" onClick={() => { resetForm(); setShowForm(true); }}>
                        <Plus className="w-4 h-4" /> Add route
                    </SettingsPrimaryButton>
                </div>

                <Modal open={showForm} onOpenChange={(open) => { if (!open) resetForm(); }} size="lg">
                    <ModalHeader
                        kicker={editingId ? 'ROUTING · EDIT RULE' : 'ROUTING · NEW RULE'}
                        title={editingId ? 'Edit routing rule' : 'New routing rule'}
                        description={editingId ? 'Edit a notification routing rule' : 'Create a notification routing rule'}
                    />
                    <ModalBody>
                            <div className="space-y-2">
                                <Label>Name</Label>
                                <Input
                                    placeholder="e.g. Production alerts"
                                    value={formName}
                                    onChange={e => setFormName(e.target.value)}
                                    maxLength={100}
                                />
                            </div>

                            <div className="space-y-2">
                                <Label>Node scope</Label>
                                <Select
                                    value={formNodeId === null ? 'any' : String(formNodeId)}
                                    onValueChange={(v) => setFormNodeId(v === 'any' ? null : Number(v))}
                                >
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="any">Any node</SelectItem>
                                        {localNode !== null && (
                                            <SelectItem value={String(localNode.id)}>{localNode.name}</SelectItem>
                                        )}
                                    </SelectContent>
                                </Select>
                            </div>

                            <div className="space-y-2">
                                <Label>Stacks <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
                                <PatternChips
                                    ref={patternChipsRef}
                                    patterns={formStacks}
                                    onChange={setFormStacks}
                                    placeholder="Type a pattern (for example prod-*)"
                                    data-testid="route-pattern-chips"
                                />
                                <Combobox
                                    options={availableStackOptions}
                                    value=""
                                    onValueChange={addStack}
                                    placeholder="Insert known stack name..."
                                    searchPlaceholder="Search stacks..."
                                    emptyText="No stacks found."
                                />
                            </div>

                            <div className="space-y-2">
                                <Label>Labels <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
                                <Combobox
                                    options={availableLabelOptions}
                                    value=""
                                    onValueChange={addLabel}
                                    placeholder="Add a label..."
                                    searchPlaceholder="Search labels..."
                                    emptyText="No labels found."
                                />
                                {formLabelIds.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5 pt-1">
                                        {formLabelIds.map(id => {
                                            const lbl = labelOptions.find(l => l.id === id);
                                            return (
                                                <Badge key={id} variant="secondary" className="text-xs gap-1 pr-1">
                                                    {lbl?.name ?? `Label ${id}`}
                                                    <button
                                                        type="button"
                                                        onClick={() => removeLabel(id)}
                                                        className="ml-0.5 rounded-full hover:bg-foreground/10 p-0.5"
                                                    >
                                                        <X className="w-3 h-3" />
                                                    </button>
                                                </Badge>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>

                            <div className="space-y-2">
                                <Label>Categories <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
                                <Combobox
                                    options={availableCategoryOptions}
                                    value=""
                                    onValueChange={addCategory}
                                    placeholder="Add a category..."
                                    searchPlaceholder="Search categories..."
                                    emptyText="No categories found."
                                />
                                {formCategories.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5 pt-1">
                                        {formCategories.map(c => (
                                            <Badge key={c} variant="secondary" className="text-xs gap-1 pr-1">
                                                {CATEGORY_LABELS[c]}
                                                <button
                                                    type="button"
                                                    onClick={() => removeCategory(c)}
                                                    className="ml-0.5 rounded-full hover:bg-foreground/10 p-0.5"
                                                >
                                                    <X className="w-3 h-3" />
                                                </button>
                                            </Badge>
                                        ))}
                                    </div>
                                )}
                                <p className="text-xs text-muted-foreground">Leave blank to match all categories. All non-empty filters must match (AND).</p>
                            </div>

                            <div className="space-y-2">
                                <Label>Severity <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
                                <Combobox
                                    options={availableLevelOptions}
                                    value=""
                                    onValueChange={addLevel}
                                    placeholder="Add a severity..."
                                    searchPlaceholder="Search..."
                                    emptyText="No levels left."
                                />
                                {formLevels.length > 0 && (
                                    <div className="flex flex-wrap gap-1.5 pt-1">
                                        {formLevels.map((l) => (
                                            <Badge key={l} variant="outline" className="text-xs gap-1 pr-1">
                                                {LEVEL_LABELS[l]}
                                                <button
                                                    type="button"
                                                    onClick={() => removeLevel(l)}
                                                    className="ml-0.5 rounded-full hover:bg-foreground/10 p-0.5"
                                                >
                                                    <X className="w-3 h-3" />
                                                </button>
                                            </Badge>
                                        ))}
                                    </div>
                                )}
                            </div>

                            <div className="space-y-2">
                                <Label>Channel</Label>
                                <Tabs
                                    value={formChannelType}
                                    onValueChange={(v) => {
                                        const next = v as 'discord' | 'slack' | 'webhook' | 'apprise' | 'ntfy';
                                        if (next !== formChannelType) {
                                            // Type change replaces credentials; never carry a redacted prior URL across types.
                                            setFormChannelUrl('');
                                            setFormAppriseTags('');
                                            setFormAppriseUrls('');
                                            setAppriseEndpointDirty(true);
                                            setAppriseConfigDirty(true);
                                        }
                                        setFormChannelType(next);
                                    }}
                                >
                                    <TabsList className="w-full grid grid-cols-5">
                                        <TabsHighlight className="rounded-md bg-brand/20" transition={springs.snappy}>
                                            <TabsHighlightItem value="discord">
                                                <TabsTrigger value="discord">Discord</TabsTrigger>
                                            </TabsHighlightItem>
                                            <TabsHighlightItem value="slack">
                                                <TabsTrigger value="slack">Slack</TabsTrigger>
                                            </TabsHighlightItem>
                                            <TabsHighlightItem value="webhook">
                                                <TabsTrigger value="webhook">Webhook</TabsTrigger>
                                            </TabsHighlightItem>
                                            <TabsHighlightItem value="apprise">
                                                <TabsTrigger value="apprise">Apprise</TabsTrigger>
                                            </TabsHighlightItem>
                                            <TabsHighlightItem value="ntfy">
                                                <TabsTrigger value="ntfy">ntfy</TabsTrigger>
                                            </TabsHighlightItem>
                                        </TabsHighlight>
                                    </TabsList>
                                </Tabs>
                                <Input
                                    placeholder={CHANNEL_PLACEHOLDERS[formChannelType]}
                                    value={formChannelUrl}
                                    onChange={e => {
                                        setFormChannelUrl(e.target.value);
                                        if (formChannelType === 'apprise') setAppriseEndpointDirty(true);
                                    }}
                                />
                                {formChannelType === 'apprise' && (
                                    <>
                                        <Input
                                            placeholder={isAppriseStateless ? 'Destination URLs, required for stateless mode' : 'Optional tags for keyed mode'}
                                            value={isAppriseStateless ? formAppriseUrls : formAppriseTags}
                                            onChange={e => {
                                                if (isAppriseStateless) setFormAppriseUrls(e.target.value);
                                                else setFormAppriseTags(e.target.value);
                                                setAppriseConfigDirty(true);
                                            }}
                                        />
                                        {editingId !== null && isAppriseStateless && editAppriseOriginalMode === 'stateless' && !formAppriseUrls && (
                                            <p className="text-xs text-stat-subtitle">Leave destination URLs blank to preserve the configured destinations.</p>
                                        )}
                                    </>
                                )}
                            </div>

                            <div className="grid grid-cols-2 gap-4">
                                <div className="space-y-2">
                                    <Label>Priority</Label>
                                    <Input
                                        type="number"
                                        min={0}
                                        value={formPriority}
                                        onChange={e => setFormPriority(parseInt(e.target.value, 10) || 0)}
                                    />
                                    <p className="text-xs text-muted-foreground">Lower values are evaluated first.</p>
                                </div>
                                <div className="space-y-2">
                                    <Label>Enabled</Label>
                                    <div className="pt-2">
                                        <TogglePill checked={formEnabled} onChange={setFormEnabled} />
                                    </div>
                                </div>
                            </div>

                    </ModalBody>
                    <ModalFooter
                        secondary={
                            <Button variant="outline" size="sm" onClick={resetForm}>Cancel</Button>
                        }
                        primary={
                            <SettingsPrimaryButton size="sm" onClick={handleSave} disabled={saving}>
                                {saving ? <><RefreshCw className="w-4 h-4 animate-spin" />Saving</> : editingId ? 'Update' : 'Create'}
                            </SettingsPrimaryButton>
                        }
                    />
                </Modal>

                {loading && (
                    <div className="space-y-3">
                        <Skeleton className="h-20 w-full rounded-xl" />
                        <Skeleton className="h-20 w-full rounded-xl" />
                    </div>
                )}

                {!loading && routes.length === 0 && (
                    <SettingsCallout
                        icon={<Route className="h-4 w-4" strokeWidth={1.5} />}
                        title="No routing rules configured"
                        subtitle="Alerts use your global notification channels. Add a route to direct specific stack alerts to dedicated channels."
                    />
                )}

                {!loading && routes.map(route => (
                    <div
                        key={route.id}
                        className="rounded-lg border border-card-border border-t-card-border-top bg-card text-card-foreground shadow-card-bevel transition-colors hover:border-t-card-border-hover p-4 space-y-3"
                    >
                        <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 min-w-0">
                                <Route className="w-4 h-4 text-muted-foreground shrink-0" strokeWidth={1.5} />
                                <span className="font-medium text-sm truncate">{route.name}</span>
                                <Badge variant="outline" className="text-[10px] shrink-0">
                                    {CHANNEL_LABELS[route.channel_type]}
                                </Badge>
                                {route.node_id !== null && (
                                    <Badge variant="secondary" className="text-[10px] shrink-0 font-mono">
                                        {route.node_id === localNode?.id ? localNode?.name : `node:${route.node_id}`}
                                    </Badge>
                                )}
                                {!route.enabled && (
                                    <Badge variant="secondary" className="text-[10px] shrink-0 text-muted-foreground">
                                        Disabled
                                    </Badge>
                                )}
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                                <TogglePill
                                    checked={route.enabled}
                                    onChange={() => handleToggleEnabled(route)}
                                    className="scale-75"
                                />
                                <TooltipProvider>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                onClick={() => handleTest(route.id)}
                                                disabled={testingId === route.id}
                                            >
                                                {testingId === route.id ? (
                                                    <RefreshCw className="w-4 h-4 animate-spin" />
                                                ) : (
                                                    <Zap className="w-4 h-4" strokeWidth={1.5} />
                                                )}
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>Send test notification</TooltipContent>
                                    </Tooltip>
                                </TooltipProvider>
                                <TooltipProvider>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button variant="ghost" size="sm" onClick={() => startEdit(route)}>
                                                <Pencil className="w-4 h-4" strokeWidth={1.5} />
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>Edit</TooltipContent>
                                    </Tooltip>
                                </TooltipProvider>
                                <TooltipProvider>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="text-destructive/60 hover:bg-destructive hover:text-destructive-foreground"
                                                onClick={() => setDeleteRouteId(route.id)}
                                            >
                                                <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>Delete</TooltipContent>
                                    </Tooltip>
                                </TooltipProvider>
                            </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            {route.stack_patterns.length > 0 && route.stack_patterns.map(s => (
                                <Badge key={s} variant="secondary" className="font-mono text-[10px]">{s}</Badge>
                            ))}
                            {route.label_ids && route.label_ids.length > 0 && route.label_ids.map(id => {
                                const lbl = labelOptions.find(l => l.id === id);
                                return (
                                    <Badge key={id} variant="outline" className="text-[10px]">
                                        {lbl?.name ?? `label:${id}`}
                                    </Badge>
                                );
                            })}
                            {route.categories && route.categories.length > 0 && route.categories.map(c => (
                                <Badge key={c} variant="outline" className="text-[10px] font-mono">{CATEGORY_LABELS[c] ?? c}</Badge>
                            ))}
                            {route.levels && route.levels.length > 0 && route.levels.map((l) => (
                                <Badge key={l} variant="outline" className="text-[10px]">{LEVEL_LABELS[l]}</Badge>
                            ))}
                            {route.stack_patterns.length === 0
                                && (!route.label_ids || route.label_ids.length === 0)
                                && (!route.categories || route.categories.length === 0)
                                && (!route.levels || route.levels.length === 0)
                                && (
                                    route.node_id === null
                                        ? <span className="text-muted-foreground/50 text-[10px]">Matches all alerts</span>
                                        : <span className="text-muted-foreground/50 text-[10px]">Matches all alerts on this node</span>
                                )}
                            <span className="text-muted-foreground/50">|</span>
                            <span className="font-mono truncate max-w-[200px]" title={route.channel_type === 'apprise' ? undefined : route.channel_url}>
                                {route.channel_url}
                            </span>
                            {route.priority !== 0 && (
                                <>
                                    <span className="text-muted-foreground/50">|</span>
                                    <span className="tabular-nums">Priority: {route.priority}</span>
                                </>
                            )}
                        </div>
                    </div>
                ))}

                <ConfirmModal
                    open={deleteRouteId != null}
                    onOpenChange={(open) => { if (!open) setDeleteRouteId(null); }}
                    variant="destructive"
                    kicker="ROUTING · DELETE · IRREVERSIBLE"
                    title="Delete routing rule"
                    confirmLabel="Delete"
                    onConfirm={handleDelete}
                >
                    <p className="text-sm text-stat-subtitle">
                        Deletes <span className="font-medium text-stat-value">{deleteTargetRoute?.name ?? 'this rule'}</span>. Alerts for the associated stacks will fall back to your global notification channels.
                    </p>
                </ConfirmModal>
            </div>
        </CapabilityGate>
    );
}
