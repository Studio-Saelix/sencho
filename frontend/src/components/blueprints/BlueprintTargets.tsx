import { useMemo, useState } from 'react';
import { Plus, Tag, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SegmentedControl } from '@/components/ui/segmented-control';
import {
    type MatchMode,
    type NodeLabelMap,
    type StagedLabel,
    type TargetsDraft,
    distinctLabels,
    matchNodes,
    plural,
    selectorFromDraft,
    stagedInUse,
    validateLabelName,
    withStagedLabels,
} from '@/lib/blueprintTargets';

interface TargetNode {
    id: number;
    name: string;
    type: string;
}

interface BlueprintTargetsProps {
    draft: TargetsDraft;
    onDraftChange: (next: TargetsDraft) => void;
    nodes: readonly TargetNode[];
    nodeLabels: NodeLabelMap;
    staged: readonly StagedLabel[];
    onStagedChange: (next: StagedLabel[]) => void;
    /** Whether the operator may label this node (node:manage). */
    canLabelNode: (nodeId: number) => boolean;
}

function toggle<T>(list: T[], item: T): T[] {
    return list.includes(item) ? list.filter(x => x !== item) : [...list, item];
}

const LABEL_KICKER = 'font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon';

export function BlueprintTargets({
    draft, onDraftChange, nodes, nodeLabels, staged, onStagedChange, canLabelNode,
}: BlueprintTargetsProps) {
    const effectiveLabels = useMemo(() => withStagedLabels(nodeLabels, staged), [nodeLabels, staged]);
    const knownLabels = useMemo(() => distinctLabels(effectiveLabels), [effectiveLabels]);
    const selector = useMemo(() => selectorFromDraft(draft), [draft]);
    const matched = useMemo(() => matchNodes(selector, nodes, effectiveLabels), [selector, nodes, effectiveLabels]);
    const pendingTags = useMemo(() => stagedInUse(staged, selector), [staged, selector]);
    const labelableNodes = nodes.filter(n => canLabelNode(n.id));
    const compound = draft.compound;

    function setLabels(labels: string[]) {
        onDraftChange({ ...draft, labels });
    }

    function stageLabel(label: string, nodeIds: number[]) {
        const additions = nodeIds
            .filter(id => !(effectiveLabels[id] ?? []).includes(label))
            .map(nodeId => ({ nodeId, label }));
        onStagedChange([...staged, ...additions]);
        if (draft.compound) {
            if (!draft.compound.any.includes(label)) {
                onDraftChange({ ...draft, compound: { ...draft.compound, any: [...draft.compound.any, label] } });
            }
        } else if (!draft.labels.includes(label)) {
            setLabels([...draft.labels, label]);
        }
    }

    function unstage(entry: StagedLabel) {
        const remaining = staged.filter(s => !(s.nodeId === entry.nodeId && s.label === entry.label));
        onStagedChange(remaining);
        const stillKnown = distinctLabels(withStagedLabels(nodeLabels, remaining)).includes(entry.label);
        if (stillKnown) return;
        if (draft.compound) {
            onDraftChange({
                ...draft,
                compound: {
                    any: draft.compound.any.filter(l => l !== entry.label),
                    all: draft.compound.all.filter(l => l !== entry.label),
                },
            });
        } else {
            setLabels(draft.labels.filter(l => l !== entry.label));
        }
    }

    const addLabelControl = labelableNodes.length > 0 && (
        <AddLabelPopover nodes={labelableNodes} onStage={stageLabel} />
    );

    return (
        <div className="space-y-3">
            <SegmentedControl
                ariaLabel="Target type"
                value={draft.type}
                onChange={(type) => onDraftChange({ ...draft, type })}
                options={[
                    { value: 'labels', label: 'By node label' },
                    { value: 'nodes', label: 'Specific nodes' },
                ]}
            />

            {draft.type === 'labels' && !compound && (
                <div className="space-y-3 rounded-lg border border-card-border bg-card p-3">
                    <ChipRow
                        labels={knownLabels}
                        selected={draft.labels}
                        onToggle={(l) => setLabels(toggle(draft.labels, l))}
                        trailing={addLabelControl}
                        emptyHint={labelableNodes.length === 0 ? 'No node labels exist yet.' : 'No node labels yet. Add the first one here.'}
                    />
                    <div className="flex items-center gap-3">
                        <SegmentedControl<MatchMode>
                            ariaLabel="Match rule"
                            value={draft.mode}
                            onChange={(mode) => onDraftChange({ ...draft, mode })}
                            options={[
                                { value: 'any', label: 'Match any' },
                                { value: 'all', label: 'Match all' },
                            ]}
                        />
                        <span className="text-[11px] text-stat-subtitle">
                            {draft.mode === 'any'
                                ? 'A node needs at least one selected label.'
                                : 'A node needs every selected label.'}
                        </span>
                    </div>
                </div>
            )}

            {draft.type === 'labels' && compound && (
                <div className="space-y-3 rounded-lg border border-card-border bg-card p-3">
                    <div>
                        <p className={`${LABEL_KICKER} mb-1.5`}>Nodes with any of these labels</p>
                        <ChipRow
                            labels={knownLabels}
                            selected={compound.any}
                            onToggle={(l) => onDraftChange({ ...draft, compound: { ...compound, any: toggle(compound.any, l) } })}
                            trailing={addLabelControl}
                        />
                    </div>
                    <div>
                        <p className={`${LABEL_KICKER} mb-1.5`}>and also all of these</p>
                        <ChipRow
                            labels={knownLabels}
                            selected={compound.all}
                            onToggle={(l) => onDraftChange({ ...draft, compound: { ...compound, all: toggle(compound.all, l) } })}
                        />
                    </div>
                </div>
            )}

            {draft.type === 'nodes' && (
                <div className="rounded-lg border border-card-border bg-card p-3">
                    <div className="flex flex-wrap gap-1.5">
                        {nodes.map(n => {
                            const on = draft.nodeIds.includes(n.id);
                            return (
                                <button
                                    key={n.id}
                                    type="button"
                                    aria-pressed={on}
                                    onClick={() => onDraftChange({ ...draft, nodeIds: toggle(draft.nodeIds, n.id) })}
                                    className={chipClass(on)}
                                >
                                    {n.name}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            {draft.type === 'labels' && (
                <div className="rounded-lg border border-card-border bg-glass-highlight px-3 py-2" aria-live="polite">
                    <p className={LABEL_KICKER}>
                        {matched.length === 0 ? 'Matches no nodes yet' : `Matches ${plural(matched.length, 'node')}`}
                    </p>
                    <p className="mt-1 text-xs text-stat-subtitle">
                        {matched.length === 0
                            ? 'Choose a label, or tag a node with + Label.'
                            : matched.map(n => n.name).join(', ')}
                    </p>
                    {pendingTags.length > 0 && (
                        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
                            <span className={LABEL_KICKER}>Tags added when you continue</span>
                            {pendingTags.map(s => {
                                const nodeName = nodes.find(n => n.id === s.nodeId)?.name ?? `node ${s.nodeId}`;
                                return (
                                    <span
                                        key={`${s.nodeId}-${s.label}`}
                                        className="inline-flex items-center gap-1 rounded border border-card-border px-1.5 py-0.5 font-mono text-[10px] text-stat-value"
                                    >
                                        {s.label} on {nodeName}
                                        <button
                                            type="button"
                                            aria-label={`Remove tag ${s.label} from ${nodeName}`}
                                            onClick={() => unstage(s)}
                                            className="cursor-pointer text-stat-icon hover:text-stat-value"
                                        >
                                            <X className="h-3 w-3" strokeWidth={1.5} />
                                        </button>
                                    </span>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function chipClass(on: boolean): string {
    return `cursor-pointer rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors ${on
        ? 'border-brand bg-brand/10 text-brand'
        : 'border-card-border text-stat-subtitle hover:text-stat-value'}`;
}

function ChipRow({
    labels, selected, onToggle, trailing, emptyHint,
}: {
    labels: string[];
    selected: string[];
    onToggle: (label: string) => void;
    trailing?: React.ReactNode;
    emptyHint?: string;
}) {
    return (
        <div className="flex flex-wrap items-center gap-1.5">
            {labels.length === 0 && emptyHint && (
                <span className="text-[11px] text-muted-foreground">{emptyHint}</span>
            )}
            {labels.map(l => (
                <button key={l} type="button" aria-pressed={selected.includes(l)} onClick={() => onToggle(l)} className={chipClass(selected.includes(l))}>
                    {l}
                </button>
            ))}
            {trailing}
        </div>
    );
}

function AddLabelPopover({
    nodes, onStage,
}: {
    nodes: readonly TargetNode[];
    onStage: (label: string, nodeIds: number[]) => void;
}) {
    const [open, setOpen] = useState(false);
    const [name, setName] = useState('');
    const [picked, setPicked] = useState<number[]>([]);
    const nameError = validateLabelName(name);
    const error = name.trim() ? nameError : null;
    const canAdd = nameError === null && picked.length > 0;

    function reset() {
        setName('');
        setPicked([]);
    }

    function submit() {
        if (!canAdd) return;
        onStage(name.trim(), picked);
        setOpen(false);
        reset();
    }

    return (
        <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
            <PopoverTrigger asChild>
                <Button type="button" variant="outline" size="sm" className="h-6 gap-1 px-2 text-[10px]">
                    <Plus className="h-3 w-3" strokeWidth={1.5} />
                    Label
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 space-y-3 p-3" align="start">
                <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                    <Tag className="h-3 w-3" strokeWidth={1.5} />
                    Tag nodes with a label
                </div>
                <div className="space-y-1">
                    <Label htmlFor="blueprint-new-label" className={LABEL_KICKER}>Label</Label>
                    <Input
                        id="blueprint-new-label"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
                        placeholder="production"
                        className="h-8 font-mono text-xs"
                        autoFocus
                    />
                    {error && <p className="text-[11px] text-destructive">{error}</p>}
                </div>
                <div className="space-y-1.5">
                    <p className={LABEL_KICKER}>On these nodes</p>
                    <div className="max-h-40 space-y-1.5 overflow-y-auto">
                        {nodes.map(n => (
                            <label key={n.id} className="flex cursor-pointer items-center gap-2 text-xs">
                                <Checkbox
                                    checked={picked.includes(n.id)}
                                    onCheckedChange={(v) => setPicked(v ? [...picked, n.id] : picked.filter(id => id !== n.id))}
                                />
                                <span>{n.name}</span>
                                <span className="font-mono text-[10px] uppercase text-muted-foreground">{n.type}</span>
                            </label>
                        ))}
                    </div>
                </div>
                <p className="text-[11px] leading-relaxed text-stat-subtitle">
                    The label is added to these nodes when you continue, not before.
                </p>
                <Button type="button" size="sm" className="w-full" disabled={!canAdd} onClick={submit}>
                    Add label
                </Button>
            </PopoverContent>
        </Popover>
    );
}
