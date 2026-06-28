import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Save, Sparkles, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast-store';
import { Editor } from '@/lib/monacoLoader';
import { useNodes } from '@/context/NodeContext';
import {
    type AnalyzerResult,
    type Blueprint,
    type BlueprintSelector,
    type DriftMode,
    type CreateBlueprintInput,
    type UpdateBlueprintInput,
    analyzeCompose,
} from '@/lib/blueprintsApi';
import { BlueprintClassificationBanner } from './BlueprintClassificationBanner';

interface BlueprintEditorProps {
    initial?: Blueprint;
    distinctLabels: string[];
    onCancel: () => void;
    onSubmit: (input: CreateBlueprintInput | UpdateBlueprintInput) => Promise<void>;
    submitting: boolean;
    mode: 'create' | 'edit';
}

const DEFAULT_COMPOSE = `# Blueprint compose. Sencho writes this file plus a .blueprint.json marker
# to <COMPOSE_DIR>/<blueprint-name>/ on every targeted node.

services:
  app:
    image: nginx:1.27-alpine
    restart: unless-stopped
    ports:
      - "8080:80"
`;

const DRIFT_MODES: Array<{ value: DriftMode; kicker: string; title: string; tagline: string }> = [
    { value: 'observe', kicker: 'Observe', title: 'Detect & display', tagline: 'no notifications' },
    { value: 'suggest', kicker: 'Suggest', title: 'Detect & notify', tagline: 'operator decides' },
    { value: 'enforce', kicker: 'Enforce', title: 'Detect & auto-fix', tagline: 'silent on success' },
];

export function BlueprintEditor({ initial, distinctLabels, onCancel, onSubmit, submitting, mode }: BlueprintEditorProps) {
    const { nodes } = useNodes();
    const [name, setName] = useState(initial?.name ?? '');
    const [description, setDescription] = useState(initial?.description ?? '');
    const [composeContent, setComposeContent] = useState(initial?.compose_content ?? DEFAULT_COMPOSE);
    const [driftMode, setDriftMode] = useState<DriftMode>(initial?.drift_mode ?? 'suggest');
    const [enabled, setEnabled] = useState(initial?.enabled ?? true);
    const initialSelector: BlueprintSelector = initial?.selector ?? { type: 'labels', any: [], all: [] };
    const [selectorType, setSelectorType] = useState<'labels' | 'nodes'>(initialSelector.type);
    const [labelsAny, setLabelsAny] = useState<string[]>(initialSelector.type === 'labels' ? initialSelector.any : []);
    const [labelsAll, setLabelsAll] = useState<string[]>(initialSelector.type === 'labels' ? initialSelector.all : []);
    const [nodeIds, setNodeIds] = useState<number[]>(initialSelector.type === 'nodes' ? initialSelector.ids : []);

    const [analysis, setAnalysis] = useState<AnalyzerResult | null>(null);
    const [analyzing, setAnalyzing] = useState(false);

    // Debounced classification on compose change. Use a generation counter so
    // out-of-order responses can't stamp a stale classification when the user
    // types faster than the analyze endpoint responds.
    const analyzeGen = useRef(0);
    useEffect(() => {
        const t = setTimeout(async () => {
            if (!composeContent.trim()) {
                setAnalysis(null);
                return;
            }
            const gen = ++analyzeGen.current;
            setAnalyzing(true);
            try {
                const result = await analyzeCompose(composeContent);
                if (gen !== analyzeGen.current) return; // a newer request superseded us
                setAnalysis(result);
            } catch {
                // Silent fail; banner shows "not analyzed yet" until next try
            } finally {
                if (gen === analyzeGen.current) setAnalyzing(false);
            }
        }, 600);
        return () => clearTimeout(t);
    }, [composeContent]);

    const selector: BlueprintSelector = useMemo(() => {
        if (selectorType === 'nodes') return { type: 'nodes', ids: nodeIds };
        return { type: 'labels', any: labelsAny, all: labelsAll };
    }, [selectorType, nodeIds, labelsAny, labelsAll]);

    const isStatefulMulti = analysis?.classification === 'stateful' && (
        (selectorType === 'labels' && (labelsAny.length > 0 || labelsAll.length > 0)) ||
        (selectorType === 'nodes' && nodeIds.length > 1)
    );

    function toggleLabel(list: string[], setList: (v: string[]) => void, label: string) {
        if (list.includes(label)) setList(list.filter(l => l !== label));
        else setList([...list, label]);
    }

    function toggleNode(id: number) {
        if (nodeIds.includes(id)) setNodeIds(nodeIds.filter(n => n !== id));
        else setNodeIds([...nodeIds, id]);
    }

    function validate(): string | null {
        if (mode === 'create') {
            if (!name.trim()) return 'Blueprint needs a name';
            if (!/^[a-z0-9][a-z0-9_-]*$/.test(name.trim())) return 'Name must be lowercase letters, digits, hyphens, or underscores (must start with a letter or digit)';
        }
        if (!composeContent.trim()) return 'Compose content cannot be empty';
        if (selectorType === 'labels' && labelsAny.length === 0 && labelsAll.length === 0) return 'Pick at least one label';
        if (selectorType === 'nodes' && nodeIds.length === 0) return 'Pick at least one node';
        return null;
    }

    async function handleSubmit() {
        const err = validate();
        if (err) { toast.error(err); return; }
        const input = mode === 'create'
            ? {
                name: name.trim(),
                description: description.trim() || null,
                compose_content: composeContent,
                selector,
                drift_mode: driftMode,
                enabled,
            } satisfies CreateBlueprintInput
            : {
                name: name.trim(),
                description: description.trim() || null,
                compose_content: composeContent,
                selector,
                drift_mode: driftMode,
                enabled,
            } satisfies UpdateBlueprintInput;
        await onSubmit(input);
    }

    return (
        <div className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                    <Label className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">Name</Label>
                    <Input
                        value={name}
                        onChange={e => setName(e.target.value)}
                        placeholder="caddy-edge"
                        className="font-mono"
                        disabled={mode === 'edit'}
                    />
                    {mode === 'edit' && (
                        <p className="text-[10px] text-muted-foreground">Name is fixed once a blueprint exists.</p>
                    )}
                </div>
                <div className="space-y-1.5">
                    <Label className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">Description</Label>
                    <Input
                        value={description}
                        onChange={e => setDescription(e.target.value)}
                        placeholder="Reverse proxy across the production tier"
                    />
                </div>
            </div>

            <div className="space-y-2">
                <div className="flex items-center justify-between">
                    <Label className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">
                        Compose
                    </Label>
                    {analyzing && (
                        <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.18em]">
                            Analyzing…
                        </span>
                    )}
                </div>
                <BlueprintClassificationBanner analysis={analysis} />
                <div className="rounded-lg border border-card-border overflow-hidden">
                    <Suspense fallback={<Skeleton className="h-[320px] w-full" />}>
                        <Editor
                            height="320px"
                            language="yaml"
                            value={composeContent}
                            onChange={(v) => setComposeContent(v ?? '')}
                            options={{
                                minimap: { enabled: false },
                                scrollBeyondLastLine: false,
                                fontSize: 12,
                                fontFamily: 'var(--font-mono)',
                            }}
                            theme="vs-dark"
                        />
                    </Suspense>
                </div>
                {isStatefulMulti && (
                    <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3">
                        <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" strokeWidth={1.5} />
                        <p className="text-xs text-stat-subtitle leading-relaxed">
                            This blueprint is stateful and targets multiple nodes. Each node will hold its own data; Sencho does not replicate volumes between nodes.
                        </p>
                    </div>
                )}
            </div>

            <div className="space-y-2">
                <Label className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">Selector</Label>
                <div className="flex gap-1">
                    <Button
                        size="sm"
                        variant={selectorType === 'labels' ? 'default' : 'outline'}
                        onClick={() => setSelectorType('labels')}
                    >
                        Labels
                    </Button>
                    <Button
                        size="sm"
                        variant={selectorType === 'nodes' ? 'default' : 'outline'}
                        onClick={() => setSelectorType('nodes')}
                    >
                        Specific nodes
                    </Button>
                </div>
                {selectorType === 'labels' ? (
                    <div className="space-y-3 rounded-lg border border-card-border bg-card p-3">
                        <div>
                            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon mb-1.5">Match nodes with ANY of these labels</p>
                            <div className="flex flex-wrap gap-1.5">
                                {distinctLabels.length === 0 && (
                                    <span className="text-[10px] text-muted-foreground">
                                        No node labels yet. Add labels in Settings → Nodes.
                                    </span>
                                )}
                                {distinctLabels.map(l => (
                                    <button
                                        key={`any-${l}`}
                                        type="button"
                                        onClick={() => toggleLabel(labelsAny, setLabelsAny, l)}
                                        className={`cursor-pointer rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors ${labelsAny.includes(l)
                                            ? 'border-brand bg-brand/10 text-brand'
                                            : 'border-card-border text-stat-subtitle hover:text-stat-value'
                                        }`}
                                    >
                                        {l}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <div>
                            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon mb-1.5">AND ALSO require ALL of these</p>
                            <div className="flex flex-wrap gap-1.5">
                                {distinctLabels.map(l => (
                                    <button
                                        key={`all-${l}`}
                                        type="button"
                                        onClick={() => toggleLabel(labelsAll, setLabelsAll, l)}
                                        className={`cursor-pointer rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] transition-colors ${labelsAll.includes(l)
                                            ? 'border-brand bg-brand/10 text-brand'
                                            : 'border-card-border text-stat-subtitle hover:text-stat-value'
                                        }`}
                                    >
                                        {l}
                                    </button>
                                ))}
                            </div>
                        </div>
                        {(labelsAny.length > 0 || labelsAll.length > 0) && (
                            <p className="font-mono text-[10px] text-stat-icon">
                                Resolves to nodes labelled {[
                                    labelsAll.length > 0 ? `all of [${labelsAll.join(', ')}]` : '',
                                    labelsAny.length > 0 ? `any of [${labelsAny.join(', ')}]` : '',
                                ].filter(Boolean).join(' AND ')}.
                            </p>
                        )}
                    </div>
                ) : (
                    <div className="space-y-2 rounded-lg border border-card-border bg-card p-3">
                        {nodes.map(n => (
                            <label key={n.id} className="flex items-center gap-2 text-sm cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={nodeIds.includes(n.id)}
                                    onChange={() => toggleNode(n.id)}
                                    className="cursor-pointer"
                                />
                                <span>{n.name}</span>
                                <span className="text-[10px] text-muted-foreground font-mono uppercase">{n.type}</span>
                            </label>
                        ))}
                    </div>
                )}
            </div>

            <div className="space-y-2">
                <Label className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">Drift policy</Label>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    {DRIFT_MODES.map(opt => {
                        const selected = driftMode === opt.value;
                        return (
                            <button
                                key={opt.value}
                                type="button"
                                onClick={() => setDriftMode(opt.value)}
                                className={`text-left rounded-lg border p-3 transition-colors cursor-pointer ${selected
                                    ? 'border-brand/50 bg-brand/5 border-l-2 border-l-brand'
                                    : 'border-card-border bg-card hover:border-t-card-border-hover'
                                }`}
                            >
                                <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-brand">
                                    <span className={`inline-block w-2 h-2 rounded-full ${selected ? 'bg-brand' : 'border border-stat-icon'}`} />
                                    {opt.kicker}
                                </div>
                                <p className="font-heading text-sm mt-1.5 text-stat-value">{opt.title}</p>
                                <p className="text-[10px] text-stat-subtitle mt-0.5">{opt.tagline}</p>
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="flex items-center justify-between border-t border-border pt-4">
                <label className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
                    <span className="text-xs text-stat-subtitle">Reconciler enabled</span>
                </label>
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" onClick={onCancel} disabled={submitting}>Cancel</Button>
                    <Button size="sm" onClick={handleSubmit} disabled={submitting} className="gap-2">
                        {mode === 'create' ? <Sparkles className="h-4 w-4" /> : <Save className="h-4 w-4" />}
                        {submitting ? 'Saving…' : mode === 'create' ? 'Create blueprint' : 'Save changes'}
                    </Button>
                </div>
            </div>

            {!analysis?.parseError && analysis?.classification === 'stateful' && (
                <div className="flex items-start gap-2 text-xs text-stat-subtitle">
                    <Zap className="h-3 w-3 text-warning shrink-0 mt-0.5" strokeWidth={1.5} />
                    <span>Stateful blueprints require explicit confirmation on first deploy and on eviction. The deployment table will surface those prompts.</span>
                </div>
            )}
        </div>
    );
}
