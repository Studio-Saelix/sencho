import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Save, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BusyButton } from '@/components/ui/busy-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ModalBody, ModalFooter } from '@/components/ui/modal';
import { TogglePill } from '@/components/ui/toggle-pill';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast-store';
import { Editor } from '@/lib/monacoLoader';
import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';
import {
    type AnalyzerResult,
    type Blueprint,
    type ContentBindingView,
    type DriftMode,
    type CreateBlueprintInput,
    type UpdateBlueprintInput,
    analyzeCompose,
    getContentBinding,
} from '@/lib/blueprintsApi';
import { GITOPS_LIMITATION_COPY } from '@/lib/gitopsLimitations';
import {
    type NodeLabelMap,
    type StagedLabel,
    draftFromSelector,
    isDraftEmpty,
    matchNodes,
    plural,
    selectorFromDraft,
    stagedInUse,
    withStagedLabels,
} from '@/lib/blueprintTargets';
import { BlueprintTargets } from './BlueprintTargets';
import { BlueprintClassificationBanner } from './BlueprintClassificationBanner';
import { ContentOriginBadge } from './ContentOriginBadge';

/**
 * What the operator chose to do with the form. `review` continues into the
 * rollout preview; `save` only stores the Blueprint. Staged node labels are
 * written by whichever primary action commits the form, never by a draft save.
 */
export interface BlueprintSubmitOptions {
    intent: 'save' | 'review';
    staged: StagedLabel[];
}

interface BlueprintEditorProps {
    initial?: Blueprint;
    nodeLabels: NodeLabelMap;
    /** Whether this operator can continue into a rollout review after creating. */
    canReview?: boolean;
    onCancel: () => void;
    onSubmit: (input: CreateBlueprintInput | UpdateBlueprintInput, options: BlueprintSubmitOptions) => Promise<void>;
    submitting: boolean;
    mode: 'create' | 'edit';
}

interface FormErrors {
    name?: string;
    compose?: string;
    targets?: string;
}

const DEFAULT_COMPOSE = `# Sencho deploys this file to every node the Blueprint targets.

services:
  app:
    image: nginx:1.27-alpine
    restart: unless-stopped
    ports:
      - "8080:80"
`;

const DRIFT_MODES: Array<{ value: DriftMode; kicker: string; title: string; tagline: string }> = [
    { value: 'observe', kicker: 'Observe', title: 'Detect & display', tagline: 'Shown here, no alerts' },
    { value: 'suggest', kicker: 'Suggest', title: 'Detect & notify', tagline: 'You are alerted and decide' },
    { value: 'enforce', kicker: 'Enforce', title: 'Detect & auto-fix', tagline: 'Redeployed to match, quietly' },
];

export function BlueprintEditor({ initial, nodeLabels, canReview = false, onCancel, onSubmit, submitting, mode }: BlueprintEditorProps) {
    const { nodes } = useNodes();
    const { can } = useAuth();
    const [name, setName] = useState(initial?.name ?? '');
    const [description, setDescription] = useState(initial?.description ?? '');
    const [composeContent, setComposeContent] = useState(initial?.compose_content ?? DEFAULT_COMPOSE);
    const [driftMode, setDriftMode] = useState<DriftMode>(initial?.drift_mode ?? 'suggest');
    const [enabled, setEnabled] = useState(initial?.enabled ?? true);
    const [draft, setDraft] = useState(() => draftFromSelector(initial?.selector ?? { type: 'labels', any: [], all: [] }));
    const [staged, setStaged] = useState<StagedLabel[]>([]);
    const [pendingIntent, setPendingIntent] = useState<'draft' | 'primary' | null>(null);
    const [errors, setErrors] = useState<FormErrors>({});
    const nameRef = useRef<HTMLInputElement>(null);
    const composeRef = useRef<HTMLDivElement>(null);
    const targetsRef = useRef<HTMLDivElement>(null);

    const [analysis, setAnalysis] = useState<AnalyzerResult | null>(null);
    const [analyzing, setAnalyzing] = useState(false);
    const [analyzeFailed, setAnalyzeFailed] = useState(false);
    const [binding, setBinding] = useState<ContentBindingView | null>(null);
    const [bindingError, setBindingError] = useState(false);
    const gitManaged = initial?.content_origin === 'git';

    // Debounced classification on compose change. Use a generation counter so
    // out-of-order responses can't stamp a stale classification when the user
    // types faster than the analyze endpoint responds.
    const analyzeGen = useRef(0);
    useEffect(() => {
        const t = setTimeout(async () => {
            if (!composeContent.trim()) {
                analyzeGen.current += 1;
                setAnalysis(null);
                setAnalyzing(false);
                setAnalyzeFailed(false);
                return;
            }
            const gen = ++analyzeGen.current;
            setAnalyzing(true);
            try {
                const result = await analyzeCompose(composeContent);
                if (gen !== analyzeGen.current) return; // a newer request superseded us
                setAnalysis(result);
                setAnalyzeFailed(false);
            } catch (err) {
                console.error('[Blueprints] compose analysis failed:', err);
                if (gen === analyzeGen.current) {
                    // A stale classification beside "Could not analyze" would describe the previous compose.
                    setAnalysis(null);
                    setAnalyzeFailed(true);
                }
            } finally {
                if (gen === analyzeGen.current) setAnalyzing(false);
            }
        }, 600);
        return () => clearTimeout(t);
    }, [composeContent]);

    useEffect(() => {
        if (!gitManaged || initial?.id == null) return;
        let cancelled = false;
        setBinding(null);
        setBindingError(false);
        void getContentBinding(initial.id)
            .then((next) => {
                if (cancelled) return;
                setBinding(next);
            })
            .catch((err: unknown) => {
                if (cancelled) return;
                setBindingError(true);
                toast.error(err instanceof Error ? err.message : 'Failed to load the Git-managed source');
            });
        return () => { cancelled = true; };
    }, [gitManaged, initial?.id]);

    const selector = useMemo(() => selectorFromDraft(draft), [draft]);
    const matchedCount = useMemo(
        () => matchNodes(selector, nodes, withStagedLabels(nodeLabels, staged)).length,
        [selector, nodes, nodeLabels, staged],
    );
    const isStatefulMulti = analysis?.classification === 'stateful' && matchedCount > 1;

    function validate(): FormErrors {
        const found: FormErrors = {};
        if (mode === 'create') {
            if (!name.trim()) found.name = 'Give the Blueprint a name';
            else if (!/^[a-z0-9][a-z0-9_-]*$/.test(name.trim())) found.name = 'Use lowercase letters, digits, hyphens or underscores, starting with a letter or digit';
        }
        if (!composeContent.trim()) found.compose = 'Compose content cannot be empty';
        if (isDraftEmpty(draft)) found.targets = draft.type === 'labels' ? 'Pick at least one label' : 'Pick at least one node';
        return found;
    }

    function revealFirstError(found: FormErrors) {
        if (found.name) nameRef.current?.focus();
        else if (found.compose) composeRef.current?.scrollIntoView?.({ block: 'center' });
        else targetsRef.current?.scrollIntoView?.({ block: 'center' });
    }

    // Create mode offers a draft save only when the operator can review a rollout
    // and the Blueprint is enabled; otherwise one primary action commits the form.
    const offersDraft = mode === 'create' && canReview && enabled;
    const primaryIntent: BlueprintSubmitOptions['intent'] = offersDraft ? 'review' : 'save';

    async function handleSubmit(which: 'draft' | 'primary') {
        const found = validate();
        setErrors(found);
        if (Object.keys(found).length > 0) { revealFirstError(found); return; }
        const fields = {
            name: name.trim(),
            description: description.trim() || null,
            selector,
            drift_mode: driftMode,
            enabled,
        };
        const options: BlueprintSubmitOptions = which === 'draft'
            ? { intent: 'save', staged: [] }
            : { intent: primaryIntent, staged: stagedInUse(staged, selector) };
        setPendingIntent(which);
        try {
            // A Git-managed Blueprint's compose lives in its Git source, never in this form.
            const input = mode === 'edit' && gitManaged ? fields : { ...fields, compose_content: composeContent };
            await onSubmit(input, options);
        } finally {
            setPendingIntent(null);
        }
    }

    const tags = stagedInUse(staged, selector).length;
    function footerHint(): string | undefined {
        const labels = plural(tags, 'node label');
        if (offersDraft) return tags > 0 ? `Review adds ${labels}. A draft does not` : 'Nothing deploys until you confirm';
        if (tags === 0) return undefined;
        return mode === 'edit' ? `Adds ${labels} on save` : `Adds ${labels}`;
    }
    const hint = footerHint();

    const cancelButton = <Button variant="outline" size="sm" onClick={onCancel} disabled={submitting}>Cancel</Button>;
    const draftButton = offersDraft ? (
        <BusyButton
            variant="outline"
            size="sm"
            pending={submitting && pendingIntent === 'draft'}
            disabled={submitting}
            busyLabel="Saving…"
            onClick={() => void handleSubmit('draft')}
        >
            Save as draft
        </BusyButton>
    ) : null;
    const primaryButton = (
        <BusyButton
            size="sm"
            className="gap-2"
            pending={submitting && pendingIntent === 'primary'}
            disabled={submitting}
            busyLabel={mode === 'create' ? 'Creating…' : 'Saving…'}
            onClick={() => void handleSubmit('primary')}
        >
            {mode === 'create' ? <Sparkles className="h-4 w-4" /> : <Save className="h-4 w-4" />}
            {offersDraft ? 'Review rollout' : mode === 'create' ? 'Create blueprint' : 'Save changes'}
        </BusyButton>
    );

    const fieldsBlock = (
        <>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                    <Label className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">Name</Label>
                    <Input
                        ref={nameRef}
                        value={name}
                        onChange={e => { setName(e.target.value); setErrors(prev => ({ ...prev, name: undefined })); }}
                        placeholder="caddy-edge"
                        className={`font-mono ${errors.name ? 'border-destructive' : ''}`}
                        aria-invalid={errors.name ? true : undefined}
                        disabled={mode === 'edit'}
                    />
                    {errors.name && <p role="alert" className="text-[11px] text-destructive">{errors.name}</p>}
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
                    <div className="flex items-center gap-2">
                        <ContentOriginBadge origin={initial?.content_origin ?? 'inline'} />
                        {analyzing && (
                            <span className="font-mono text-[10px] text-muted-foreground uppercase tracking-[0.18em]">
                                Analyzing…
                            </span>
                        )}
                        {analyzeFailed && !analyzing && (
                            <span className="font-mono text-[10px] text-warning uppercase tracking-[0.18em]">
                                Could not analyze
                            </span>
                        )}
                    </div>
                </div>
                {gitManaged && (
                    <div className="space-y-2 rounded-lg border border-card-border bg-card p-3">
                        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">Git-managed source</p>
                        <p className="text-xs text-stat-subtitle leading-relaxed">
                            {bindingError
                                ? 'Could not load the Git-managed source.'
                                : `${binding?.repoUrl ?? 'repository unknown'} · ${binding?.ref ?? 'ref unknown'}`}
                        </p>
                        {binding?.composePaths && binding.composePaths.length > 0 && (
                            <p className="font-mono text-[10px] text-stat-icon">{binding.composePaths.join(', ')}</p>
                        )}
                        {binding?.blockedRollout && (
                            <p className="text-xs text-warning leading-relaxed">
                                {GITOPS_LIMITATION_COPY.git_managed_rollout_not_enabled}
                            </p>
                        )}
                    </div>
                )}
                <BlueprintClassificationBanner analysis={analysis} />
                <div ref={composeRef} className="rounded-lg border border-card-border overflow-hidden">
                    <Suspense fallback={<Skeleton className="h-[320px] w-full" />}>
                        <Editor
                            height="320px"
                            language="yaml"
                            value={composeContent}
                            onChange={(v) => { if (!gitManaged) { setComposeContent(v ?? ''); setErrors(prev => ({ ...prev, compose: undefined })); } }}
                            options={{
                                minimap: { enabled: false },
                                scrollBeyondLastLine: false,
                                fontSize: 12,
                                fontFamily: 'var(--font-mono)',
                                readOnly: gitManaged,
                            }}
                            theme="vs-dark"
                        />
                    </Suspense>
                </div>
                {errors.compose && <p role="alert" className="text-[11px] text-destructive">{errors.compose}</p>}
                {isStatefulMulti && (
                    <p className="flex items-start gap-2 text-xs leading-relaxed text-stat-subtitle">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" strokeWidth={1.5} />
                        This blueprint is stateful and targets more than one node. Each node keeps its own data; Sencho does not replicate volumes.
                    </p>
                )}
            </div>

            <div ref={targetsRef} className="space-y-2">
                <Label className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">Targets</Label>
                <BlueprintTargets
                    draft={draft}
                    onDraftChange={(next) => { setDraft(next); if (!isDraftEmpty(next)) setErrors(prev => ({ ...prev, targets: undefined })); }}
                    nodes={nodes}
                    nodeLabels={nodeLabels}
                    staged={staged}
                    onStagedChange={setStaged}
                    canLabelNode={(id) => can('node:manage', 'node', String(id))}
                />
                {errors.targets && <p role="alert" className="text-[11px] text-destructive">{errors.targets}</p>}
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
                <div className="flex items-center justify-between gap-3 rounded-lg border border-card-border bg-card px-3 py-2">
                    <div className="min-w-0">
                        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-icon">Reconciler</p>
                        <p className="text-[11px] text-stat-subtitle">
                            {enabled
                                ? 'Sencho keeps targeted nodes in sync once you confirm a rollout.'
                                : 'Off: the Blueprint is saved but never deployed or repaired.'}
                        </p>
                    </div>
                    <TogglePill checked={enabled} onChange={setEnabled} aria-label="Reconciler enabled" />
                </div>
            </div>
        </>
    );

    // Create renders inside a Modal, so its actions are the Modal's pinned footer;
    // edit renders inside the detail sheet, where the actions follow the fields.
    const isCreate = mode === 'create';
    if (isCreate) {
        return (
            <>
                <ModalBody fill className="space-y-5">
                    {fieldsBlock}
                </ModalBody>
                <ModalFooter hint={hint} secondary={<>{cancelButton}{draftButton}</>} primary={primaryButton} />
            </>
        );
    }

    return (
        <div className="space-y-5">
            {fieldsBlock}
            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">{hint}</span>
                <div className="flex items-center gap-2">
                    {cancelButton}
                    {primaryButton}
                </div>
            </div>
        </div>
    );
}
