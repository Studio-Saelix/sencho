/**
 * Blueprint rollout approval: intent fingerprint, blast JSON parse,
 * place/remove transition matrix, and effective approval evaluation.
 */

import { createHash } from 'crypto';
import type { Blueprint, BlueprintSelector, DriftMode } from './DatabaseService';

export type ApprovalOutcome = 'place' | 'remove';
export type EffectiveApproval = 'pending' | 'approved' | 'reapproval_required';

export type PreviewAction =
    | 'create'
    | 'update'
    | 'remove'
    | 'check_observe'
    | 'check_enforce'
    | 'await_state_review'
    | 'await_evict_confirm'
    | 'clear_stale_guard'
    | 'clear_reversed_evict'
    | 'in_flight_deploy'
    | 'in_flight_correct'
    | 'in_flight_withdraw'
    | 'skip_cordoned'
    | 'blocked_name_conflict';

export type ActionKind = 'executor' | 'informational';

export interface ApprovedNodeOutcome {
    nodeId: number;
    outcome: ApprovalOutcome;
}

export interface ConfirmableActionRef {
    nodeId: number;
    action: PreviewAction;
}

const PLACE_EXECUTOR = new Set<PreviewAction>([
    'create',
    'update',
    'check_observe',
    'check_enforce',
    'await_state_review',
    'clear_reversed_evict',
]);

const REMOVE_EXECUTOR = new Set<PreviewAction>([
    'remove',
    'await_evict_confirm',
    'clear_stale_guard',
]);

const INFORMATIONAL = new Set<PreviewAction>([
    'in_flight_deploy',
    'in_flight_correct',
    'in_flight_withdraw',
    'skip_cordoned',
    'blocked_name_conflict',
]);

const ALL_ACTIONS = new Set<PreviewAction>([
    ...PLACE_EXECUTOR,
    ...REMOVE_EXECUTOR,
    ...INFORMATIONAL,
]);

export function actionKind(action: PreviewAction): ActionKind {
    return INFORMATIONAL.has(action) ? 'informational' : 'executor';
}

export function isExecutorAction(action: PreviewAction): boolean {
    return !INFORMATIONAL.has(action);
}

/** Outcome derived when this confirmable action appears in a confirmed plan. */
export function outcomeForConfirmableAction(action: PreviewAction): ApprovalOutcome | null {
    if (PLACE_EXECUTOR.has(action) || action === 'in_flight_deploy' || action === 'in_flight_correct') {
        return 'place';
    }
    if (REMOVE_EXECUTOR.has(action) || action === 'in_flight_withdraw') {
        return 'remove';
    }
    return null;
}

export function isActionAuthorized(outcome: ApprovalOutcome, action: PreviewAction): boolean {
    if (INFORMATIONAL.has(action)) return false;
    if (outcome === 'place') return PLACE_EXECUTOR.has(action);
    return REMOVE_EXECUTOR.has(action);
}

function canonicalSelectorJson(selector: BlueprintSelector): string {
    if (selector.type === 'nodes') {
        const ids = [...selector.ids].sort((a, b) => a - b);
        return JSON.stringify({ type: 'nodes', ids });
    }
    const any = [...selector.any].sort((a, b) => a.localeCompare(b));
    const all = [...selector.all].sort((a, b) => a.localeCompare(b));
    return JSON.stringify({ type: 'labels', any, all });
}

export function intentFingerprint(blueprint: Pick<
    Blueprint,
    'id' | 'name' | 'revision' | 'selector' | 'pinned_node_id' | 'enabled' | 'drift_mode' | 'compose_content'
>): string {
    const composeHash = createHash('sha256').update(blueprint.compose_content, 'utf8').digest('hex');
    const lines = [
        `id:${blueprint.id}`,
        `name:${blueprint.name}`,
        `revision:${blueprint.revision}`,
        `selector:${canonicalSelectorJson(blueprint.selector)}`,
        `pin:${blueprint.pinned_node_id ?? 'null'}`,
        `enabled:${blueprint.enabled ? '1' : '0'}`,
        `drift:${blueprint.drift_mode}`,
        `compose:${composeHash}`,
    ].sort((a, b) => a.localeCompare(b));
    return createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
}

export function serializeApprovedBlast(entries: ApprovedNodeOutcome[]): string {
    const sorted = [...entries].sort((a, b) => a.nodeId - b.nodeId);
    return JSON.stringify(sorted.map(e => ({ nodeId: e.nodeId, outcome: e.outcome })));
}

export type ParseBlastResult =
    | { ok: true; entries: ApprovedNodeOutcome[] }
    | { ok: false; reason: string };

/**
 * Fail-closed parser. Rejects unknown keys, duplicates, invalid ids/outcomes,
 * and non-canonical ordering. Does not mutate the database.
 */
function isPlainObject(item: unknown): item is Record<string, unknown> {
    return item != null && typeof item === 'object' && !Array.isArray(item);
}

function hasExactKeys(obj: Record<string, unknown>, keyA: string, keyB: string): boolean {
    const keys = Object.keys(obj);
    return keys.length === 2 && keys.includes(keyA) && keys.includes(keyB);
}

function isPositiveInt(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * Fail-closed parser. Rejects unknown keys, duplicates, invalid ids/outcomes,
 * and non-canonical ordering. Does not mutate the database.
 */
export function parseApprovedBlastJson(raw: string | null | undefined): ParseBlastResult {
    if (raw == null || raw === '') {
        return { ok: false, reason: 'missing' };
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { ok: false, reason: 'malformed_json' };
    }
    if (!Array.isArray(parsed)) {
        return { ok: false, reason: 'not_array' };
    }
    const entries: ApprovedNodeOutcome[] = [];
    const seen = new Set<number>();
    for (const item of parsed) {
        if (!isPlainObject(item) || !hasExactKeys(item, 'nodeId', 'outcome')) {
            return { ok: false, reason: isPlainObject(item) ? 'unknown_keys' : 'bad_element' };
        }
        const { nodeId, outcome } = item;
        if (!isPositiveInt(nodeId)) {
            return { ok: false, reason: 'invalid_node_id' };
        }
        if (outcome !== 'place' && outcome !== 'remove') {
            return { ok: false, reason: 'invalid_outcome' };
        }
        if (seen.has(nodeId)) {
            return { ok: false, reason: 'duplicate_node' };
        }
        seen.add(nodeId);
        entries.push({ nodeId, outcome });
    }
    for (let i = 1; i < entries.length; i++) {
        if (entries[i].nodeId <= entries[i - 1].nodeId) {
            return { ok: false, reason: 'non_canonical_order' };
        }
    }
    return { ok: true, entries };
}

export function deriveBlastFromConfirmableActions(actions: ConfirmableActionRef[]): ApprovedNodeOutcome[] {
    const byNode = new Map<number, ApprovalOutcome>();
    for (const { nodeId, action } of actions) {
        const outcome = outcomeForConfirmableAction(action);
        if (!outcome) continue;
        const existing = byNode.get(nodeId);
        if (!existing) {
            byNode.set(nodeId, outcome);
        } else if (existing !== outcome) {
            // Conflicting outcomes for one node in one confirm: last write wins is unsafe;
            // prefer remove if both appear (fail closed toward requiring reapproval next).
            byNode.set(nodeId, 'remove');
        }
    }
    return [...byNode.entries()]
        .map(([nodeId, outcome]) => ({ nodeId, outcome }))
        .sort((a, b) => a.nodeId - b.nodeId);
}

export function confirmableActionsEqual(a: ConfirmableActionRef[], b: ConfirmableActionRef[]): boolean {
    if (a.length !== b.length) return false;
    const key = (x: ConfirmableActionRef) => `${x.nodeId}:${x.action}`;
    const sa = a.map(key).sort();
    const sb = b.map(key).sort();
    return sa.every((v, i) => v === sb[i]);
}

export function parseConfirmableActionsBody(
    raw: unknown,
): { ok: true; actions: ConfirmableActionRef[] } | { ok: false; reason: string } {
    if (!Array.isArray(raw)) {
        return { ok: false, reason: 'not_array' };
    }
    const actions: ConfirmableActionRef[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        if (!isPlainObject(item) || !hasExactKeys(item, 'nodeId', 'action')) {
            return { ok: false, reason: isPlainObject(item) ? 'unknown_keys' : 'bad_element' };
        }
        const { nodeId, action } = item;
        if (!isPositiveInt(nodeId)) {
            return { ok: false, reason: 'invalid_node_id' };
        }
        if (typeof action !== 'string' || !ALL_ACTIONS.has(action as PreviewAction)) {
            return { ok: false, reason: 'invalid_action' };
        }
        const k = `${nodeId}:${action}`;
        if (seen.has(k)) {
            return { ok: false, reason: 'duplicate_pair' };
        }
        seen.add(k);
        actions.push({ nodeId, action: action as PreviewAction });
    }
    return { ok: true, actions };
}

export interface BlueprintApprovalFields {
    approval_status: 'pending' | 'approved';
    approved_intent_fingerprint: string | null;
    approved_blast_json: string | null;
    approved_at: number | null;
    approved_by: string | null;
}

export function evaluateEffectiveApproval(
    blueprint: Blueprint & Partial<BlueprintApprovalFields>,
    executorActions: ConfirmableActionRef[],
): { effectiveApproval: EffectiveApproval; unauthorizedActions: ConfirmableActionRef[]; blast: ApprovedNodeOutcome[] | null } {
    const status = blueprint.approval_status ?? 'pending';
    const fp = blueprint.approved_intent_fingerprint ?? null;
    const rawBlast = blueprint.approved_blast_json ?? null;
    const parsed = parseApprovedBlastJson(rawBlast);
    const currentFp = intentFingerprint(blueprint);

    if (status !== 'approved' || !fp || !parsed.ok || fp !== currentFp) {
        return { effectiveApproval: 'pending', unauthorizedActions: executorActions, blast: null };
    }

    const byNode = new Map(parsed.entries.map(e => [e.nodeId, e.outcome]));
    const unauthorized: ConfirmableActionRef[] = [];
    for (const ref of executorActions) {
        const outcome = byNode.get(ref.nodeId);
        if (!outcome || !isActionAuthorized(outcome, ref.action)) {
            unauthorized.push(ref);
        }
    }

    if (unauthorized.length > 0) {
        return {
            effectiveApproval: 'reapproval_required',
            unauthorizedActions: unauthorized,
            blast: parsed.entries,
        };
    }
    return { effectiveApproval: 'approved', unauthorizedActions: [], blast: parsed.entries };
}

export function filterAuthorizedExecutorActions(
    blast: ApprovedNodeOutcome[],
    executorActions: ConfirmableActionRef[],
): ConfirmableActionRef[] {
    const byNode = new Map(blast.map(e => [e.nodeId, e.outcome]));
    return executorActions.filter(ref => {
        const outcome = byNode.get(ref.nodeId);
        return outcome != null && isActionAuthorized(outcome, ref.action);
    });
}

export type { DriftMode };
