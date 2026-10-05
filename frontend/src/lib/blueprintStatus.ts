/**
 * What a Blueprint's own deployments say about it, as one Answer, a quiet Path
 * and the verb that resolves the loudest problem.
 *
 * Pure: it reads the deployment rows and the approval state and decides what to
 * say. The GitOps projection is a different source of truth (placement and
 * rollout authority); the sheet shows whichever of the two is louder.
 *
 * See DESIGN.md section 1.1 (Principle 2, answer, path, proof).
 */
import type { BlueprintDeployment, BlueprintDeploymentStatus, EffectiveApproval } from './blueprintsApi';
import type { StatusTone } from './statusTone';

export type BlueprintVerb =
    | { kind: 'reapply'; label: 'Re-apply' | 'Review rollout' }
    | { kind: 'review_state'; label: 'Review state'; nodeId: number }
    | { kind: 'evict'; label: 'Evict'; nodeId: number }
    | { kind: 'enable'; label: 'Enable' };

export interface BlueprintStatusStage {
    id: 'approval' | 'nodes' | 'reconciler';
    label: string;
    tone: StatusTone;
    word: string;
}

export interface BlueprintStatusModel {
    answer: { tone: StatusTone; title: string; line: string; status: string };
    stages: BlueprintStatusStage[];
    verb: BlueprintVerb | null;
}

export interface BlueprintStatusInput {
    enabled: boolean;
    approval: EffectiveApproval;
    deployments: readonly Pick<BlueprintDeployment, 'node_id' | 'status' | 'last_error'>[];
    nodeName: (nodeId: number) => string;
}

/** "beta", "beta and gamma", "beta, gamma and 2 more". */
function nameList(names: string[]): string {
    if (names.length <= 2) return names.join(' and ');
    return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

const KNOWN_STATUS: ReadonlySet<string> = new Set<BlueprintDeploymentStatus>([
    'pending', 'pending_state_review', 'deploying', 'active', 'drifted', 'correcting',
    'repair_held', 'failed', 'withdrawing', 'withdrawn', 'evict_blocked', 'name_conflict',
]);

const APPROVAL_STAGE: Record<'approved' | 'reapproval_required' | 'pending', { tone: StatusTone; word: string }> = {
    approved: { tone: 'success', word: 'confirmed' },
    reapproval_required: { tone: 'warning', word: 'reconfirm' },
    pending: { tone: 'neutral', word: 'pending' },
};

const FAILURE_WORD = /error|failed|denied|conflict|cannot|unable|refused/i;
const SUMMARY_LIMIT = 200;

/**
 * The one line of a deploy log that says why it failed. Container tooling prints
 * a progress transcript and ends with the error, so the last line that reads
 * like a failure wins; a transcript squeezed onto one line is cut at the daemon
 * error instead. `full` is the whole log whenever it differs from the summary,
 * including when the summary was shortened or had ids removed.
 */
export interface FailureSummary {
    summary: string;
    full: string | null;
}

export function summarizeFailure(text: string | null): FailureSummary | null {
    if (!text || !text.trim()) return null;
    const lines = text.split(/\r\n|\n|\r/).map(l => l.trim()).filter(Boolean);
    let pick = [...lines].reverse().find(l => FAILURE_WORD.test(l)) ?? lines[lines.length - 1];
    const daemon = pick.indexOf('Error response from daemon');
    if (daemon > 0) pick = pick.slice(daemon);
    // Container ids carry no meaning to the reader and push the cause out of the summary.
    const withoutIds = pick.replace(/\s*\([0-9a-f]{12,}\)/gi, '').trim();
    pick = withoutIds || pick;
    // The cause comes last in tooling output, so a long line keeps its tail.
    const summary = pick.length > SUMMARY_LIMIT ? `\u2026${pick.slice(pick.length - (SUMMARY_LIMIT - 1))}` : pick;
    return { summary, full: text.trim() === summary ? null : text.trim() };
}

function plural(n: number, word: string): string {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function buildBlueprintStatus(input: BlueprintStatusInput): BlueprintStatusModel {
    // An approval or deployment status this build does not know reads as needing
    // attention, never as healthy: a remote node can be newer than this console.
    const approval = input.approval === 'approved' || input.approval === 'reapproval_required' ? input.approval : 'pending';
    const live = input.deployments.filter(d => d.status !== 'withdrawn');
    const byStatus = (s: BlueprintDeploymentStatus) => live.filter(d => d.status === s);
    const namesOf = (rows: readonly { node_id: number }[]) => nameList(rows.map(r => input.nodeName(r.node_id)));
    const failed = byStatus('failed');
    const conflict = byStatus('name_conflict');
    const evictBlocked = byStatus('evict_blocked');
    const review = byStatus('pending_state_review');
    const held = byStatus('repair_held');
    const drifted = byStatus('drifted');
    const inFlight = live.filter(d => d.status === 'deploying' || d.status === 'correcting' || d.status === 'withdrawing' || d.status === 'pending');
    const active = byStatus('active');
    const unrecognized = live.filter(d => !KNOWN_STATUS.has(d.status));

    let answer: BlueprintStatusModel['answer'];
    let verb: BlueprintVerb | null = null;
    // Applying a disabled Blueprint is refused, so the way out is to turn it on; the
    // reconciler then retries by itself. Per-node verbs pick the first affected node,
    // and are simply not offered when the session may not act on it.
    const reapplyVerb = (label: 'Re-apply' | 'Review rollout'): BlueprintVerb =>
        input.enabled ? { kind: 'reapply', label } : { kind: 'enable', label: 'Enable' };

    if (failed.length > 0) {
        answer = {
            tone: 'destructive', title: 'failed', status: 'failed',
            // The cause is stated once, on the failed node's row, where the full output is.
            line: `Deploy failed on ${namesOf(failed)}.`,
        };
        verb = reapplyVerb('Re-apply');
    } else if (conflict.length > 0) {
        answer = {
            tone: 'destructive', title: 'name conflict', status: 'name_conflict',
            line: `A stack with this name already exists on ${namesOf(conflict)} and Sencho did not create it. Resolve it on the node.`,
        };
    } else if (evictBlocked.length > 0) {
        answer = {
            tone: 'warning', title: 'evict blocked', status: 'evict_blocked',
            line: `Removal is blocked on ${namesOf(evictBlocked)} until you decide what happens to its data.`,
        };
        verb = { kind: 'evict', label: 'Evict', nodeId: evictBlocked[0].node_id };
    } else if (review.length > 0) {
        answer = {
            tone: 'warning', title: 'needs confirmation', status: 'pending_state_review',
            line: `${namesOf(review)} ${review.length === 1 ? 'needs' : 'need'} a decision about existing data before the first deploy.`,
        };
        verb = { kind: 'review_state', label: 'Review state', nodeId: review[0].node_id };
    } else if (held.length > 0) {
        answer = {
            tone: 'warning', title: 'repair held', status: 'repair_held',
            line: `Sencho held its repair on ${namesOf(held)} because it could not prove what is running there.`,
        };
        verb = reapplyVerb('Re-apply');
    } else if (drifted.length > 0) {
        answer = {
            tone: 'warning', title: 'drifted', status: 'drifted',
            line: `${namesOf(drifted)} no longer ${drifted.length === 1 ? 'matches' : 'match'} the declared revision.`,
        };
        verb = reapplyVerb('Re-apply');
    } else if (unrecognized.length > 0) {
        answer = {
            tone: 'warning', title: 'unrecognized state', status: 'unrecognized',
            line: `${namesOf(unrecognized)} reported a state this Sencho build does not know.`,
        };
    } else if (!input.enabled) {
        answer = {
            tone: 'neutral', title: 'reconciler off', status: 'disabled',
            line: 'Nothing is deployed or repaired while the reconciler is off.',
        };
        verb = { kind: 'enable', label: 'Enable' };
    } else if (inFlight.length > 0) {
        answer = {
            tone: 'brand', title: 'in progress', status: 'in_progress',
            line: `Sencho is applying changes on ${namesOf(inFlight)}.`,
        };
    } else if (approval === 'reapproval_required') {
        answer = {
            tone: 'warning', title: 'needs confirmation', status: 'reapproval_required',
            line: 'The targets changed since the last confirmed rollout.',
        };
        verb = reapplyVerb('Review rollout');
    } else if (approval === 'pending') {
        answer = live.length === 0
            ? { tone: 'neutral', title: 'not deployed', status: 'not_deployed', line: 'Review the rollout to put this Blueprint on its nodes.' }
            : { tone: 'warning', title: 'needs confirmation', status: 'approval_pending', line: 'Saved changes are not confirmed yet.' };
        verb = reapplyVerb('Review rollout');
    } else if (active.length > 0) {
        answer = {
            tone: 'success', title: 'in sync', status: 'in_sync',
            line: `${plural(active.length, 'node')} running the current revision.`,
        };
    } else {
        answer = { tone: 'neutral', title: 'no nodes', status: 'no_nodes', line: 'No node matches the selector yet.' };
    }

    const stages: BlueprintStatusStage[] = [{ id: 'approval', label: 'approval', ...APPROVAL_STAGE[approval] }];
    if (live.length > 0) {
        const nodesTone = active.length === live.length ? 'success' : answer.tone;
        stages.push({ id: 'nodes', label: 'nodes', tone: nodesTone, word: `${active.length}/${live.length} active` });
    }
    if (!input.enabled) stages.push({ id: 'reconciler', label: 'reconciler', tone: 'neutral', word: 'off' });

    return { answer, stages, verb };
}
