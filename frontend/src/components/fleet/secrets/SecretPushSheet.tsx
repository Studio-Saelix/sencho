import { useEffect, useMemo, useState } from 'react';
import { Loader2, Send, ChevronDown, ChevronRight, CheckCircle2, AlertCircle, MinusCircle, type LucideIcon } from 'lucide-react';
import { SystemSheet, SheetSection, type SystemSheetTab } from '@/components/ui/system-sheet';
import { Input } from '@/components/ui/input';
import { MultiSelectCombobox, type MultiSelectOption } from '@/components/ui/multi-select-combobox';
import { toast } from '@/components/ui/toast-store';
import { useNodes } from '@/context/NodeContext';
import { listDistinctLabels, type BlueprintSelector } from '@/lib/blueprintsApi';
import {
    type SecretSummary,
    type SecretPushPlanEntry,
    type SecretPushResultEntry,
    type SecretPushStatus,
    type DiffStatus,
    previewPush,
    executePush,
} from '@/lib/secretsApi';
import { apiFetch } from '@/lib/api';

interface Props {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    secret: SecretSummary | null;
}

type Stage = 'target' | 'preview' | 'results';

const DIFF_STATUS_COLOR: Record<DiffStatus, string> = {
    added: 'text-emerald-500',
    changed: 'text-amber-500',
    removed: 'text-stat-subtitle',
    unchanged: 'text-stat-subtitle/60',
};

const RESULT_ICON: Record<SecretPushStatus, LucideIcon> = {
    ok: CheckCircle2,
    failed: AlertCircle,
    skipped: MinusCircle,
};

const RESULT_ICON_CLASS: Record<SecretPushStatus, string> = {
    ok: 'text-emerald-500',
    failed: 'text-destructive',
    skipped: 'text-stat-subtitle',
};

export function SecretPushSheet({ open, onOpenChange, secret }: Props) {
    const { nodes } = useNodes();
    const [stage, setStage] = useState<Stage>('target');
    const [labelMode, setLabelMode] = useState<'any' | 'all'>('any');
    const [selectedLabels, setSelectedLabels] = useState<Set<string>>(new Set());
    const [allLabels, setAllLabels] = useState<string[]>([]);
    const [stackName, setStackName] = useState('');
    const [envFiles, setEnvFiles] = useState<string[]>([]);
    const [envFile, setEnvFile] = useState('.env');
    const [envFilesLoading, setEnvFilesLoading] = useState(false);
    const [previewLoading, setPreviewLoading] = useState(false);
    const [pushLoading, setPushLoading] = useState(false);
    const [plan, setPlan] = useState<SecretPushPlanEntry[]>([]);
    const [results, setResults] = useState<SecretPushResultEntry[]>([]);
    const [expanded, setExpanded] = useState<Set<number>>(new Set());

    useEffect(() => {
        if (!open) return;
        setStage('target');
        setSelectedLabels(new Set());
        setStackName('');
        setEnvFiles([]);
        setEnvFile('.env');
        setPlan([]);
        setResults([]);
        setExpanded(new Set());
        listDistinctLabels()
            .then(setAllLabels)
            .catch(() => setAllLabels([]));
    }, [open]);

    const labelOptions: MultiSelectOption[] = useMemo(
        () => allLabels.map((l) => ({ value: l, label: l })),
        [allLabels],
    );

    function buildSelector(): BlueprintSelector {
        const labels = Array.from(selectedLabels);
        return { type: 'labels', any: labelMode === 'any' ? labels : [], all: labelMode === 'all' ? labels : [] };
    }

    async function loadEnvFiles() {
        if (!stackName.trim()) return;
        const ref = nodes[0];
        if (!ref) return;
        setEnvFilesLoading(true);
        try {
            const res = await apiFetch(`/stacks/${encodeURIComponent(stackName.trim())}/envs`, {
                headers: { 'x-node-id': String(ref.id) },
            });
            if (!res.ok) {
                setEnvFiles([]);
                setEnvFile('.env');
                return;
            }
            const body = await res.json() as { envFiles?: string[] };
            const basenames = (body.envFiles ?? []).map((p) => p.split(/[\\/]/).pop() ?? '');
            const unique = Array.from(new Set(basenames.filter(Boolean)));
            if (!unique.includes('.env')) unique.unshift('.env');
            setEnvFiles(unique);
            if (!unique.includes(envFile)) setEnvFile(unique[0] ?? '.env');
        } catch {
            setEnvFiles([]);
        } finally {
            setEnvFilesLoading(false);
        }
    }

    useEffect(() => {
        if (stage !== 'target') return;
        if (!stackName.trim()) {
            setEnvFiles([]);
            return;
        }
        const t = setTimeout(() => { void loadEnvFiles(); }, 250);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [stage, stackName, nodes.length]);

    async function handlePreview() {
        if (!secret) return;
        if (selectedLabels.size === 0) {
            toast.error('Pick at least one label');
            return;
        }
        if (!stackName.trim()) {
            toast.error('Stack name is required');
            return;
        }
        setPreviewLoading(true);
        try {
            const result = await previewPush(secret.id, {
                selector: buildSelector(),
                stackName: stackName.trim(),
                envFileBasename: envFile,
            });
            if (result.length === 0) {
                toast.error('No nodes match this selector');
                return;
            }
            setPlan(result);
            setStage('preview');
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to preview push');
        } finally {
            setPreviewLoading(false);
        }
    }

    async function handlePush() {
        if (!secret) return;
        setPushLoading(true);
        try {
            const result = await executePush(secret.id, {
                selector: buildSelector(),
                stackName: stackName.trim(),
                envFileBasename: envFile,
            });
            setResults(result.results);
            setStage('results');
            const okCount = result.results.filter(r => r.status === 'ok').length;
            const failCount = result.results.length - okCount;
            if (failCount === 0) toast.success(`Pushed to ${okCount} ${okCount === 1 ? 'node' : 'nodes'}`);
            else toast.error(`${okCount} ok · ${failCount} failed`);
        } catch (err) {
            toast.error(err instanceof Error ? err.message : 'Failed to push secret');
        } finally {
            setPushLoading(false);
        }
    }

    function toggleExpanded(nodeId: number) {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(nodeId)) next.delete(nodeId);
            else next.add(nodeId);
            return next;
        });
    }

    const tabs: SystemSheetTab[] = [
        { id: 'target', label: 'Target' },
        { id: 'preview', label: 'Preview' },
        { id: 'results', label: 'Results' },
    ];

    const primaryAction = (() => {
        if (stage === 'target') return {
            label: previewLoading ? 'Previewing…' : 'Preview',
            onClick: handlePreview,
            disabled: previewLoading || selectedLabels.size === 0 || !stackName.trim(),
            icon: previewLoading ? Loader2 : undefined,
        };
        if (stage === 'preview') return {
            label: pushLoading ? 'Pushing…' : `Push to ${plan.length} ${plan.length === 1 ? 'node' : 'nodes'}`,
            onClick: handlePush,
            disabled: pushLoading,
            icon: Send,
        };
        return {
            label: 'Done',
            onClick: () => onOpenChange(false),
        };
    })();

    return (
        <SystemSheet
            open={open}
            onOpenChange={onOpenChange}
            crumb={['Fleet', 'Secrets', secret?.name ?? '', 'Push']}
            name={secret ? `Push '${secret.name}'` : 'Push secret'}
            meta={secret ? `v${secret.currentVersion} · ${secret.keyCount} keys` : undefined}
            primaryAction={primaryAction}
            tabs={tabs}
            activeTab={stage}
            onTabChange={(id) => {
                if (id === 'target') setStage('target');
                else if (id === 'preview' && plan.length > 0) setStage('preview');
                else if (id === 'results' && results.length > 0) setStage('results');
            }}
            size="xl"
        >
            {stage === 'target' && (
                <div className="space-y-5">
                    <SheetSection title="Target nodes">
                        <div className="space-y-3">
                            <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] font-mono text-stat-subtitle">
                                <span>Match</span>
                                <button
                                    type="button"
                                    className={`px-2 py-0.5 rounded border ${labelMode === 'any' ? 'border-brand text-stat-value' : 'border-card-border text-stat-subtitle'}`}
                                    onClick={() => setLabelMode('any')}
                                >
                                    any
                                </button>
                                <button
                                    type="button"
                                    className={`px-2 py-0.5 rounded border ${labelMode === 'all' ? 'border-brand text-stat-value' : 'border-card-border text-stat-subtitle'}`}
                                    onClick={() => setLabelMode('all')}
                                >
                                    all
                                </button>
                                <span>of these labels</span>
                            </div>
                            <MultiSelectCombobox
                                options={labelOptions}
                                selected={selectedLabels}
                                onSelectionChange={setSelectedLabels}
                                placeholder="Pick labels…"
                                emptyText={allLabels.length === 0 ? 'No node labels yet. Add them via Fleet › Overview.' : 'No matches'}
                            />
                            {selectedLabels.size > 0 && (
                                <p className="text-[10px] uppercase tracking-[0.18em] font-mono text-stat-subtitle">
                                    {nodes.length} node{nodes.length === 1 ? '' : 's'} known to fleet · preview will resolve exact matches
                                </p>
                            )}
                        </div>
                    </SheetSection>

                    <SheetSection title="Target stack">
                        <div className="space-y-3">
                            <div className="space-y-1">
                                <label htmlFor="push-stack" className="block text-[10px] uppercase tracking-[0.18em] font-mono text-stat-subtitle">Stack name</label>
                                <Input
                                    id="push-stack"
                                    value={stackName}
                                    onChange={(e) => setStackName(e.target.value)}
                                    placeholder="my-app"
                                    className="font-mono"
                                />
                            </div>
                            <div className="space-y-1">
                                <label htmlFor="push-envfile" className="block text-[10px] uppercase tracking-[0.18em] font-mono text-stat-subtitle">Env file</label>
                                <select
                                    id="push-envfile"
                                    value={envFile}
                                    onChange={(e) => setEnvFile(e.target.value)}
                                    disabled={envFilesLoading || envFiles.length === 0}
                                    className="font-mono text-sm rounded border border-card-border bg-popover/40 px-2 py-1.5 min-w-[200px]"
                                >
                                    {envFiles.length === 0 ? <option value=".env">.env</option> : envFiles.map((f) => <option key={f} value={f}>{f}</option>)}
                                </select>
                                <p className="text-[10px] text-stat-subtitle leading-relaxed">
                                    Lists files declared by the stack&apos;s compose on a representative target. Per-node compose can differ; nodes that don&apos;t declare the chosen file are reported as failed.
                                </p>
                            </div>
                        </div>
                    </SheetSection>
                </div>
            )}

            {stage === 'preview' && (
                <div className="space-y-3">
                    {plan.length === 0 && (
                        <div className="text-sm text-stat-subtitle">Run preview from the Target tab.</div>
                    )}
                    {plan.map((entry) => (
                        <div key={entry.nodeId} className="rounded border border-card-border/60 bg-popover/40">
                            <button
                                type="button"
                                onClick={() => toggleExpanded(entry.nodeId)}
                                className="w-full flex items-center gap-3 px-3 py-2 text-left"
                            >
                                {expanded.has(entry.nodeId) ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                                <span className="font-mono text-sm flex-1 truncate">{entry.nodeName}</span>
                                {!entry.reachable || !entry.stackExists ? (
                                    <span className="text-xs text-destructive">{entry.error ?? 'unreachable'}</span>
                                ) : (
                                    <span className="font-mono text-xs tabular-nums flex items-center gap-2">
                                        <span className="text-emerald-500">+{entry.added}</span>
                                        <span className="text-amber-500">~{entry.changed}</span>
                                        <span className="text-stat-subtitle">·{entry.unchanged}</span>
                                        {entry.removedInformational > 0 && <span className="text-stat-subtitle">drift {entry.removedInformational}</span>}
                                    </span>
                                )}
                            </button>
                            {expanded.has(entry.nodeId) && entry.diff.length > 0 && (
                                <div className="border-t border-card-border/40 px-3 py-2 space-y-1">
                                    {entry.diff.map((d) => (
                                        <div key={d.key} className="flex items-baseline gap-2 font-mono text-xs">
                                            <span className={`w-16 uppercase tracking-[0.18em] text-[10px] ${DIFF_STATUS_COLOR[d.status]}`}>{d.status}</span>
                                            <span className="flex-1 truncate">{d.key}</span>
                                            {d.status === 'changed' && <span className="text-stat-subtitle">old to new</span>}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}

            {stage === 'results' && (
                <div className="space-y-2">
                    {results.map((r) => {
                        const Icon = RESULT_ICON[r.status];
                        return (
                            <div key={r.nodeId} className="rounded border border-card-border/60 bg-popover/40 px-3 py-2 flex items-center gap-3">
                                <Icon className={`w-4 h-4 ${RESULT_ICON_CLASS[r.status]}`} />
                                <span className="font-mono text-sm flex-1 truncate">{r.nodeName}</span>
                                {r.status === 'ok' ? (
                                    <span className="font-mono text-xs tabular-nums flex items-center gap-2">
                                        <span className="text-emerald-500">+{r.added}</span>
                                        <span className="text-amber-500">~{r.changed}</span>
                                        <span className="text-stat-subtitle">·{r.unchanged}</span>
                                    </span>
                                ) : (
                                    <span className="text-xs text-destructive truncate max-w-[300px]" title={r.error}>{r.error ?? r.status}</span>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </SystemSheet>
    );
}
