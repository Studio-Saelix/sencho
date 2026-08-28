/**
 * Pure Blueprint rollout preview projection. Zero DB writes.
 * Executor cleanup helpers for clear_reversed_evict / clear_stale_guard live at the bottom.
 */

import { parse as parseYaml } from 'yaml';
import {
    DatabaseService,
    type Blueprint,
    type BlueprintDeployment,
    type Node,
} from './DatabaseService';
import { BlueprintReconciler, type ReconcileDecision } from './BlueprintReconciler';
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
} from './blueprintApproval';

export const BLUEPRINT_PREVIEW_PILOT_STALE_MS = 60_000;
export const BLUEPRINT_PREVIEW_PROXY_STALE_MS = 120_000;

export type PreviewSeverity = 'safe' | 'warning' | 'blocker';

export interface PreviewChangeRow {
    nodeId: number;
    nodeName: string;
    nodeType: 'local' | 'remote';
    mode: string | null;
    status: Node['status'];
    contactAt: number | null;
    contactSource: 'local' | 'pilot_last_seen' | 'last_successful_contact';
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
}

const HEALTH_NOTE = 'Reachability is from cached node status and mode-specific contact timestamps; preview does not probe remotes.';

function isMutatingAction(action: PreviewAction): boolean {
    return action === 'create'
        || action === 'update'
        || action === 'remove'
        || action === 'check_enforce';
}

function contactInfo(node: Node): {
    contactAt: number | null;
    contactSource: PreviewChangeRow['contactSource'];
    reachabilityNote: string;
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
        .filter(c => c.action !== 'skip_cordoned' && c.action !== 'blocked_name_conflict')
        .map(toActionRef);
    const executorActions = changes.filter(c => isExecutorAction(c.action)).map(toActionRef);

    const approvedBp = asApprovedBlueprint(blueprint);
    const { effectiveApproval, unauthorizedActions } = evaluateEffectiveApproval(approvedBp, executorActions);

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
    };
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
    const { effectiveApproval, unauthorizedActions } = evaluateEffectiveApproval(
        asApprovedBlueprint(blueprint),
        executorActions,
    );
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
    db.deleteDeployment(blueprintId, nodeId);
}
