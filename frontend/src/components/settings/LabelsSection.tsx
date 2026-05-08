import { useState, useEffect, useCallback } from 'react';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal, ModalHeader, ModalBody, ModalFooter, ConfirmModal } from '@/components/ui/modal';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { SENCHO_LABELS_CHANGED } from '@/lib/events';
import { CapabilityGate } from '../CapabilityGate';
import { LabelDot } from '../LabelPill';
import { LABEL_COLORS, MAX_LABELS_PER_NODE, type Label, type LabelColor } from '../label-types';
import { SettingsCallout } from './SettingsCallout';
import { SettingsPrimaryButton } from './SettingsActions';
import { useMastheadStats } from './MastheadStatsContext';

interface LabelsSectionProps {
    onLabelsChanged?: () => void;
}

export function LabelsSection({ onLabelsChanged }: LabelsSectionProps = {}) {
    const [labels, setLabels] = useState<Label[]>([]);
    const [loading, setLoading] = useState(true);
    const [assignmentCounts, setAssignmentCounts] = useState<Record<number, number>>({});

    // Dialog state
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editingLabel, setEditingLabel] = useState<Label | null>(null);
    const [formName, setFormName] = useState('');
    const [formColor, setFormColor] = useState<LabelColor>('teal');
    const [saving, setSaving] = useState(false);

    // Delete state
    const [deleteTarget, setDeleteTarget] = useState<Label | null>(null);

    const fetchLabels = useCallback(async () => {
        try {
            const [labelsRes, assignmentsRes] = await Promise.all([
                apiFetch('/labels'),
                apiFetch('/labels/assignments'),
            ]);
            if (labelsRes.ok) setLabels(await labelsRes.json());
            if (assignmentsRes.ok) {
                const map: Record<string, Label[]> = await assignmentsRes.json();
                const counts: Record<number, number> = {};
                for (const stackLabels of Object.values(map)) {
                    for (const l of stackLabels) {
                        counts[l.id] = (counts[l.id] || 0) + 1;
                    }
                }
                setAssignmentCounts(counts);
            }
        } catch {
            toast.error('Failed to load labels.');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchLabels(); }, [fetchLabels]);

    useMastheadStats(
        loading
            ? null
            : [
                { label: 'LABELS', value: `${labels.length}/${MAX_LABELS_PER_NODE}` },
            ],
    );

    const openCreate = () => {
        setEditingLabel(null);
        setFormName('');
        setFormColor('teal');
        setDialogOpen(true);
    };

    const openEdit = (label: Label) => {
        setEditingLabel(label);
        setFormName(label.name);
        setFormColor(label.color);
        setDialogOpen(true);
    };

    const handleSave = async () => {
        if (!formName.trim()) return;
        setSaving(true);
        try {
            const url = editingLabel ? `/labels/${editingLabel.id}` : '/labels';
            const method = editingLabel ? 'PUT' : 'POST';
            const res = await apiFetch(url, {
                method,
                body: JSON.stringify({ name: formName.trim(), color: formColor }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data?.error || `Failed to ${editingLabel ? 'update' : 'create'} label.`);
            }
            toast.success(`Label ${editingLabel ? 'updated' : 'created'}.`);
            setDialogOpen(false);
            fetchLabels();
            onLabelsChanged?.();
            window.dispatchEvent(new Event(SENCHO_LABELS_CHANGED));
        } catch (err: unknown) {
            toast.error((err as Error)?.message || 'Something went wrong.');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async () => {
        if (!deleteTarget) return;
        try {
            const res = await apiFetch(`/labels/${deleteTarget.id}`, { method: 'DELETE' });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data?.error || 'Failed to delete label.');
            }
            toast.success('Label deleted.');
            fetchLabels();
            onLabelsChanged?.();
            window.dispatchEvent(new Event(SENCHO_LABELS_CHANGED));
        } catch (err: unknown) {
            toast.error((err as Error)?.message || 'Something went wrong.');
        } finally {
            setDeleteTarget(null);
        }
    };

    return (
        <CapabilityGate capability="labels" featureName="Stack Labels">
            <div className="space-y-4">
                <div className="flex justify-end">
                    <SettingsPrimaryButton size="sm" onClick={openCreate} disabled={labels.length >= MAX_LABELS_PER_NODE}>
                        <Plus className="w-4 h-4" strokeWidth={1.5} />
                        {labels.length >= MAX_LABELS_PER_NODE ? 'Limit reached' : 'New label'}
                    </SettingsPrimaryButton>
                </div>

                <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel">
                    {loading ? (
                        <div className="p-6 text-center text-sm text-stat-subtitle">Loading…</div>
                    ) : labels.length === 0 ? (
                        <SettingsCallout
                            className="m-2"
                            title="No labels yet"
                            subtitle="Create one to start organizing your stacks."
                        />
                    ) : (
                        <div className="divide-y divide-border">
                            {labels.map(label => (
                                <div key={label.id} className="flex items-center gap-3 px-4 py-3 group transition-colors hover:bg-accent/5">
                                    <LabelDot color={label.color} />
                                    <span className="font-mono text-sm flex-1">{label.name}</span>
                                    <span className="text-xs text-muted-foreground tabular-nums">
                                        {assignmentCounts[label.id] || 0} stack{(assignmentCounts[label.id] || 0) !== 1 ? 's' : ''}
                                    </span>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                                        onClick={() => openEdit(label)}
                                    >
                                        <Pencil className="w-3.5 h-3.5" strokeWidth={1.5} />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        className="h-7 w-7 text-destructive/60 hover:bg-destructive hover:text-destructive-foreground opacity-0 group-hover:opacity-100 transition-opacity"
                                        onClick={() => setDeleteTarget(label)}
                                    >
                                        <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                                    </Button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Create / Edit Modal */}
            <Modal open={dialogOpen} onOpenChange={setDialogOpen} size="sm">
                <ModalHeader
                    kicker={editingLabel ? 'LABELS · EDIT' : 'LABELS · NEW'}
                    title={editingLabel ? 'Edit label' : 'Create label'}
                    description="Manage label properties"
                />
                <ModalBody>
                    <Input
                        placeholder="Label name"
                        value={formName}
                        onChange={e => setFormName(e.target.value)}
                        className="font-mono"
                        maxLength={30}
                        autoFocus
                        onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
                    />
                    <div>
                        <div className="text-xs text-muted-foreground mb-2">Color</div>
                        <div className="flex flex-wrap gap-2">
                            {LABEL_COLORS.map(c => (
                                <button
                                    key={c}
                                    type="button"
                                    className={`w-7 h-7 rounded-full border-2 transition-colors ${c === formColor ? 'border-foreground scale-110' : 'border-transparent hover:border-muted-foreground/30'}`}
                                    style={{ backgroundColor: `var(--label-${c})` }}
                                    onClick={() => setFormColor(c)}
                                />
                            ))}
                        </div>
                    </div>
                </ModalBody>
                <ModalFooter
                    secondary={
                        <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)} disabled={saving}>
                            Cancel
                        </Button>
                    }
                    primary={
                        <Button size="sm" onClick={handleSave} disabled={saving || !formName.trim()}>
                            {saving ? 'Saving...' : editingLabel ? 'Save' : 'Create'}
                        </Button>
                    }
                />
            </Modal>

            {/* Delete Confirmation */}
            <ConfirmModal
                open={!!deleteTarget}
                onOpenChange={open => !open && setDeleteTarget(null)}
                variant="destructive"
                kicker="LABELS · DELETE · IRREVERSIBLE"
                title={`Delete label "${deleteTarget?.name ?? ''}"`}
                confirmLabel="Delete"
                onConfirm={handleDelete}
            >
                <p className="text-sm text-stat-subtitle">
                    Removes the label from every stack across the fleet.
                </p>
            </ConfirmModal>
        </CapabilityGate>
    );
}
