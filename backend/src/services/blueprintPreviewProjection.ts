/**
 * Pure Blueprint rollout preview projection. Zero DB writes.
 * Executor cleanup helpers for clear_reversed_evict / clear_stale_guard live at the bottom.
 */

import { createHash, randomUUID } from 'crypto';
import { parse as parseYaml } from 'yaml';
import {
    DatabaseService,
    type Blueprint,
    type BlueprintDeployment,
    type Node,
} from './DatabaseService';
import { BlueprintReconciler, type ReconcileDecision } from './BlueprintReconciler';
import { GitOpsStore } from './gitops/store';
import { GitOpsTransitions } from './gitops/transitions';
import { projectBlueprintRevision } from '../helpers/gitopsResponse';
import type {
    ArtifactFacet,
    FutureRolloutAuthorizationBinding,
    GitOpsLimitation,
    GitOpsRevisionProjection,
    PlacementFacet,
    RolloutFacet,
    SourceFacet,
} from './gitops/types';
import { parseInterpolationRefs } from '../helpers/envVarParse';
import { normalizeEnvFileField } from '../helpers/envFileResolution';
import { isLikelySecretKey } from '../helpers/secretClassification';
import {
    type PreviewAction,
    type ConfirmableActionRef,
    type EffectiveApproval,
    type BlueprintApprovalFields,
    actionKind,
    isExecutorAction,
    intentFingerprint,
    evaluateEffectiveApproval,
    parseApprovedBlastJson,
    serializeApprovedBlast,
} from './blueprintApproval';

export const BLUEPRINT_PREVIEW_PILOT_STALE_MS = 60_000;
export const BLUEPRINT_PREVIEW_PROXY_STALE_MS = 120_000;

export type PreviewSeverity = 'safe' | 'warning' | 'blocker';

/**
 * Which signal a contact timestamp came from. Named so callers that classify
 * reachability can share one vocabulary instead of redeclaring the union.
 */
export type PreviewContactSource = 'local' | 'pilot_last_seen' | 'last_successful_contact';

/**
 * How `contactInfo` decided a node's reachability, as a closed set rather than
 * free prose so a caller that renders it needs no fallback string for an
 * unknown value.
 */
export type PreviewReachabilityNote =
  | 'Local node'
  | 'Pilot heartbeat fresh but cached status is offline'
  | 'Pilot node cached as offline or unknown'
  | 'Pilot heartbeat expired (cached)'
  | 'Pilot heartbeat fresh (cached)'
  | 'Remote node cached as offline or unknown'
  | 'Proxy contact missing or stale (cached status)'
  | 'Proxy contact fresh (cached)';

export interface PreviewChangeRow {
    nodeId: number;
    nodeName: string;
    nodeType: 'local' | 'remote';
    mode: string | null;
    status: Node['status'];
    contactAt: number | null;
    contactSource: PreviewContactSource;
    action: PreviewAction;
    severity: PreviewSeverity;
    kind: 'executor' | 'informational';
    detail: string;
    reachabilityNote: string;
}

export interface PreviewRequirementVariable {
    name: string;
    required: boolean;
    hasDefault: boolean;
    alternate: boolean;
    likelySecret: boolean;
}

export interface PreviewRequirementEnvFile {
    path: string;
    required: boolean;
}

export interface PreviewRequirements {
    variables: PreviewRequirementVariable[];
    envFiles: PreviewRequirementEnvFile[];
    composeSecrets: Array<{ name: string }>;
}

export interface PreviewWarningItem {
    id: string;
    source: 'change' | 'requirement' | 'compat' | 'health';
    severity: PreviewSeverity;
    message: string;
}

/**
 * Where an effective approval came from.
 *
 * The legacy combined approval is the pre-decomposition mechanism and still
 * the executor for a Blueprint with no live application. `configured_policy` is
 * the decomposed placement approval a policy wrote for its own decision, which
 * the reconciler executes on an automatic rollout.
 */
export type ApprovalAuthority = 'legacy_combined' | 'configured_policy';

export interface BlueprintPreviewResult {
    blueprintId: number;
    classification: Blueprint['classification'];
    matchedNodes: Array<{ id: number; name: string; type: 'local' | 'remote' }>;
    plannedDeployments: Array<{ id: number; name: string }>;
    plannedDriftChecks: Array<{ id: number; name: string }>;
    plannedEvictions: number[];
    name: string;
    revision: number;
    updatedAt: number;
    driftMode: Blueprint['drift_mode'];
    stackName: string;
    approvalStatus: 'pending' | 'approved';
    effectiveApproval: EffectiveApproval;
    /**
     * Which authority makes `effectiveApproval` approved, or null when nothing
     * does. Separate from `effectiveApproval` so a surface can name the actual
     * authority: a plan a policy covers is approved, but calling it a combined
     * approval would be false.
     */
    approvalAuthority: ApprovalAuthority | null;
    /**
     * Why a policy-approved plan is still waiting, or null when nothing is
     * holding it. Set only when the composed approval is pending, so the tick
     * will not run any of the plan. A plan the combined approval still covers
     * in part stays reapproval required and does not carry this sentence.
     */
    approvalHoldReason: string | null;
    planFingerprint: string;
    generatedAt: number;
    summary: { safe: number; warning: number; blocker: number; total: number };
    changes: PreviewChangeRow[];
    confirmableActions: ConfirmableActionRef[];
    executorActions: ConfirmableActionRef[];
    unauthorizedActions: ConfirmableActionRef[];
    requirements: PreviewRequirements;
    compatibilityWarnings: string[];
    healthNote: string;
    blockers: PreviewWarningItem[];
    warnings: PreviewWarningItem[];
    /**
     * The canonical GitOps projection for this Blueprint's application, or the
     * absent arm when it has none. Read-only evidence: the preview never derives
     * state from it, it only reports what the projection already says.
     */
    gitops: GitOpsRevisionProjection;
    /**
     * Digest of the authority evidence this preview displays, or null when there
     * is nothing to bind; a projection that faulted binds its limitation codes
     * instead. Apply refuses with PREVIEW_STALE when the fresh digest differs
     * from the one the operator confirmed, so a source acceptance, artifact
     * identity, placement approval, preflight result, or rollout authorization
     * that moved under the preview cannot execute against stale evidence.
     */
    gitopsFingerprint: string | null;
}

const HEALTH_NOTE = 'Reachability is from cached node status and mode-specific contact timestamps; preview does not probe remotes.';

function isMutatingAction(action: PreviewAction): boolean {
    return action === 'create'
        || action === 'update'
        || action === 'remove'
        || action === 'check_enforce';
}

/**
 * Classify a node's reachability from cached state alone: no probe, no HTTP.
 *
 * `contactAt` is epoch milliseconds, normalized from the source column the
 * classification used: `pilot_last_seen` already holds milliseconds, while
 * `last_successful_contact` holds seconds. A configured proxy identity is not
 * proof of reachability, so a caller that also probes must layer the live
 * result on top of `reachabilityNote` rather than replacing this
 * classification. `elevateMutating` is the blueprint-preview severity bump;
 * callers that only need reachability can ignore it.
 */
export function contactInfo(node: Node): {
    contactAt: number | null;
    contactSource: PreviewContactSource;
    reachabilityNote: PreviewReachabilityNote;
    elevateMutating: PreviewSeverity | null;
} {
    if (node.type === 'local') {
        return {
            contactAt: null,
            contactSource: 'local',
            reachabilityNote: 'Local node',
            elevateMutating: null,
        };
    }

    if (node.mode === 'pilot_agent') {
        const seen = node.pilot_last_seen ?? null;
        const age = seen != null ? Date.now() - seen : null;
        const heartbeatStale = seen == null || (age != null && age > BLUEPRINT_PREVIEW_PILOT_STALE_MS);
        if (node.status === 'offline' || node.status === 'unknown') {
            return {
                contactAt: seen,
                contactSource: 'pilot_last_seen',
                reachabilityNote: node.status === 'offline' && !heartbeatStale
                    ? 'Pilot heartbeat fresh but cached status is offline'
                    : 'Pilot node cached as offline or unknown',
                elevateMutating: 'blocker',
            };
        }
        if (heartbeatStale) {
            return {
                contactAt: seen,
                contactSource: 'pilot_last_seen',
                reachabilityNote: 'Pilot heartbeat expired (cached)',
                elevateMutating: 'warning',
            };
        }
        return {
            contactAt: seen,
            contactSource: 'pilot_last_seen',
            reachabilityNote: 'Pilot heartbeat fresh (cached)',
            elevateMutating: null,
        };
    }

    const sec = node.last_successful_contact ?? null;
    const contactAt = sec != null ? sec * 1000 : null;
    const age = contactAt != null ? Date.now() - contactAt : null;
    if (node.status === 'offline' || node.status === 'unknown') {
        return {
            contactAt,
            contactSource: 'last_successful_contact',
            reachabilityNote: 'Remote node cached as offline or unknown',
            elevateMutating: 'blocker',
        };
    }
    if (contactAt == null || (age != null && age > BLUEPRINT_PREVIEW_PROXY_STALE_MS)) {
        return {
            contactAt,
            contactSource: 'last_successful_contact',
            reachabilityNote: 'Proxy contact missing or stale (cached status)',
            elevateMutating: 'warning',
        };
    }
    return {
        contactAt,
        contactSource: 'last_successful_contact',
        reachabilityNote: 'Proxy contact fresh (cached)',
        elevateMutating: null,
    };
}

function applyHealthSeverity(
    action: PreviewAction,
    base: PreviewSeverity,
    elevate: PreviewSeverity | null,
): PreviewSeverity {
    if (!elevate) return base;

    if (isMutatingAction(action)) {
        if (elevate === 'blocker') return 'blocker';
        return base === 'safe' ? 'warning' : base;
    }

    // Non-mutating actions: soft-elevate safe→warning only; never promote to blocker.
    if (elevate === 'warning' && base === 'safe') return 'warning';
    return base;
}

function driftCheckAction(driftMode: Blueprint['drift_mode']): PreviewAction {
    return driftMode === 'enforce' ? 'check_enforce' : 'check_observe';
}

function driftCheckSeverity(action: PreviewAction): PreviewSeverity {
    return action === 'check_enforce' ? 'warning' : 'safe';
}

function composeSecretName(sec: unknown): string | null {
    if (typeof sec === 'string') return sec;
    if (sec && typeof sec === 'object' && typeof (sec as { source?: unknown }).source === 'string') {
        return (sec as { source: string }).source;
    }
    return null;
}

function pushUniqueSecret(composeSecrets: Array<{ name: string }>, name: string): void {
    if (!composeSecrets.some(c => c.name === name)) {
        composeSecrets.push({ name });
    }
}

function extractRequirements(composeContent: string): {
    requirements: PreviewRequirements;
    compat: string[];
    reqWarnings: PreviewWarningItem[];
} {
    const compat: string[] = [];
    const reqWarnings: PreviewWarningItem[] = [];
    const variables: PreviewRequirementVariable[] = [];
    const envFiles: PreviewRequirementEnvFile[] = [];
    const composeSecrets: Array<{ name: string }> = [];

    let parsed: unknown;
    try {
        parsed = parseYaml(composeContent);
    } catch (err) {
        compat.push(`compose YAML did not parse: ${err instanceof Error ? err.message : String(err)}`);
        return {
            requirements: { variables: [], envFiles: [], composeSecrets: [] },
            compat,
            reqWarnings,
        };
    }

    for (const ref of parseInterpolationRefs(composeContent)) {
        variables.push({
            name: ref.name,
            required: ref.required,
            hasDefault: ref.hasDefault,
            alternate: ref.alternate,
            likelySecret: isLikelySecretKey(ref.name),
        });
        if (ref.required) {
            reqWarnings.push({
                id: `req:var:${ref.name}`,
                source: 'requirement',
                severity: 'warning',
                message: `Required interpolation \${${ref.name}} must be set on target nodes`,
            });
        }
    }

    if (parsed && typeof parsed === 'object') {
        const doc = parsed as Record<string, unknown>;
        const services = (doc.services && typeof doc.services === 'object')
            ? doc.services as Record<string, unknown>
            : {};
        const byPath = new Map<string, boolean>();
        for (const [svcName, svc] of Object.entries(services)) {
            if (!svc || typeof svc !== 'object') continue;
            const s = svc as Record<string, unknown>;
            for (const entry of normalizeEnvFileField(s.env_file)) {
                const prev = byPath.get(entry.rawPath);
                if (prev === undefined) {
                    byPath.set(entry.rawPath, entry.required);
                } else if (prev !== entry.required) {
                    byPath.set(entry.rawPath, true);
                    reqWarnings.push({
                        id: `req:envfile-conflict:${entry.rawPath}`,
                        source: 'requirement',
                        severity: 'warning',
                        message: `env_file "${entry.rawPath}" has conflicting required flags (service ${svcName})`,
                    });
                }
            }
            if (Array.isArray(s.secrets)) {
                for (const sec of s.secrets) {
                    const name = composeSecretName(sec);
                    if (name) pushUniqueSecret(composeSecrets, name);
                }
            }
        }
        for (const [path, required] of byPath) {
            envFiles.push({ path, required });
            if (required) {
                reqWarnings.push({
                    id: `req:envfile:${path}`,
                    source: 'requirement',
                    severity: 'warning',
                    message: `Required env_file "${path}" must exist on target nodes`,
                });
            }
        }
        const topSecrets = doc.secrets;
        if (topSecrets && typeof topSecrets === 'object') {
            for (const name of Object.keys(topSecrets as Record<string, unknown>)) {
                pushUniqueSecret(composeSecrets, name);
            }
        }
    }

    return { requirements: { variables, envFiles, composeSecrets }, compat, reqWarnings };
}

interface RawAction {
    node: Node;
    action: PreviewAction;
    severity: PreviewSeverity;
    detail: string;
}

function projectActions(
    blueprint: Blueprint,
    allNodes: Node[],
    deployments: BlueprintDeployment[],
    decision: ReconcileDecision,
): RawAction[] {
    const byId = new Map(allNodes.map(n => [n.id, n]));
    const depByNode = new Map(deployments.map(d => [d.node_id, d]));
    const desiredNodes = BlueprintReconciler.getInstance().listDesiredNodes(blueprint, allNodes);
    const desiredIds = new Set(desiredNodes.map(n => n.id));
    const out: RawAction[] = [];
    const seen = new Set<number>();

    const push = (node: Node, action: PreviewAction, severity: PreviewSeverity, detail: string) => {
        out.push({ node, action, severity, detail });
        seen.add(node.id);
    };

    // A severed canonical target is invisible to every automatic action. The
    // decision arrays already refuse it, and marking it seen here keeps the
    // deployment-status fallbacks below from resurrecting a retry behind
    // the model's back.
    for (const nodeId of decision.severedNodeIds) {
        seen.add(nodeId);
    }

    // Status-precedence pass: in-flight, name conflict, and clear_* must win over
    // decision.withdraw / evictBlocked so Confirm never authorizes mid-flight mutates
    // and never-deployed guards stay on the remove-only clear_stale path.
    for (const dep of deployments) {
        const node = byId.get(dep.node_id);
        if (!node) continue;
        const desired = desiredIds.has(dep.node_id);
        const status = dep.status;

        if (status === 'name_conflict') {
            push(node, 'blocked_name_conflict', 'blocker', 'Name conflict; will not deploy or withdraw');
            continue;
        }
        if (status === 'deploying') {
            push(node, 'in_flight_deploy', 'warning', desired ? 'Deploy in flight' : 'Deploy in flight (leaving selector)');
            continue;
        }
        if (status === 'correcting') {
            push(node, 'in_flight_correct', 'warning', desired ? 'Drift correction in flight' : 'Correction in flight (leaving selector)');
            continue;
        }
        if (status === 'withdrawing') {
            push(node, 'in_flight_withdraw', 'warning', 'Withdraw in flight');
            continue;
        }
        if (!desired && status === 'pending_state_review' && dep.last_deployed_at == null) {
            push(node, 'clear_stale_guard', 'warning', 'Never-deployed state-review row; clear without compose down');
            continue;
        }
        if (desired && status === 'evict_blocked') {
            push(node, 'clear_reversed_evict', 'warning', 'Eviction guard while node is desired again; clear guard only');
        }
    }

    // A severed target the selector wants again used to vanish here: the node was
    // online and labelled and produced no row at all, so the plan read as nothing
    // to do with nothing to say about why. The tombstone still holds, because
    // only an explicit deploy re-opens a severed placement and that revival is
    // recorded by the transition itself. So the row is informational, names what
    // the operator has to do, and gives automatic placement no new authority.
    //
    // It yields to the status-precedence pass above, which pushes without a `seen`
    // guard: an in-flight or guard row is the specific, actionable truth about
    // that node right now, and a second explanation for the same node only asks
    // the operator to reconcile two rows pointing in different directions.
    for (const nodeId of decision.severedNodeIds) {
        if (!desiredIds.has(nodeId)) continue;
        if (out.some((row) => row.node.id === nodeId)) continue;
        const node = byId.get(nodeId);
        if (!node) continue;
        push(node, 'skip_withdrawn', 'warning', 'Withdrawn earlier; deploy again to restore');
    }

    for (const node of decision.deploy) {
        if (seen.has(node.id)) continue;
        const dep = depByNode.get(node.id);
        if (!dep) push(node, 'create', 'safe', 'New placement');
        else push(node, 'update', 'safe', 'Revision or retry deploy');
    }
    for (const node of decision.withdraw) {
        if (seen.has(node.id)) continue;
        push(node, 'remove', 'safe', 'Withdraw from selector');
    }
    for (const node of decision.check) {
        if (seen.has(node.id)) continue;
        const action = driftCheckAction(blueprint.drift_mode);
        push(
            node,
            action,
            driftCheckSeverity(action),
            action === 'check_enforce' ? 'Drift check may auto-correct (enforce)' : 'Drift observe/suggest check',
        );
    }
    for (const node of decision.stateReview) {
        if (seen.has(node.id)) continue;
        push(node, 'await_state_review', 'warning', 'Stateful placement awaits operator confirmation');
    }
    for (const node of decision.evictBlocked) {
        if (seen.has(node.id)) continue;
        push(node, 'await_evict_confirm', 'warning', 'Stateful eviction awaits operator confirmation');
    }

    for (const node of desiredNodes) {
        if (seen.has(node.id)) continue;
        const dep = depByNode.get(node.id);
        if (!dep && node.cordoned && blueprint.pinned_node_id !== node.id) {
            push(node, 'skip_cordoned', 'warning', 'Cordoned; new placements skipped');
        }
    }

    for (const dep of deployments) {
        if (seen.has(dep.node_id)) continue;
        const node = byId.get(dep.node_id);
        if (!node) continue;
        const desired = desiredIds.has(dep.node_id);
        const status = dep.status;

        if (desired) {
            if (status === 'pending_state_review') {
                push(node, 'await_state_review', 'warning', 'Awaiting state review');
            } else if (status === 'drifted') {
                const action = driftCheckAction(blueprint.drift_mode);
                push(node, action, driftCheckSeverity(action), 'Drifted; check pending');
            } else if (status === 'failed' || status === 'pending') {
                push(node, 'update', 'safe', 'Retry failed or pending deployment');
            } else if (status === 'withdrawn') {
                push(node, 'create', 'safe', 'Withdrawn but desired again');
            } else if (status === 'active') {
                const action = driftCheckAction(blueprint.drift_mode);
                push(node, action, driftCheckSeverity(action), 'Active deployment check');
            } else if (status === 'repair_held') {
                // A held target is still being checked, and the hold is a state
                // rather than a latch, so the preview offers the same check an
                // active row gets. Omitting it would make a target Sencho is
                // actively declining to repair look untracked.
                const action = driftCheckAction(blueprint.drift_mode);
                push(node, action, driftCheckSeverity(action), 'Repair held; recheck pending');
            }
        } else {
            if (status === 'withdrawn') continue;
            if (status === 'pending_state_review' || status === 'evict_blocked') {
                push(node, 'await_evict_confirm', 'warning', 'Stateful leave awaits eviction confirmation');
            } else if (blueprint.classification === 'stateful' || blueprint.classification === 'unknown') {
                push(node, 'await_evict_confirm', 'warning', 'Stateful leave awaits confirmation');
            } else {
                push(node, 'remove', 'safe', 'Leave selector');
            }
        }
    }

    return out;
}

function asApprovedBlueprint(blueprint: Blueprint): Blueprint & BlueprintApprovalFields {
    const b = blueprint as Blueprint & Partial<BlueprintApprovalFields>;
    return {
        ...blueprint,
        approval_status: b.approval_status ?? 'pending',
        approved_intent_fingerprint: b.approved_intent_fingerprint ?? null,
        approved_blast_json: b.approved_blast_json ?? null,
        approved_at: b.approved_at ?? null,
        approved_by: b.approved_by ?? null,
    };
}

/**
 * Why an Enforce plan a policy already approved is still waiting for Apply.
 *
 * The placement policy covers the node set, and Enforce then asks every
 * retained node for a repair. That repair is not part of the placement
 * decision, so the policy path declines the whole plan. The sentence is the
 * one the rollout preview and the operator docs both show.
 */
export const ENFORCE_APPROVAL_HOLD_REASON =
    'Enforce waits for Apply. Automatic placement acts in Observe or Suggest. In Enforce, a place, a withdrawal, or a repair under a policy approval stays pending until you confirm it.';

/**
 * The composed authority a preview, a list row, and the reconciler all read.
 *
 * The policy path is tried first, mirroring the reconciler: its approval is
 * bound to the current intent, while the combined approval's fingerprint does
 * not cover the node set a roster change moved. When the policy cannot run the
 * whole plan the combined approval is the fallback, and the surfaces report
 * what the tick does under it: approved when the plan is inside its blast,
 * reapproval required when the plan outgrew it, in which case the tick runs the
 * authorized subset and waits for the operator for the rest.
 *
 * The combined evaluation reads the same narrowed blast the executor does, so a
 * plan action the placement's frozen target set drops is unauthorized here too.
 * Reading the raw blast instead would report an approval the tick withholds, and
 * the plan would wait with nothing on screen to prompt for Apply.
 */
export function composeEffectiveApproval(
    blueprint: Blueprint,
    executorActions: ConfirmableActionRef[],
): {
    effectiveApproval: EffectiveApproval;
    unauthorizedActions: ConfirmableActionRef[];
    approvalAuthority: ApprovalAuthority | null;
    approvalHoldReason: string | null;
} {
    if (executorActions.length > 0) {
        const policyAuthorized = BlueprintReconciler.getInstance()
            .policyPlacementAuthorizedActions(blueprint, executorActions);
        if (policyAuthorized) {
            return {
                effectiveApproval: 'approved',
                unauthorizedActions: [],
                approvalAuthority: 'configured_policy',
                approvalHoldReason: null,
            };
        }
    }
    const evaluated = evaluateEffectiveApproval(scopedApprovedBlueprint(blueprint), executorActions);
    if (evaluated.effectiveApproval === 'approved') {
        return { ...evaluated, approvalAuthority: 'legacy_combined', approvalHoldReason: null };
    }
    // reapproval_required means the combined approval still runs the subset it
    // covers, including an Enforce repair. The hold sentence is only for a
    // plan the tick will not touch.
    if (evaluated.effectiveApproval !== 'pending') {
        return { ...evaluated, approvalAuthority: null, approvalHoldReason: null };
    }
    return {
        ...evaluated,
        approvalAuthority: null,
        approvalHoldReason: enforcePlacementHoldReason(blueprint, executorActions),
    };
}

/**
 * The Enforce hold, or null when Enforce is not what is keeping this plan waiting.
 *
 * The same method that refuses execution answers the question, with the hold
 * turned off: would this plan run if the retained nodes were only being
 * checked? A yes means the placement approval covers the plan and Enforce is
 * the only reason it is waiting, including when a retained node is mid-deploy
 * and its repair has dropped out of the plan. Any other refusal (a compose
 * edit, a first placement, a manual rollout) is a different wait, and this
 * reason would misname it.
 */
function enforcePlacementHoldReason(
    blueprint: Blueprint,
    executorActions: ConfirmableActionRef[],
): string | null {
    if (blueprint.drift_mode !== 'enforce') return null;
    const asObservation = executorActions.map((ref) => (
        ref.action === 'check_enforce' ? { nodeId: ref.nodeId, action: 'check_observe' as const } : ref
    ));
    const wouldRun = BlueprintReconciler.getInstance()
        .policyPlacementAuthorizedActions(blueprint, asObservation, { enforceHold: false });
    return wouldRun ? ENFORCE_APPROVAL_HOLD_REASON : null;
}

/**
 * The Blueprint as the executor sees it: its approved blast after the live
 * placement's frozen target set narrows it, or the Blueprint unchanged when
 * there is no placement authority to narrow by.
 *
 * Only the blast changes. The fingerprint is read from the same row by the
 * evaluator, so an approval the placement cannot resolve is left to report what
 * it always did, while a blast it narrows is evaluated narrowed.
 */
function scopedApprovedBlueprint(blueprint: Blueprint): Blueprint & Partial<BlueprintApprovalFields> {
    const approved = asApprovedBlueprint(blueprint);
    const parsed = parseApprovedBlastJson(blueprint.approved_blast_json);
    if (!parsed.ok) return approved;
    const scope = BlueprintReconciler.getInstance().scopeLegacyBlast(blueprint, parsed.entries);
    if (!scope?.resolvable || scope.entries.length === parsed.entries.length) return approved;
    return { ...approved, approved_blast_json: serializeApprovedBlast(scope.entries) };
}

/** Upgrade create rows to blockers when an unmanaged same-name stack already exists. */
function blockCreateForOwnership(row: RawAction, detail: string): void {
    row.action = 'blocked_name_conflict';
    row.severity = 'blocker';
    row.detail = detail;
}

async function applyCreateNameConflictBlockers(
    blueprintName: string,
    blueprintId: number,
    raw: RawAction[],
): Promise<void> {
    const { BlueprintService } = await import('./BlueprintService');
    const svc = BlueprintService.getInstance();
    for (const row of raw) {
        if (row.action !== 'create') continue;
        try {
            if (!(await svc.hasNameConflict(blueprintName, row.node, blueprintId))) continue;
            blockCreateForOwnership(row, 'Unmanaged stack with this name already exists on this node');
        } catch (err) {
            blockCreateForOwnership(
                row,
                err instanceof Error ? err.message : 'Cannot verify stack ownership on this node',
            );
        }
    }
}

export async function buildBlueprintPreview(blueprintId: number): Promise<BlueprintPreviewResult | null> {
    const db = DatabaseService.getInstance();
    const blueprint = db.getBlueprint(blueprintId);
    if (!blueprint) return null;
    const allNodes = db.getNodes();
    const deployments = db.listDeployments(blueprintId);
    const decision = BlueprintReconciler.getInstance().computeDecisionForPreview(blueprint, allNodes);
    const raw = projectActions(blueprint, allNodes, deployments, decision);
    await applyCreateNameConflictBlockers(blueprint.name, blueprint.id, raw);

    const changes: PreviewChangeRow[] = [];
    for (const row of raw) {
        const health = contactInfo(row.node);
        const severity = applyHealthSeverity(row.action, row.severity, health.elevateMutating);
        changes.push({
            nodeId: row.node.id,
            nodeName: row.node.name,
            nodeType: row.node.type,
            mode: row.node.mode ?? null,
            status: row.node.status,
            contactAt: health.contactAt,
            contactSource: health.contactSource,
            action: row.action,
            severity,
            kind: actionKind(row.action),
            detail: row.detail,
            reachabilityNote: health.reachabilityNote,
        });
    }

    const toActionRef = (c: { nodeId: number; action: PreviewAction }): ConfirmableActionRef => ({
        nodeId: c.nodeId,
        action: c.action,
    });
    const confirmable = changes
        .filter(c => c.action !== 'skip_cordoned' && c.action !== 'skip_withdrawn' && c.action !== 'blocked_name_conflict')
        .map(toActionRef);
    const executorActions = changes.filter(c => isExecutorAction(c.action)).map(toActionRef);

    const approvedBp = asApprovedBlueprint(blueprint);
    // The same composed authority the reconciler executes under: a covering
    // policy placement approval first, the legacy combined approval as the
    // fallback. Without the composition the editor would say pending while the
    // tick deployed anyway.
    const { effectiveApproval, unauthorizedActions, approvalAuthority, approvalHoldReason } =
        composeEffectiveApproval(blueprint, executorActions);

    const { requirements, compat, reqWarnings } = extractRequirements(blueprint.compose_content);
    const compatibilityWarnings = [...blueprint.classification_reasons, ...compat];

    const blockers: PreviewWarningItem[] = [];
    const warnings: PreviewWarningItem[] = [];
    let safeCount = 0;
    for (const c of changes) {
        if (c.severity === 'safe') {
            safeCount += 1;
            continue;
        }
        let message = `${c.nodeName}: ${c.detail}`;
        if (c.reachabilityNote !== 'Local node') {
            message += ` [${c.nodeType}/${c.status}: ${c.reachabilityNote}]`;
        }
        const item: PreviewWarningItem = {
            id: `change:${c.nodeId}:${c.action}`,
            source: 'change',
            severity: c.severity,
            message,
        };
        if (c.severity === 'blocker') blockers.push(item);
        else warnings.push(item);
    }
    warnings.push(...reqWarnings);
    for (const msg of compatibilityWarnings) {
        warnings.push({ id: `compat:${createHashId(msg)}`, source: 'compat', severity: 'warning', message: msg });
    }

    // Totals include requirement and compatibility warnings so UI header counts
    // match the lists operators see (not only per-change severity).
    const summary = {
        safe: safeCount,
        warning: warnings.length,
        blocker: blockers.length,
        total: changes.length,
    };

    const desiredNodes = BlueprintReconciler.getInstance().listDesiredNodes(blueprint, allNodes);
    const desiredIds = new Set(desiredNodes.map(n => n.id));
    const willDeploy = desiredNodes.filter(n => !deployments.some(d => d.node_id === n.id));
    const willCheck = desiredNodes.filter(n => deployments.some(d => d.node_id === n.id && d.status === 'active'));
    const willEvict = deployments
        .filter(d => !desiredIds.has(d.node_id) && d.status !== 'withdrawn')
        .map(d => d.node_id);

    const gitops = projectBlueprintRevision(blueprint.id);

    return {
        blueprintId: blueprint.id,
        classification: blueprint.classification,
        matchedNodes: desiredNodes.map(n => ({ id: n.id, name: n.name, type: n.type })),
        plannedDeployments: willDeploy.map(n => ({ id: n.id, name: n.name })),
        plannedDriftChecks: willCheck.map(n => ({ id: n.id, name: n.name })),
        plannedEvictions: willEvict,
        name: blueprint.name,
        revision: blueprint.revision,
        updatedAt: blueprint.updated_at,
        driftMode: blueprint.drift_mode,
        stackName: blueprint.name,
        approvalStatus: approvedBp.approval_status,
        effectiveApproval,
        approvalAuthority,
        approvalHoldReason,
        planFingerprint: intentFingerprint(blueprint),
        generatedAt: Date.now(),
        summary,
        changes,
        confirmableActions: confirmable,
        executorActions,
        unauthorizedActions,
        requirements,
        compatibilityWarnings,
        healthNote: HEALTH_NOTE,
        blockers,
        warnings,
        gitops,
        gitopsFingerprint: gitopsEvidenceFingerprint(gitops),
    };
}

/**
 * A flat canonical view of one facet's evidence. Values are scalars so the
 * digest below is a stable JSON string whatever the facet carries.
 */
type EvidenceJson = Record<string, string | number | boolean | null>;

/**
 * The binding fields of a rollout authorization. Every field is authority, so
 * the whole object is evidence; sorting the node ids keeps the digest stable
 * against the order a producer happened to record them in.
 */
function bindingEvidence(binding: FutureRolloutAuthorizationBinding): EvidenceJson {
    return {
        rolloutCandidateId: binding.rolloutCandidateId,
        acceptedGenerationId: binding.acceptedGenerationId,
        artifactSetId: binding.artifactSetId,
        intentRevisionId: binding.intentRevisionId,
        requiredNodeIds: [...binding.requiredNodeIds].sort((a, b) => a - b).join(','),
        sourceAcceptanceRef: binding.sourceAcceptanceRef,
        placementApprovalRef: binding.placementApprovalRef,
        preflightFingerprint: binding.preflightFingerprint,
    };
}

/** Identity fields plus the status: what a reader would need to re-derive the source state. */
function sourceEvidence(facet: SourceFacet): EvidenceJson {
    if (facet.status === 'not_applicable') return { status: facet.status };
    const base: EvidenceJson = {
        status: facet.status,
        configuredRepoUrl: facet.configuredRepoUrl,
        repoIdentityHost: facet.repoIdentity.host,
        repoIdentityPathname: facet.repoIdentity.pathname,
        configuredRef: facet.configuredRef,
        desiredCommitSha: facet.desiredCommitSha,
        fetchedCommitSha: facet.fetchedCommitSha,
        candidateGenerationId: facet.candidateGenerationId,
        acceptedGenerationId: facet.acceptedGenerationId,
    };
    switch (facet.status) {
        case 'source_superseded':
            return { ...base, supersededGenerationId: facet.supersededGenerationId };
        case 'applying':
            return { ...base, activeGenerationId: facet.activeGenerationId };
        case 'source_unknown':
            return {
                ...base,
                interruptedStage: facet.interruptedStage,
                interruptedGenerationId: facet.interruptedGenerationId,
            };
        case 'recovery_required':
            return { ...base, recoveryRef: facet.recoveryRef, recoveryGenerationId: facet.recoveryGenerationId };
        case 'recovery_failed':
            return {
                ...base,
                recoveryRef: facet.recoveryRef,
                recoveryGenerationId: facet.recoveryGenerationId,
                failureClass: facet.failureClass,
            };
        case 'source_failed':
            return { ...base, failureStage: facet.failureStage, failureClass: facet.failureClass };
        case 'not_live':
            return { ...base, lifecycleStatus: facet.lifecycleStatus };
        case 'never_reconciled':
        case 'checking_fetching':
        case 'application_generation_accepted':
        case 'candidate_ready':
        case 'source_review_pending':
        case 'source_conflict_blocker':
        case 'source_reconcile_required':
        case 'source_retry_scheduled':
        case 'source_poll_scheduled':
        case 'source_suspended':
            return base;
        default: {
            // Exhaustiveness guard: a status added to SourceFacet without a case
            // here fails to compile rather than silently binding only its name.
            const _exhaustive: never = facet;
            void _exhaustive;
            return base;
        }
    }
}

/**
 * The artifact set identity and qualification, which are what "executable"
 * means here. The observed identity strings (expected/latest evidence) are
 * excluded: the set id plus evidence version is the immutable identity they
 * describe, and re-observing the same identity would otherwise move the digest.
 */
function artifactEvidence(facet: ArtifactFacet): EvidenceJson {
    const base: EvidenceJson = { status: facet.status };
    if (facet.status === 'not_applicable') return base;
    base.generationId = facet.generationId;
    if (facet.expected) {
        base.expectedArtifactSetId = facet.expected.artifactSetId;
        base.expectedEvidenceVersion = facet.expected.evidenceVersion;
        base.expectedQualification = facet.expected.qualification;
    }
    if (facet.latestEvidence === null) {
        base.limitation = facet.limitation;
        return base;
    }
    base.artifactSetId = facet.artifactSetId;
    base.evidenceVersion = facet.evidenceVersion;
    base.qualification = facet.qualification;
    return base;
}

/** Placement is pure authority: pending, stale, blocked and bound states carry nothing else. */
function placementEvidence(facet: PlacementFacet): EvidenceJson {
    const base: EvidenceJson = { status: facet.status };
    switch (facet.status) {
        case 'unknown':
            return { ...base, limitation: facet.limitation };
        case 'source_acceptance_pending':
            return {
                ...base,
                sourceAcceptanceRef: facet.sourceAcceptanceRef,
                candidateGenerationId: facet.candidateGenerationId,
            };
        case 'rollout_authorization_pending':
            return { ...base, binding: JSON.stringify(bindingEvidence(facet.binding)) };
        case 'rollout_authorization_stale':
            return {
                ...base,
                rolloutAuthorizationRef: facet.rolloutAuthorizationRef,
                bound: JSON.stringify(bindingEvidence(facet.bound)),
            };
        case 'preflight_blocked':
            return { ...base, reason: facet.reason, binding: JSON.stringify(bindingEvidence(facet.binding)) };
        case 'blueprint_bound':
            return { ...base, completion: facet.completion };
        case 'not_applicable':
        case 'unbound_direct':
        case 'placement_review_pending':
        case 'stateful_confirmation_required':
            return base;
        default: {
            // Exhaustiveness guard: a status added to PlacementFacet without a
            // case here fails to compile rather than silently dropping the
            // authority fields it carries.
            const _exhaustive: never = facet;
            void _exhaustive;
            return base;
        }
    }
}

/** The rollout generation identity. `partial` is progress detail, not authority. */
function rolloutEvidence(facet: RolloutFacet): EvidenceJson {
    const base: EvidenceJson = { status: facet.status };
    switch (facet.status) {
        case 'rollout_not_executable':
            return { ...base, rolloutCandidateId: facet.rolloutCandidateId };
        case 'rollout_queued':
        case 'canary_in_progress':
        case 'batch_in_progress':
        case 'fully_deployed_health_pending':
        case 'configuration_converged_artifact_qualified':
        case 'exactly_converged_healthy':
        case 'rollout_superseded':
            return { ...base, rolloutGenerationId: facet.rolloutGenerationId };
        case 'rollback_in_progress':
            return { ...base, recoveryRef: facet.recoveryRef, recoveryGenerationId: facet.recoveryGenerationId };
        case 'rollback_partial_failed':
            return {
                ...base,
                recoveryRef: facet.recoveryRef,
                recoveryGenerationId: facet.recoveryGenerationId,
                failureClass: facet.failureClass,
            };
        case 'not_applicable':
        case 'rollout_paused':
        case 'partially_rolled_out':
        case 'target_stale':
        case 'target_unreachable':
        case 'recovery_required':
        case 'completion_unknown':
            return base;
        default: {
            // Exhaustiveness guard: a status added to RolloutFacet without a case
            // here fails to compile rather than silently binding only its name.
            const _exhaustive: never = facet;
            void _exhaustive;
            return base;
        }
    }
}

function limitationEvidence(limitations: readonly GitOpsLimitation[]): string {
    return JSON.stringify([...limitations].map(limitation => limitation.code).sort());
}

/**
 * Digest of the evidence a preview binds an operator's confirmation to.
 *
 * Covers the authority the preview displays: the recorded authority refs, the
 * rollout generation, and the source/artifact/placement/rollout statuses with
 * their identity-bearing fields. Timestamps, retry counters, operation ids and
 * per-target runtime/health observations are deliberately excluded: they are
 * shown for judgement, not treated as authority, and folding in one that moves
 * on a poll or heartbeat would strand every preview in a steady-state fleet as
 * permanently stale. Per-target identity fields, live-arm caveats and pause
 * reasons are excluded the same way; the application-level authority above is
 * what gates execution.
 *
 * Null when there is nothing to bind: a Blueprint with no application row, or
 * none the model has been asked about, has no GitOps evidence and its preview
 * keeps the intent fingerprint as its only currency. A projection that could
 * not derive an application it had reason to believe exists is a distinct
 * fault, so its limitation codes are bound rather than read as the ordinary
 * absence. The codes are the classified facts; the free-form evidence payload
 * behind them is not, since nothing validates its shape or stability.
 */
export function gitopsEvidenceFingerprint(projection: GitOpsRevisionProjection): string | null {
    if (projection.targetMode === 'not_applicable') {
        if (projection.limitations.length === 0) return null;
        return digest({ limitations: limitationEvidence(projection.limitations) });
    }
    return digest({
        applicationId: projection.applicationId,
        lifecycleStatus: projection.lifecycleStatus,
        rolloutGenerationId: projection.rolloutGenerationId,
        approvals: {
            sourceAcceptanceRef: projection.approvals.sourceAcceptanceRef,
            placementApprovalRef: projection.approvals.placementApprovalRef,
            rolloutAuthorizationRef: projection.approvals.rolloutAuthorizationRef,
            legacyCombinedApprovalRef: projection.approvals.legacyCombinedApprovalRef,
        },
        facets: {
            source: sourceEvidence(projection.facets.source),
            artifact: artifactEvidence(projection.facets.artifact),
            placement: placementEvidence(projection.facets.placement),
            rollout: rolloutEvidence(projection.facets.rollout),
        },
    });
}

function digest(evidence: unknown): string {
    return createHash('sha256').update(JSON.stringify(evidence), 'utf8').digest('hex');
}

function createHashId(msg: string): string {
    let h = 0;
    for (let i = 0; i < msg.length; i++) h = ((h << 5) - h + msg.charCodeAt(i)) | 0;
    return String(h);
}

/** Lightweight list/detail evaluator: no requirements/health fanout. */
export function evaluateLightweightEffectiveApproval(blueprintId: number): {
    effectiveApproval: EffectiveApproval;
    unauthorizedActions: ConfirmableActionRef[];
} | null {
    const db = DatabaseService.getInstance();
    const blueprint = db.getBlueprint(blueprintId);
    if (!blueprint) return null;
    const allNodes = db.getNodes();
    const deployments = db.listDeployments(blueprintId);
    const decision = BlueprintReconciler.getInstance().computeDecisionForPreview(blueprint, allNodes);
    const raw = projectActions(blueprint, allNodes, deployments, decision);
    const executorActions = raw
        .filter(r => isExecutorAction(r.action))
        .map(r => ({ nodeId: r.node.id, action: r.action }));
    // The composed authority, not the legacy columns alone: a plan a policy
    // placement approval covers is approved here exactly as the preview and the
    // reconciler read it, so the catalog chip cannot say pending for a
    // Blueprint the tick is about to execute.
    const { effectiveApproval, unauthorizedActions } = composeEffectiveApproval(blueprint, executorActions);
    return { effectiveApproval, unauthorizedActions };
}

/** Executor: clear reversed eviction guard. Cleanup-only this pass. */
export function applyClearReversedEvict(blueprintId: number, nodeId: number): void {
    const db = DatabaseService.getInstance();
    const dep = db.getDeployment(blueprintId, nodeId);
    if (!dep || dep.status !== 'evict_blocked') return;
    if (dep.last_deployed_at == null) {
        db.deleteDeployment(blueprintId, nodeId);
        return;
    }
    db.upsertDeployment({
        blueprint_id: blueprintId,
        node_id: nodeId,
        status: 'active',
        applied_revision: dep.applied_revision,
        last_deployed_at: dep.last_deployed_at,
        last_checked_at: dep.last_checked_at,
        last_drift_at: dep.last_drift_at,
        drift_summary: null,
        last_error: null,
    });
}

/** Executor: delete never-deployed stale guard row. */
export function applyClearStaleGuard(blueprintId: number, nodeId: number): void {
    const db = DatabaseService.getInstance();
    const dep = db.getDeployment(blueprintId, nodeId);
    if (!dep || dep.status !== 'pending_state_review' || dep.last_deployed_at != null) return;
    // Retire first. The guard row is what the clear path keys off, so deleting
    // it before the target is retired strands the target on a hold whose only
    // resolution has just been removed: the node keeps reporting a stateful
    // confirmation and no tick will clear it again. Failing here leaves both in
    // place, so the next tick retries instead.
    if (!retireHeldTarget(blueprintId, nodeId)) return;
    db.deleteDeployment(blueprintId, nodeId);
}

/**
 * Retire the revision-state target that was holding this node.
 *
 * Clearing the guard deletes the deployment row the hold was recorded against,
 * so the target would otherwise keep reporting a stateful confirmation for a
 * placement that no longer exists, and the projection would pin the whole
 * application to awaiting a confirmation the operator has no way to perform:
 * the clear path is the only thing that resolves the hold, and it has already
 * run. Retiring rather than clearing the stage, because the node is no longer
 * part of this placement and a later placement mints a fresh target on first
 * contact.
 *
 * Best-effort by design. The projection is a read model and this guard row is
 * authoritative on its own; refusing to delete it because the revision state
 * could not be updated would strand the deployment the operator asked to clear.
 */
function retireHeldTarget(blueprintId: number, nodeId: number): boolean {
    try {
        const store = GitOpsStore.getInstance();
        const app = store.getLiveBlueprintApplication(blueprintId);
        if (!app) return true;
        const target = store.getTarget(app.id, nodeId);
        if (!target || target.target_status !== 'active') return true;
        GitOpsTransitions.getInstance().targetTombstoned(app.id, nodeId, {
            // Distinct per call rather than derived from the node, because
            // history dedupes on the operation id: a deterministic one makes a
            // second hold-and-clear cycle on the same node look like a replay
            // and silently drop its audit row.
            operationId: `op-stale-guard-clear-${randomUUID()}`,
            actor: null,
            trigger: 'blueprint_stale_guard_clear',
            at: Date.now(),
        });
        return true;
    } catch (error) {
        console.error(
            '[BlueprintPreview] could not retire the held target for blueprint %d on node %d:',
            blueprintId,
            nodeId,
            error instanceof Error ? error.stack ?? error.message : String(error),
        );
        return false;
    }
}
