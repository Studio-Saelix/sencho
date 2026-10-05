import { Button } from '@/components/ui/button';
import { StatusPath } from '@/components/ui/status-path';
import { GitOpsStatus } from '@/components/gitops/GitOpsStatus';
import type { BlueprintSummary } from '@/lib/blueprintsApi';
import { buildBlueprintStatus, type BlueprintVerb } from '@/lib/blueprintStatus';
import { buildGitOpsStatus, type GitOpsOmissions } from '@/lib/gitopsStatus';
import { UNRECOGNIZED_STATE_LABEL } from '@/lib/gitopsState';
import { toneRank } from '@/lib/statusTone';

// A Blueprint that is applied rather than rolled out always reports its rollout as
// "not executable" and has no GitOps runtime to speak of; those two say nothing true
// about it, while a paused rollout or a failed runtime still show.
const INLINE_OMIT: GitOpsOmissions = {
    rollout: ['rollout_not_executable'],
    runtime: ['never_applied'],
};

/**
 * Handlers for the verbs this session may run. A verb without one is not offered,
 * and a per-node verb is offered only when its predicate says the session may act
 * on that node.
 */
export interface BlueprintStatusHandlers {
    reapply?: () => void;
    enable?: () => void;
    reviewState?: (nodeId: number) => void;
    evict?: (nodeId: number) => void;
    canDeployOnNode?: (nodeId: number) => boolean;
    canWithdrawFromNode?: (nodeId: number) => boolean;
}

function verbHandler(verb: BlueprintVerb, handlers: BlueprintStatusHandlers): (() => void) | null {
    switch (verb.kind) {
        case 'reapply': return handlers.reapply ?? null;
        case 'enable': return handlers.enable ?? null;
        case 'review_state': {
            const { reviewState, canDeployOnNode } = handlers;
            return reviewState && canDeployOnNode?.(verb.nodeId) ? () => reviewState(verb.nodeId) : null;
        }
        case 'evict': {
            const { evict, canWithdrawFromNode } = handlers;
            return evict && canWithdrawFromNode?.(verb.nodeId) ? () => evict(verb.nodeId) : null;
        }
    }
}

/**
 * The Answer for an Inline Blueprint: what its deployments say, with the verb
 * that resolves the loudest problem. The GitOps status speaks instead when it
 * holds a warning or worse that is louder than the deployments answer; either
 * way the sheet carries one toned block, and whichever source did not speak is
 * named in a quiet marker so neither is hidden.
 */
export function BlueprintStatus({ summary, nodeName, handlers, busy }: {
    summary: BlueprintSummary;
    nodeName: (nodeId: number) => string;
    handlers: BlueprintStatusHandlers;
    busy: boolean;
}) {
    const { blueprint } = summary;
    const model = buildBlueprintStatus({
        enabled: blueprint.enabled,
        approval: summary.effectiveApproval ?? 'pending',
        deployments: summary.deployments,
        nodeName,
    });
    const gitops = buildGitOpsStatus(summary.gitopsRevision, null, undefined, INLINE_OMIT);
    // A neutral "placement bound" is not an answer; a warning or worse is.
    const gitopsBlocks = gitops !== null && toneRank(gitops.answer.tone) >= toneRank('warning');
    const gitopsLouder = gitopsBlocks && toneRank(gitops.answer.tone) > toneRank(model.answer.tone);
    if (gitopsLouder) {
        // The deployments' own problem keeps a place in the marker, since its verb is not on offer here.
        const deploymentsNote = toneRank(model.answer.tone) >= toneRank('warning') ? `deployments ${model.answer.title}` : undefined;
        return (
            <GitOpsStatus revision={summary.gitopsRevision} omit={INLINE_OMIT} includeTargets={false} extraMarker={deploymentsNote} />
        );
    }

    const run = model.verb ? verbHandler(model.verb, handlers) : null;
    const target = model.verb && 'nodeId' in model.verb ? ` on ${nodeName(model.verb.nodeId)}` : '';
    const unrecognizedGitOps = gitops?.stages.some(s => s.word === UNRECOGNIZED_STATE_LABEL) ? 'unrecognized GitOps state' : null;
    // The runtime stage mirrors the deployments for this Blueprint, so naming it would state the failure twice.
    const gitopsTitle = gitopsBlocks && gitops.answerStageId !== 'runtime' && (gitops.answer.title.startsWith('gitops') ? gitops.answer.title : `gitops ${gitops.answer.title}`);
    const marker = [gitopsTitle, unrecognizedGitOps, gitops?.marker]
        .filter((part): part is string => Boolean(part))
        .join(' \u00b7 ');
    return (
        <StatusPath
            data-testid="blueprint-status"
            answer={{
                ...model.answer,
                marker: marker || undefined,
                action: model.verb && run ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={run} data-testid="blueprint-verb">
                        {model.verb.label}{target}
                    </Button>
                ) : undefined,
                'data-testid': 'blueprint-answer',
            }}
            stages={model.stages}
        />
    );
}
