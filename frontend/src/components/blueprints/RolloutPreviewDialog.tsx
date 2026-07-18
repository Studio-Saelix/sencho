import { useEffect, useRef, useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import {
    type BlueprintPreview,
    previewBlueprint,
    applyBlueprint,
} from '@/lib/blueprintsApi';

interface RolloutPreviewDialogProps {
    blueprintId: number;
    blueprintName: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onApplied: () => void;
}

function approvalLabel(value: BlueprintPreview['effectiveApproval']): string {
    if (value === 'reapproval_required') return 'reapproval required';
    return value;
}

function sectionBorderClass(tone: 'destructive' | 'warning' | 'neutral'): string {
    if (tone === 'destructive') return 'border-destructive/30 bg-destructive/5';
    if (tone === 'warning') return 'border-warning/30 bg-warning/5';
    return 'border-card-border bg-glass-highlight';
}

export function RolloutPreviewDialog({
    blueprintId,
    blueprintName,
    open,
    onOpenChange,
    onApplied,
}: RolloutPreviewDialogProps) {
    const [preview, setPreview] = useState<BlueprintPreview | null>(null);
    const [loading, setLoading] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const onOpenChangeRef = useRef(onOpenChange);
    useEffect(() => { onOpenChangeRef.current = onOpenChange; }, [onOpenChange]);

    useEffect(() => {
        if (!open) {
            setPreview(null);
            setSubmitting(false);
            return;
        }
        let cancelled = false;
        setLoading(true);
        setPreview(null);
        previewBlueprint(blueprintId)
            .then((result) => {
                if (!cancelled) setPreview(result);
            })
            .catch((err) => {
                if (cancelled) return;
                toast.error(err instanceof Error ? err.message : 'Failed to preview rollout');
                onOpenChangeRef.current(false);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => { cancelled = true; };
    }, [open, blueprintId]);

    const blocked = (preview?.summary.blocker ?? 0) > 0;
    const canConfirm = !!preview && !loading && !submitting && !blocked;

    async function handleConfirm() {
        if (!preview) return;
        setSubmitting(true);
        try {
            await applyBlueprint(blueprintId, {
                planFingerprint: preview.planFingerprint,
                actions: preview.confirmableActions,
            });
            toast.success('Rollout confirmed');
            onApplied();
            onOpenChange(false);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to apply blueprint';
            const status = (err as Error & { status?: number }).status;
            if (status === 409) {
                try {
                    setPreview(await previewBlueprint(blueprintId));
                } catch (refreshErr) {
                    toast.error(refreshErr instanceof Error ? refreshErr.message : 'Failed to refresh preview');
                }
            }
            toast.error(message);
        } finally {
            setSubmitting(false);
        }
    }

    const hasRequirements = !!preview && (
        preview.requirements.variables.length > 0
        || preview.requirements.envFiles.length > 0
        || preview.requirements.composeSecrets.length > 0
    );

    return (
        <Modal open={open} onOpenChange={onOpenChange} size="lg">
            <ModalHeader
                kicker="BLUEPRINT · ROLLOUT PREVIEW"
                title={`Confirm rollout: ${blueprintName}`}
                description="Review the blast radius before authorizing place or remove outcomes."
            />
            <ModalBody>
                {loading || !preview ? (
                    <p className="text-sm text-muted-foreground">Computing preview…</p>
                ) : (
                    <div className="space-y-4 max-md:max-h-[60vh] max-md:overflow-y-auto">
                        <p className="text-xs text-stat-subtitle">
                            Enabled blueprints still need this confirmation before the reconciler mutates the fleet.
                        </p>
                        <div className="flex flex-wrap gap-3 text-xs font-mono uppercase tracking-[0.15em]">
                            <span className="text-stat-value">Safe {preview.summary.safe}</span>
                            <span className="text-warning">Warnings {preview.summary.warning}</span>
                            <span className="text-destructive">Blockers {preview.summary.blocker}</span>
                            <span className="text-stat-subtitle">{approvalLabel(preview.effectiveApproval)}</span>
                        </div>
                        <p className="text-xs text-stat-subtitle">{preview.healthNote}</p>
                        {preview.blockers.length > 0 && (
                            <Section title={`Blockers (${preview.blockers.length})`} tone="destructive">
                                {preview.blockers.map(b => (
                                    <li key={b.id} className="text-xs text-stat-value">{b.message}</li>
                                ))}
                            </Section>
                        )}
                        {preview.warnings.length > 0 && (
                            <Section title={`Warnings (${preview.warnings.length})`} tone="warning">
                                {preview.warnings.map(w => (
                                    <li key={w.id} className="text-xs text-stat-value">{w.message}</li>
                                ))}
                            </Section>
                        )}
                        <Section title="Changes" tone="neutral">
                            {preview.changes.map(c => {
                                const nodeMeta = [c.nodeType, c.status].filter(Boolean).join('/');
                                const reachNote = c.reachabilityNote && c.reachabilityNote !== 'Local node'
                                    ? c.reachabilityNote
                                    : null;
                                return (
                                    <li key={`${c.nodeId}:${c.action}`} className="text-xs text-stat-value">
                                        <span className="font-mono">{c.nodeName}</span>
                                        {nodeMeta ? (
                                            <span className="text-stat-subtitle"> ({nodeMeta})</span>
                                        ) : null}
                                        {' · '}
                                        {c.action}
                                        {' · '}
                                        {c.severity}
                                        {': '}
                                        {c.detail}
                                        {reachNote ? (
                                            <span className="text-stat-subtitle"> · {reachNote}</span>
                                        ) : null}
                                    </li>
                                );
                            })}
                            {preview.changes.length === 0 && (
                                <li className="text-xs text-stat-subtitle">No node actions in this plan.</li>
                            )}
                        </Section>
                        {hasRequirements && (
                            <Section title="Requirements" tone="neutral">
                                {preview.requirements.variables.map(v => (
                                    <li key={v.name} className="text-xs font-mono text-stat-value">
                                        {`\${${v.name}}`}
                                        {v.required ? ' required' : ''}
                                        {v.likelySecret ? ' (likely secret)' : ''}
                                    </li>
                                ))}
                                {preview.requirements.envFiles.map(f => (
                                    <li key={f.path} className="text-xs font-mono text-stat-value">
                                        env_file {f.path}{f.required ? ' required' : ''}
                                    </li>
                                ))}
                                {preview.requirements.composeSecrets.map(s => (
                                    <li key={s.name} className="text-xs font-mono text-stat-value">
                                        secret {s.name}
                                    </li>
                                ))}
                            </Section>
                        )}
                    </div>
                )}
            </ModalBody>
            <ModalFooter
                secondary={
                    <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={submitting}>
                        Cancel
                    </Button>
                }
                primary={
                    <Button size="sm" onClick={() => void handleConfirm()} disabled={!canConfirm}>
                        {submitting ? 'Applying…' : 'Confirm Apply'}
                    </Button>
                }
            />
        </Modal>
    );
}

function Section({
    title,
    tone,
    children,
}: {
    title: string;
    tone: 'destructive' | 'warning' | 'neutral';
    children: React.ReactNode;
}) {
    return (
        <div className={`rounded-md border ${sectionBorderClass(tone)} px-3 py-2`}>
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-stat-subtitle mb-1.5">{title}</div>
            <ul className="space-y-1 list-disc pl-4">{children}</ul>
        </div>
    );
}
