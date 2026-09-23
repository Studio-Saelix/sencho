import { useEffect, useRef, useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
import GitOpsApprovalChips from '@/components/gitops/GitOpsApprovalChips';
import GitOpsCaveats from '@/components/gitops/GitOpsCaveats';
import { GitOpsFacetCards } from '@/components/gitops/GitOpsFacetCards';
import { GitOpsFaultCard } from '@/components/gitops/GitOpsStateCard';
import { IdentityRow } from '@/components/gitops/GitOpsIdentityRow';
import { ShortId } from '@/components/gitops/GitOpsShortId';
import { GitOpsTargetCard } from '@/components/gitops/GitOpsTargetCard';
import {
    absentFault,
    liveArtifactFacet,
    livePlacementFacet,
    liveRolloutFacet,
    liveSourceFacet,
} from '@/lib/gitopsState';
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

/**
 * The legacy combined approval stays separate from the decomposed authority
 * chips. It is only called combined rather than legacy when the Blueprint has
 * no live application, where it is the whole approval mechanism rather than the
 * pre-decomposition surface of one.
 */
function approvalLabel(preview: BlueprintPreview): string {
    const value = preview.effectiveApproval === 'reapproval_required'
        ? 'reapproval required'
        : preview.effectiveApproval;
    const hasLiveApplication = preview.gitops != null && preview.gitops.targetMode !== 'not_applicable';
    return hasLiveApplication ? `legacy combined: ${value}` : value;
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
            const result = await applyBlueprint(blueprintId, {
                planFingerprint: preview.planFingerprint,
                gitopsFingerprint: preview.gitopsFingerprint,
                actions: preview.confirmableActions,
            });
            const { failed = 0, pending = 0 } = result.outcomeSummary ?? {};
            if (failed > 0) {
                toast.warning(result.message || 'Rollout confirmed with node failures');
            } else if (result.effectiveApproval !== 'approved') {
                toast.warning(result.message || 'Confirmed snapshot finished; approval is no longer current');
            } else if (pending > 0) {
                toast.info(result.message || 'Rollout confirmed; some actions are still in progress');
            } else {
                toast.success(result.message || 'Rollout confirmed');
            }
            onApplied();
            onOpenChange(false);
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to apply blueprint';
            const status = (err as Error & { status?: number }).status;
            if (status === 409) {
                try {
                    setPreview(await previewBlueprint(blueprintId));
                } catch (refreshErr) {
                    // The preview just confirmed is no longer current and the
                    // refresh could not replace it, so there is nothing here
                    // left to confirm against. Close rather than leave a stale
                    // preview armed behind a re-enabled Confirm button.
                    toast.error(refreshErr instanceof Error ? refreshErr.message : 'Failed to refresh preview');
                    setPreview(null);
                    onOpenChangeRef.current(false);
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
                            <span className="text-stat-subtitle">{approvalLabel(preview)}</span>
                        </div>
                        <p className="text-xs text-stat-subtitle">{preview.healthNote}</p>
                        <GitOpsEvidenceSection preview={preview} />
                        {preview.gitopsFingerprint && (
                            <p className="text-xs text-stat-subtitle">
                                Confirmation is bound to this evidence snapshot (
                                <span className="font-mono" title={preview.gitopsFingerprint}>
                                    {preview.gitopsFingerprint.slice(0, 8)}
                                </span>
                                ). If any recorded authority fact changes first, the apply is refused and the preview refreshes.
                            </p>
                        )}
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

/**
 * The composed GitOps evidence: recorded authority, source and artifact
 * identity, placement and rollout state, then per-target observations and the
 * caveats that qualify the whole reading.
 *
 * Presentation only. Every value is the projection the preview endpoint
 * returned, rendered through the same lookups and cards the Git source panel,
 * Drift tab, Blueprint sheet and application view use. A Blueprint with no live
 * application renders the fault card (a projection that could not reach an
 * application it had reason to believe exists) or nothing at all. Placement and
 * rollout are never inferred from source state, and configuration convergence
 * is never worded as executable convergence: the facet copy already carries
 * that distinction.
 */
function GitOpsEvidenceSection({ preview }: { preview: BlueprintPreview }) {
    const projection = preview.gitops ?? null;
    const live = projection && projection.targetMode !== 'not_applicable' ? projection : null;
    const faults = projection ? absentFault(projection) : [];
    const source = liveSourceFacet(projection);
    const artifact = liveArtifactFacet(projection);
    const placement = livePlacementFacet(projection);
    const rollout = liveRolloutFacet(projection);
    if (!live && faults.length === 0) return null;

    const nodeNames = new Map<number, string>();
    for (const node of preview.matchedNodes) nodeNames.set(node.id, node.name);
    for (const change of preview.changes) nodeNames.set(change.nodeId, change.nodeName);
    const nodeName = (id: number) => nodeNames.get(id) ?? `node ${id}`;

    return (
        <div className={`rounded-md border ${sectionBorderClass('neutral')} px-3 py-2`}>
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-stat-subtitle mb-1.5">
                {live ? 'GitOps authority and evidence' : 'GitOps state unavailable'}
            </div>
            <div className="space-y-2">
                {faults.length > 0 && <GitOpsFaultCard message={faults[0].message} />}
                {live && (
                    <>
                        <GitOpsApprovalChips approvals={live.approvals} placement={placement} rollout={rollout} />
                        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                            {source && (
                                <>
                                    <IdentityRow term="Repository" title={source.configuredRepoUrl}>
                                        {source.repoIdentity.host}{source.repoIdentity.pathname}
                                    </IdentityRow>
                                    <IdentityRow term="Ref">{source.configuredRef}</IdentityRow>
                                    <IdentityRow term="Desired commit">
                                        <ShortId value={source.desiredCommitSha} length={7} />
                                    </IdentityRow>
                                    <IdentityRow term="Fetched commit">
                                        <ShortId value={source.fetchedCommitSha} length={7} />
                                    </IdentityRow>
                                    <IdentityRow term="Candidate generation">
                                        <ShortId value={source.candidateGenerationId} />
                                    </IdentityRow>
                                    <IdentityRow term="Accepted generation">
                                        <ShortId value={source.acceptedGenerationId} />
                                    </IdentityRow>
                                </>
                            )}
                            <IdentityRow term="Rollout generation">
                                <ShortId value={live.rolloutGenerationId} />
                            </IdentityRow>
                        </dl>
                        <GitOpsFacetCards
                            source={source}
                            artifact={artifact}
                            placement={placement}
                            rollout={rollout}
                        />
                        {live.targets.length > 0 && (
                            <div className="space-y-2">
                                <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-stat-subtitle">
                                    Targets · {live.targets.length}
                                </div>
                                {live.targets.map(t => (
                                    <GitOpsTargetCard key={t.nodeId} target={t} nodeName={nodeName(t.nodeId)} />
                                ))}
                            </div>
                        )}
                        <GitOpsCaveats revision={projection} />
                    </>
                )}
            </div>
        </div>
    );
}
