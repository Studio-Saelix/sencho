import { useState, useEffect, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { TogglePill } from '@/components/ui/toggle-pill';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Combobox } from '@/components/ui/combobox';
import type { ComboboxOption } from '@/components/ui/combobox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Modal, ModalHeader, ModalBody, ModalFooter, ConfirmModal } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast-store';
import { apiFetch } from '@/lib/api';
import { useNodes } from '@/context/NodeContext';
import { CapabilityGate } from '@/components/CapabilityGate';
import type { NotificationCategory } from '@/components/dashboard/types';
import type { Label as StackLabel } from '@/components/label-types';
import { CATEGORY_LABELS } from '@/lib/notificationCategories';
import { emitMuteRulesChanged, type MuteRuleDraft } from '@/lib/muteRules';
import { useMuteRulesRefresh } from '@/hooks/useMuteRulesRefresh';
import { Plus, Trash2, Pencil, RefreshCw, X, BellOff } from 'lucide-react';
import { SettingsCallout } from './SettingsCallout';
import { SettingsPrimaryButton } from './SettingsActions';
import { useMastheadStats } from './MastheadStatsContext';

type NotificationLevel = 'info' | 'warning' | 'error';
type AppliesTo = 'bell' | 'external' | 'both';
type ExpirationPreset = 'forever' | '1h' | '24h' | 'custom';

interface NotificationSuppressionRule {
    id: number;
    name: string;
    node_id: number | null;
    stack_patterns: string[];
    label_ids: number[] | null;
    categories: NotificationCategory[] | null;
    levels: NotificationLevel[] | null;
    applies_to: AppliesTo;
    enabled: boolean;
    expires_at: number | null;
    created_at: number;
    updated_at: number;
}

const LEVEL_LABELS: Record<NotificationLevel, string> = {
    info: 'Info',
    warning: 'Warning',
    error: 'Error',
};

const APPLIES_TO_LABELS: Record<AppliesTo, string> = {
    bell: 'Bell only',
    external: 'External only',
    both: 'Bell and external',
};

function expirationFromPreset(preset: ExpirationPreset, customMs: number | null): number | null {
    if (preset === 'forever') return null;
    if (preset === '1h') return Date.now() + 3_600_000;
    if (preset === '24h') return Date.now() + 86_400_000;
    return customMs;
}

function presetFromExpiresAt(expires_at: number | null): { preset: ExpirationPreset; customMs: number | null } {
    if (expires_at == null) return { preset: 'forever', customMs: null };
    return { preset: 'custom', customMs: expires_at };
}

function formatExpiry(expires_at: number | null): string {
    if (expires_at == null) return 'Never';
    if (expires_at <= Date.now()) return 'Expired';
    return new Date(expires_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function applyDraftToForm(
    draft: MuteRuleDraft,
    setters: {
        setFormName: (v: string) => void;
        setFormNodeId: (v: number | null) => void;
        setFormStacks: (v: string[]) => void;
        setFormLabelIds: (v: number[]) => void;
        setFormCategories: (v: NotificationCategory[]) => void;
        setFormLevels: (v: NotificationLevel[]) => void;
        setFormAppliesTo: (v: AppliesTo) => void;
        setFormEnabled: (v: boolean) => void;
    },
) {
    setters.setFormName(draft.name);
    setters.setFormNodeId(draft.node_id ?? null);
    setters.setFormStacks(draft.stack_patterns ?? []);
    setters.setFormLabelIds(draft.label_ids ?? []);
    setters.setFormCategories(draft.categories ?? []);
    setters.setFormLevels(draft.levels ?? []);
    setters.setFormAppliesTo(draft.applies_to ?? 'both');
    setters.setFormEnabled(draft.enabled ?? true);
}

interface NotificationSuppressionSectionProps {
    prefill?: MuteRuleDraft | null;
    onPrefillConsumed?: () => void;
}

export function NotificationSuppressionSection({
    prefill = null,
    onPrefillConsumed,
}: NotificationSuppressionSectionProps) {
    const { nodes } = useNodes();
    const [rules, setRules] = useState<NotificationSuppressionRule[]>([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [showForm, setShowForm] = useState(false);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [deleteRuleId, setDeleteRuleId] = useState<number | null>(null);
    const [stackOptions, setStackOptions] = useState<ComboboxOption[]>([]);
    const [labelOptions, setLabelOptions] = useState<StackLabel[]>([]);

    const [formName, setFormName] = useState('');
    const [formNodeId, setFormNodeId] = useState<number | null>(null);
    const [formStacks, setFormStacks] = useState<string[]>([]);
    const [formLabelIds, setFormLabelIds] = useState<number[]>([]);
    const [formCategories, setFormCategories] = useState<NotificationCategory[]>([]);
    const [formLevels, setFormLevels] = useState<NotificationLevel[]>([]);
    const [formAppliesTo, setFormAppliesTo] = useState<AppliesTo>('both');
    const [formEnabled, setFormEnabled] = useState(true);
    const [formExpirationPreset, setFormExpirationPreset] = useState<ExpirationPreset>('forever');
    const [formCustomExpiry, setFormCustomExpiry] = useState('');

    const fetchRules = useCallback(async () => {
        try {
            const res = await apiFetch('/notification-suppression-rules');
            if (res.ok) setRules(await res.json());
        } catch {
            toast.error('Failed to load mute rules.');
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
        } catch { /* non-critical */ }
    }, []);

    const fetchLabels = useCallback(async () => {
        try {
            const res = await apiFetch('/labels');
            if (res.ok) setLabelOptions(await res.json());
        } catch { /* non-critical */ }
    }, []);

    useEffect(() => {
        void Promise.all([fetchRules(), fetchStacks(), fetchLabels()]);
    }, [fetchRules, fetchStacks, fetchLabels]);

    useMuteRulesRefresh(fetchRules);

    useEffect(() => {
        if (!prefill) return;
        applyDraftToForm(prefill, {
            setFormName,
            setFormNodeId,
            setFormStacks,
            setFormLabelIds,
            setFormCategories,
            setFormLevels,
            setFormAppliesTo,
            setFormEnabled,
        });
        setFormExpirationPreset('forever');
        setFormCustomExpiry('');
        setEditingId(null);
        setShowForm(true);
        onPrefillConsumed?.();
    }, [prefill, onPrefillConsumed]);

    const resetForm = () => {
        setFormName('');
        setFormNodeId(null);
        setFormStacks([]);
        setFormLabelIds([]);
        setFormCategories([]);
        setFormLevels([]);
        setFormAppliesTo('both');
        setFormEnabled(true);
        setFormExpirationPreset('forever');
        setFormCustomExpiry('');
        setEditingId(null);
        setShowForm(false);
    };

    const startEdit = (rule: NotificationSuppressionRule) => {
        const { preset, customMs } = presetFromExpiresAt(rule.expires_at);
        setEditingId(rule.id);
        setFormName(rule.name);
        setFormNodeId(rule.node_id);
        setFormStacks([...rule.stack_patterns]);
        setFormLabelIds(rule.label_ids ? [...rule.label_ids] : []);
        setFormCategories(rule.categories ? [...rule.categories] : []);
        setFormLevels(rule.levels ? [...rule.levels] : []);
        setFormAppliesTo(rule.applies_to);
        setFormEnabled(rule.enabled);
        setFormExpirationPreset(preset);
        setFormCustomExpiry(customMs != null ? new Date(customMs).toISOString().slice(0, 16) : '');
        setShowForm(true);
    };

    const handleSave = async () => {
        if (!formName.trim()) { toast.error('Name is required.'); return; }
        const customMs = formCustomExpiry ? new Date(formCustomExpiry).getTime() : null;
        if (formExpirationPreset === 'custom' && (customMs == null || Number.isNaN(customMs))) {
            toast.error('Choose a valid custom expiration date.');
            return;
        }

        setSaving(true);
        try {
            const body = {
                name: formName.trim(),
                node_id: formNodeId,
                stack_patterns: formStacks,
                label_ids: formLabelIds.length > 0 ? formLabelIds : null,
                categories: formCategories.length > 0 ? formCategories : null,
                levels: formLevels.length > 0 ? formLevels : null,
                applies_to: formAppliesTo,
                enabled: formEnabled,
                expires_at: expirationFromPreset(formExpirationPreset, customMs),
            };

            const url = editingId
                ? `/notification-suppression-rules/${editingId}`
                : '/notification-suppression-rules';
            const res = await apiFetch(url, {
                method: editingId ? 'PUT' : 'POST',
                body: JSON.stringify(body),
            });

            if (res.ok) {
                toast.success(editingId ? 'Mute rule updated.' : 'Mute rule created.');
                emitMuteRulesChanged();
                resetForm();
                fetchRules();
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || err?.message || 'Something went wrong.');
            }
        } catch (e: unknown) {
            toast.error((e as Error)?.message || 'Network error.');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        if (deleteRuleId == null) return;
        try {
            const res = await apiFetch(`/notification-suppression-rules/${deleteRuleId}`, { method: 'DELETE' });
            if (res.ok) {
                toast.success('Mute rule deleted.');
                emitMuteRulesChanged();
                fetchRules();
            } else {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || 'Something went wrong.');
            }
        } catch {
            toast.error('Network error.');
        } finally {
            setDeleteRuleId(null);
        }
    };

    const handleToggleEnabled = async (rule: NotificationSuppressionRule) => {
        try {
            const res = await apiFetch(`/notification-suppression-rules/${rule.id}`, {
                method: 'PUT',
                body: JSON.stringify({ enabled: !rule.enabled }),
            });
            if (res.ok) {
                emitMuteRulesChanged();
                fetchRules();
            }
            else {
                const err = await res.json().catch(() => ({}));
                toast.error(err?.error || 'Something went wrong.');
            }
        } catch {
            toast.error('Network error.');
        }
    };

    const addStack = (stackName: string) => {
        if (stackName && !formStacks.includes(stackName)) setFormStacks((prev) => [...prev, stackName]);
    };
    const removeStack = (stackName: string) => setFormStacks((prev) => prev.filter((s) => s !== stackName));
    const addLabel = (idStr: string) => {
        const id = Number(idStr);
        if (!Number.isNaN(id) && id > 0 && !formLabelIds.includes(id)) setFormLabelIds((prev) => [...prev, id]);
    };
    const removeLabel = (id: number) => setFormLabelIds((prev) => prev.filter((l) => l !== id));
    const addCategory = (cat: string) => {
        const c = cat as NotificationCategory;
        if (c && !formCategories.includes(c)) setFormCategories((prev) => [...prev, c]);
    };
    const removeCategory = (cat: NotificationCategory) => setFormCategories((prev) => prev.filter((c) => c !== cat));
    const addLevel = (level: string) => {
        const l = level as NotificationLevel;
        if (l && !formLevels.includes(l)) setFormLevels((prev) => [...prev, l]);
    };
    const removeLevel = (level: NotificationLevel) => setFormLevels((prev) => prev.filter((x) => x !== level));

    const enabledCount = rules.filter((r) => r.enabled && (r.expires_at == null || r.expires_at > Date.now())).length;
    useMastheadStats(
        loading ? null : [
            { label: 'RULES', value: `${rules.length}` },
            { label: 'ACTIVE', value: `${enabledCount}`, tone: enabledCount > 0 ? 'value' : 'subtitle' },
        ],
    );

    const availableStackOptions = stackOptions.filter((o) => !formStacks.includes(o.value));
    const availableLabelOptions = useMemo<ComboboxOption[]>(
        () => labelOptions.filter((l) => !formLabelIds.includes(l.id)).map((l) => ({ value: String(l.id), label: l.name })),
        [labelOptions, formLabelIds],
    );
    const availableCategoryOptions = useMemo<ComboboxOption[]>(
        () => (Object.keys(CATEGORY_LABELS) as NotificationCategory[])
            .filter((c) => !formCategories.includes(c))
            .map((c) => ({ value: c, label: CATEGORY_LABELS[c] })),
        [formCategories],
    );
    const availableLevelOptions = useMemo<ComboboxOption[]>(
        () => (['info', 'warning', 'error'] as NotificationLevel[])
            .filter((l) => !formLevels.includes(l))
            .map((l) => ({ value: l, label: LEVEL_LABELS[l] })),
        [formLevels],
    );

    const deleteTarget = deleteRuleId != null ? rules.find((r) => r.id === deleteRuleId) : null;

    return (
        <CapabilityGate capability="notification-suppression" featureName="Mute Rules">
            <div className="space-y-6">
                <SettingsCallout
                    icon={<BellOff className="h-4 w-4" strokeWidth={1.5} />}
                    title="Mute rules vs routing"
                    subtitle="Routing sends matching alerts to another channel. Mute rules hide or drop delivery to the bell, external channels, or both. Events still appear in stack activity history."
                />

                <div className="flex justify-end">
                    <SettingsPrimaryButton size="sm" onClick={() => { resetForm(); setShowForm(true); }}>
                        <Plus className="w-4 h-4" /> Add mute rule
                    </SettingsPrimaryButton>
                </div>

                <Modal open={showForm} onOpenChange={(open) => { if (!open) resetForm(); }} size="lg">
                    <ModalHeader
                        kicker={editingId ? 'MUTE RULES · EDIT RULE' : 'MUTE RULES · NEW RULE'}
                        title={editingId ? 'Edit mute rule' : 'New mute rule'}
                        description="Match alerts by node, stack, label, category, or severity, then choose where to mute delivery."
                    />
                    <ModalBody>
                        <div className="space-y-2">
                            <Label>Name</Label>
                            <Input placeholder="e.g. Mute staging deploy noise" value={formName} onChange={(e) => setFormName(e.target.value)} maxLength={100} />
                        </div>

                        <div className="space-y-2">
                            <Label>Node scope</Label>
                            <Select
                                value={formNodeId === null ? 'any' : String(formNodeId)}
                                onValueChange={(v) => setFormNodeId(v === 'any' ? null : Number(v))}
                            >
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="any">Any node</SelectItem>
                                    {nodes.map((n) => (
                                        <SelectItem key={n.id} value={String(n.id)}>{n.name}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>

                        <div className="space-y-2">
                            <Label>Stacks <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
                            <Combobox options={availableStackOptions} value="" onValueChange={addStack} placeholder="Add a stack..." searchPlaceholder="Search stacks..." emptyText="No stacks found." />
                            {formStacks.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 pt-1">
                                    {formStacks.map((s) => (
                                        <Badge key={s} variant="secondary" className="font-mono text-xs gap-1 pr-1">
                                            {s}
                                            <button type="button" onClick={() => removeStack(s)} className="ml-0.5 rounded-full hover:bg-foreground/10 p-0.5"><X className="w-3 h-3" /></button>
                                        </Badge>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="space-y-2">
                            <Label>Labels <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
                            <Combobox options={availableLabelOptions} value="" onValueChange={addLabel} placeholder="Add a label..." searchPlaceholder="Search labels..." emptyText="No labels found." />
                            {formLabelIds.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 pt-1">
                                    {formLabelIds.map((id) => {
                                        const lbl = labelOptions.find((l) => l.id === id);
                                        return (
                                            <Badge key={id} variant="secondary" className="text-xs gap-1 pr-1">
                                                {lbl?.name ?? `Label ${id}`}
                                                <button type="button" onClick={() => removeLabel(id)} className="ml-0.5 rounded-full hover:bg-foreground/10 p-0.5"><X className="w-3 h-3" /></button>
                                            </Badge>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        <div className="space-y-2">
                            <Label>Categories <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
                            <Combobox options={availableCategoryOptions} value="" onValueChange={addCategory} placeholder="Add a category..." searchPlaceholder="Search categories..." emptyText="No categories found." />
                            {formCategories.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 pt-1">
                                    {formCategories.map((c) => (
                                        <Badge key={c} variant="secondary" className="text-xs gap-1 pr-1">
                                            {CATEGORY_LABELS[c]}
                                            <button type="button" onClick={() => removeCategory(c)} className="ml-0.5 rounded-full hover:bg-foreground/10 p-0.5"><X className="w-3 h-3" /></button>
                                        </Badge>
                                    ))}
                                </div>
                            )}
                        </div>

                        <div className="space-y-2">
                            <Label>Severity <span className="text-muted-foreground font-normal text-xs">(optional)</span></Label>
                            <Combobox options={availableLevelOptions} value="" onValueChange={addLevel} placeholder="Add a severity..." searchPlaceholder="Search..." emptyText="No levels left." />
                            {formLevels.length > 0 && (
                                <div className="flex flex-wrap gap-1.5 pt-1">
                                    {formLevels.map((l) => (
                                        <Badge key={l} variant="outline" className="text-xs gap-1 pr-1">
                                            {LEVEL_LABELS[l]}
                                            <button type="button" onClick={() => removeLevel(l)} className="ml-0.5 rounded-full hover:bg-foreground/10 p-0.5"><X className="w-3 h-3" /></button>
                                        </Badge>
                                    ))}
                                </div>
                            )}
                            <p className="text-xs text-muted-foreground">Leave matchers blank to match any value. All non-empty filters must match (AND).</p>
                        </div>

                        <div className="space-y-2">
                            <Label>Apply to</Label>
                            <SegmentedControl
                                value={formAppliesTo}
                                options={[
                                    { value: 'bell', label: 'Bell' },
                                    { value: 'external', label: 'External' },
                                    { value: 'both', label: 'Both' },
                                ]}
                                onChange={setFormAppliesTo}
                                ariaLabel="Suppression target"
                                fullWidth
                            />
                        </div>

                        <div className="space-y-2">
                            <Label>Expiration</Label>
                            <Select value={formExpirationPreset} onValueChange={(v) => setFormExpirationPreset(v as ExpirationPreset)}>
                                <SelectTrigger><SelectValue /></SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="forever">Forever</SelectItem>
                                    <SelectItem value="1h">1 hour</SelectItem>
                                    <SelectItem value="24h">24 hours</SelectItem>
                                    <SelectItem value="custom">Custom date</SelectItem>
                                </SelectContent>
                            </Select>
                            {formExpirationPreset === 'custom' && (
                                <Input type="datetime-local" value={formCustomExpiry} onChange={(e) => setFormCustomExpiry(e.target.value)} />
                            )}
                        </div>

                        <div className="flex items-center gap-2">
                            <TogglePill checked={formEnabled} onChange={setFormEnabled} id="mute-rule-enabled" />
                            <span className="text-sm text-stat-value select-none">
                                {formEnabled ? 'Enabled' : 'Disabled'}
                            </span>
                        </div>
                    </ModalBody>
                    <ModalFooter
                        secondary={<Button variant="outline" size="sm" onClick={resetForm}>Cancel</Button>}
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

                {!loading && rules.length === 0 && (
                    <SettingsCallout
                        icon={<BellOff className="h-4 w-4" strokeWidth={1.5} />}
                        title="No mute rules configured"
                        subtitle="Alerts follow your routing and global channels unless a mute rule matches."
                    />
                )}

                {!loading && rules.map((rule) => (
                    <div key={rule.id} className="rounded-lg border border-card-border border-t-card-border-top bg-card text-card-foreground shadow-card-bevel transition-colors hover:border-t-card-border-hover p-4 space-y-3">
                        <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0 flex-wrap">
                                <BellOff className="w-4 h-4 text-muted-foreground shrink-0" strokeWidth={1.5} />
                                <span className="font-medium text-sm truncate">{rule.name}</span>
                                <Badge variant="outline" className="text-[10px] shrink-0">{APPLIES_TO_LABELS[rule.applies_to]}</Badge>
                                {rule.node_id !== null && (
                                    <Badge variant="secondary" className="text-[10px] shrink-0 font-mono">
                                        {nodes.find((n) => n.id === rule.node_id)?.name ?? `node:${rule.node_id}`}
                                    </Badge>
                                )}
                                {!rule.enabled && <Badge variant="secondary" className="text-[10px] shrink-0 text-muted-foreground">Disabled</Badge>}
                                {rule.expires_at != null && rule.expires_at <= Date.now() && (
                                    <Badge variant="secondary" className="text-[10px] shrink-0 text-muted-foreground">Expired</Badge>
                                )}
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                                <TogglePill checked={rule.enabled} onChange={() => handleToggleEnabled(rule)} className="scale-75" />
                                <Button variant="ghost" size="sm" onClick={() => startEdit(rule)} title="Edit"><Pencil className="w-4 h-4" strokeWidth={1.5} /></Button>
                                <Button variant="ghost" size="sm" className="text-destructive/60 hover:bg-destructive hover:text-destructive-foreground" title="Delete" onClick={() => setDeleteRuleId(rule.id)}>
                                    <Trash2 className="w-4 h-4" strokeWidth={1.5} />
                                </Button>
                            </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            {rule.stack_patterns.map((s) => <Badge key={s} variant="secondary" className="font-mono text-[10px]">{s}</Badge>)}
                            {rule.label_ids?.map((id) => {
                                const lbl = labelOptions.find((l) => l.id === id);
                                return <Badge key={id} variant="outline" className="text-[10px]">{lbl?.name ?? `label:${id}`}</Badge>;
                            })}
                            {rule.categories?.map((c) => <Badge key={c} variant="outline" className="text-[10px] font-mono">{CATEGORY_LABELS[c as NotificationCategory] ?? c}</Badge>)}
                            {rule.levels?.map((l) => <Badge key={l} variant="outline" className="text-[10px]">{LEVEL_LABELS[l]}</Badge>)}
                            {rule.stack_patterns.length === 0 && !rule.label_ids?.length && !rule.categories?.length && !rule.levels?.length && (
                                <span className="text-muted-foreground/50 text-[10px]">Matches all alerts</span>
                            )}
                            <span className="text-muted-foreground/50">|</span>
                            <span className="tabular-nums">Expires: {formatExpiry(rule.expires_at)}</span>
                        </div>
                    </div>
                ))}

                <ConfirmModal
                    open={deleteRuleId != null}
                    onOpenChange={(open) => { if (!open) setDeleteRuleId(null); }}
                    variant="destructive"
                    kicker="MUTE RULES · DELETE · IRREVERSIBLE"
                    title="Delete mute rule"
                    confirmLabel="Delete"
                    onConfirm={handleDelete}
                >
                    <p className="text-sm text-stat-subtitle">
                        Deletes <span className="font-medium text-stat-value">{deleteTarget?.name ?? 'this rule'}</span>. Matching alerts will deliver normally again.
                    </p>
                </ConfirmModal>
            </div>
        </CapabilityGate>
    );
}
