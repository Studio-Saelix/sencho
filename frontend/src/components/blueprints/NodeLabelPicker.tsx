import { useEffect, useState, useCallback } from 'react';
import { Plus, Tag } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast-store';
import {
    addNodeLabel,
    removeNodeLabel,
    getLabelsForNode,
    listDistinctLabels,
} from '@/lib/blueprintsApi';
import { NodeLabelPill } from './NodeLabelPill';

interface NodeLabelPickerProps {
    nodeId: number;
    /** Whether the current operator is allowed to add/remove labels (admin + paid). */
    canEdit?: boolean;
    /** Called whenever the label set for this node changes; parents may use this
     *  to refresh their cached list. */
    onChange?: (labels: string[]) => void;
}

export function NodeLabelPicker({ nodeId, canEdit = true, onChange }: NodeLabelPickerProps) {
    const [labels, setLabels] = useState<string[]>([]);
    const [allLabels, setAllLabels] = useState<string[]>([]);
    const [open, setOpen] = useState(false);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const [mine, distinct] = await Promise.all([
                getLabelsForNode(nodeId),
                listDistinctLabels().catch(() => [] as string[]),
            ]);
            setLabels(mine);
            setAllLabels(distinct);
            onChange?.(mine);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to load node labels');
        } finally {
            setLoading(false);
        }
    }, [nodeId, onChange]);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    async function handleAdd(label: string) {
        const trimmed = label.trim();
        if (!trimmed) return;
        setBusy(true);
        try {
            const result = await addNodeLabel(nodeId, trimmed);
            // A label add is exactly what makes a selector match a new node, so
            // this is the common case for a re-placement. Count only, and only
            // when non-zero: an empty list also means the projection faulted
            // after the write committed.
            const moved = result.gitopsRevisions.length;
            if (moved > 0) {
                toast.success(`Label added. ${moved} blueprint${moved === 1 ? '' : 's'} re-placed.`);
            }
            setInput('');
            await refresh();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to add label');
        } finally {
            setBusy(false);
        }
    }

    async function handleRemove(label: string) {
        setBusy(true);
        try {
            await removeNodeLabel(nodeId, label);
            await refresh();
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to remove label');
        } finally {
            setBusy(false);
        }
    }

    const suggestions = allLabels.filter(l => !labels.includes(l) && (input === '' || l.toLowerCase().includes(input.toLowerCase())));

    return (
        <div className="flex items-center flex-wrap gap-1">
            {labels.map(label => (
                <NodeLabelPill
                    key={label}
                    label={label}
                    size="sm"
                    onRemove={canEdit ? () => handleRemove(label) : undefined}
                />
            ))}
            {labels.length === 0 && !loading && (
                <span className="text-[10px] text-muted-foreground font-mono uppercase tracking-[0.18em]">No labels</span>
            )}
            {canEdit && (
                <Popover open={open} onOpenChange={setOpen}>
                    <PopoverTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-5 w-5" aria-label="Add label">
                            <Plus className="w-3 h-3" strokeWidth={1.5} />
                        </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-64 p-3 space-y-2" align="start">
                        <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] font-mono text-muted-foreground">
                            <Tag className="w-3 h-3" strokeWidth={1.5} />
                            Add label
                        </div>
                        <div className="flex items-center gap-1.5">
                            <Input
                                value={input}
                                onChange={e => setInput(e.target.value)}
                                onKeyDown={e => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        void handleAdd(input);
                                    }
                                }}
                                placeholder="prod"
                                className="h-7 text-xs font-mono"
                                disabled={busy}
                                autoFocus
                            />
                            <Button
                                size="sm"
                                variant="default"
                                className="h-7"
                                onClick={() => void handleAdd(input)}
                                disabled={busy || input.trim().length === 0}
                            >
                                Add
                            </Button>
                        </div>
                        {suggestions.length > 0 && (
                            <div className="space-y-1">
                                <div className="text-[10px] uppercase tracking-[0.18em] font-mono text-muted-foreground">
                                    Existing
                                </div>
                                <div className="flex flex-wrap gap-1">
                                    {suggestions.slice(0, 12).map(s => (
                                        <button
                                            key={s}
                                            type="button"
                                            className="cursor-pointer"
                                            onClick={() => void handleAdd(s)}
                                            disabled={busy}
                                        >
                                            <NodeLabelPill label={s} size="sm" />
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}
                        <p className="text-[10px] text-muted-foreground leading-relaxed">
                            Labels group nodes for fleet-wide blueprints. Use lowercase letters, digits, dot, dash, underscore.
                        </p>
                    </PopoverContent>
                </Popover>
            )}
        </div>
    );
}
