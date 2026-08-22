import {
    DatabaseService,
    type Blueprint,
    type BlueprintDeployment,
    type Node,
} from './DatabaseService';
import { BlueprintService, type DeployOutcome } from './BlueprintService';
import { BlueprintAnalyzer } from './BlueprintAnalyzer';
import { NodeLabelService } from './NodeLabelService';
import { NotificationService } from './NotificationService';
import { sanitizeForLog } from '../utils/safeLog';
import {
    type ConfirmableActionRef,
    type PreviewAction,
    filterAuthorizedExecutorActions,
    intentFingerprint,
    parseApprovedBlastJson,
} from './blueprintApproval';
import {
    applyClearReversedEvict,
    applyClearStaleGuard,
    buildBlueprintPreview,
} from './blueprintPreviewProjection';
import { commitBlueprintDeploymentCause } from './gitops/blueprintDeploymentProducers';

const RECONCILER_INTERVAL_MS = 60_000;
const RECONCILER_INITIAL_DELAY_MS = 5_000;

export type ConfirmedActionOutcomeStatus = 'ok' | 'failed' | 'name_conflict' | 'pending' | 'skipped';

export interface ConfirmedActionOutcome {
    nodeId: number;
    nodeName: string;
    action: PreviewAction;
    status: ConfirmedActionOutcomeStatus;
    error?: string | null;
}

export interface ConfirmedPlanResult {
    outcomes: ConfirmedActionOutcome[];
    /** True when the approval gate refused execution (Apply must not claim success). */
    refused?: boolean;
}

export interface ConfirmedOutcomeSummary {
    total: number;
    ok: number;
    failed: number;
    pending: number;
    skipped: number;
}

export function summarizeConfirmedOutcomes(outcomes: ConfirmedActionOutcome[]): ConfirmedOutcomeSummary {
    let ok = 0;
    let failed = 0;
    let pending = 0;
    let skipped = 0;
    for (const outcome of outcomes) {
        switch (outcome.status) {
            case 'ok':
                ok += 1;
                break;
            case 'failed':
            case 'name_conflict':
                failed += 1;
                break;
            case 'pending':
                pending += 1;
                break;
            case 'skipped':
                skipped += 1;
                break;
        }
    }
    return { total: outcomes.length, ok, failed, pending, skipped };
}

export function messageForConfirmedOutcomes(summary: ConfirmedOutcomeSummary): string {
    if (summary.failed > 0) return 'Rollout confirmed with node failures';
    if (summary.pending > 0) return 'Rollout confirmed; some actions are still in progress';
    return 'Rollout confirmed';
}

/** Apply finished a confirmed snapshot, but live approval is no longer current. */
export function messageForSnapshotFinishedWithStaleApproval(summary: ConfirmedOutcomeSummary): string {
    if (summary.failed > 0) {
        return 'Confirmed snapshot finished with node failures; approval is no longer current';
    }
    if (summary.pending > 0) {
        return 'Confirmed snapshot finished with actions still in progress; approval is no longer current';
    }
    return 'Confirmed snapshot finished; approval is no longer current';
}

function mapDeployOutcome(
    base: { nodeId: number; nodeName: string; action: PreviewAction },
    result: DeployOutcome,
): ConfirmedActionOutcome {
    if (result.status === 'active' || result.status === 'withdrawn') {
        return { ...base, status: 'ok' };
    }
    if (result.status === 'name_conflict') {
        return { ...base, status: 'name_conflict', error: result.error ?? 'name_conflict' };
    }
    if (result.status === 'pending' || result.status === 'deploying' || result.status === 'withdrawing') {
        return { ...base, status: 'pending', error: result.error ?? null };
    }
    return { ...base, status: 'failed', error: result.error ?? result.status };
}

function isDeveloperModeEnabled(): boolean {
    try {
        return DatabaseService.getInstance().getGlobalSettings().developer_mode === '1';
    } catch {
        return false;
    }
}

function diagnosticLog(message: string, fields: Record<string, string | number | boolean | null | undefined>): void {
    if (!isDeveloperModeEnabled()) return;
    const safeFields = Object.fromEntries(
        Object.entries(fields).map(([key, value]) => [key, typeof value === 'string' ? sanitizeForLog(value) : value]),
    );
    console.info(`[BlueprintReconciler:diag] ${message}`, safeFields);
}

/** Local seed name must not reach fleet alerts; remote roster names stay. */
function nodeLocationClause(node: Node): string {
    return node.type === 'local' ? 'on this node' : `on node "${node.name}"`;
}

export interface ReconcileDecision {
    deploy: Node[];
    withdraw: Node[];
    check: Node[];
    stateReview: Node[];
    evictBlocked: Node[];
}

/**
 * BlueprintReconciler is the desired-state loop. Every tick it reads each
 * enabled blueprint, resolves its selector, and reconciles the per-node
 * state against the desired set. It honors the state-aware guards
 * (stateful blueprints get pending_state_review on first deploy and
 * evict_blocked on un-target) and the three-mode drift policy.
 */
export class BlueprintReconciler {
    private static instance: BlueprintReconciler | null = null;
    private intervalHandle: ReturnType<typeof setInterval> | null = null;
    private initialTimer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private stopped = false;

    static getInstance(): BlueprintReconciler {
        if (!BlueprintReconciler.instance) {
            BlueprintReconciler.instance = new BlueprintReconciler();
        }
        return BlueprintReconciler.instance;
    }

    private constructor() { /* singleton */ }

    start(): void {
        if (this.intervalHandle || this.initialTimer) return;
        this.stopped = false;
        this.initialTimer = setTimeout(() => {
            this.initialTimer = null;
            // Guard against a stop() that fired during the initial delay.
            if (this.stopped) return;
            void this.evaluate();
            this.intervalHandle = setInterval(() => void this.evaluate(), RECONCILER_INTERVAL_MS);
        }, RECONCILER_INITIAL_DELAY_MS);
    }

    stop(): void {
        this.stopped = true;
        if (this.initialTimer) { clearTimeout(this.initialTimer); this.initialTimer = null; }
        if (this.intervalHandle) { clearInterval(this.intervalHandle); this.intervalHandle = null; }
    }

    /**
     * Force one tick. Useful for the /apply endpoint and tests.
     */
    async tick(): Promise<void> {
        await this.evaluate();
    }

    /**
     * Force reconciliation for a single blueprint. Invoked after Confirm
     * persists approval, or by pin (still gated). Prefer reconcileConfirmedPlan
     * for Apply so execution uses the validated immutable action set.
     */
    async reconcileOne(blueprintId: number): Promise<void> {
        const blueprint = DatabaseService.getInstance().getBlueprint(blueprintId);
        if (!blueprint || !blueprint.enabled) return;
        const nodes = DatabaseService.getInstance().getNodes();
        diagnosticLog('manual reconcile requested', { blueprintId, nodeCount: nodes.length });
        await this.reconcileBlueprint(blueprint, nodes);
    }

    /**
     * Execute only the provided executor actions for an already-validated plan.
     * Does not recompute or widen the action set. Returns per-node outcomes so
     * Apply can report partial failure without claiming a clean rollout.
     */
    async reconcileConfirmedPlan(
        blueprintId: number,
        executorActions: ConfirmableActionRef[],
    ): Promise<ConfirmedPlanResult> {
        const blueprint = DatabaseService.getInstance().getBlueprint(blueprintId);
        if (!blueprint || !blueprint.enabled) {
            return { outcomes: [], refused: true };
        }
        const parsed = parseApprovedBlastJson(blueprint.approved_blast_json);
        // Same fail-closed gate as tick reconcile: never execute when approval is
        // missing, invalid, or the stored fingerprint no longer matches live intent.
        if (
            !parsed.ok
            || blueprint.approval_status !== 'approved'
            || blueprint.approved_intent_fingerprint !== intentFingerprint(blueprint)
        ) {
            diagnosticLog('reconcileConfirmedPlan skipped: approval missing, invalid, or drifted', { blueprintId });
            return { outcomes: [], refused: true };
        }
        const authorized = filterAuthorizedExecutorActions(parsed.entries, executorActions);
        const nodes = DatabaseService.getInstance().getNodes();
        const byId = new Map(nodes.map(n => [n.id, n]));
        const outcomes = await this.executeAuthorizedActions(blueprint, byId, authorized);
        return { outcomes };
    }

    private async evaluate(): Promise<void> {
        if (this.running) return; // prevent overlap on slow ticks
        this.running = true;
        const started = Date.now();
        try {
            const db = DatabaseService.getInstance();
            const blueprints = db.listEnabledBlueprints();
            if (blueprints.length === 0) return;
            const nodes = db.getNodes();
            console.info('[BlueprintReconciler] tick start blueprints=%s nodes=%s', blueprints.length, nodes.length);
            diagnosticLog('tick inputs', { blueprintCount: blueprints.length, nodeCount: nodes.length });
            for (const blueprint of blueprints) {
                try {
                    await this.reconcileBlueprint(blueprint, nodes);
                } catch (err) {
                    console.error(`[BlueprintReconciler] failed for blueprint "${blueprint.name}":`, err);
                }
            }
            console.info('[BlueprintReconciler] tick complete blueprints=%s durationMs=%s', blueprints.length, Date.now() - started);
        } finally {
            this.running = false;
        }
    }

    private async reconcileBlueprint(blueprint: Blueprint, allNodes: Node[]): Promise<void> {
        const preview = await buildBlueprintPreview(blueprint.id);
        if (!preview) return;

        const parsed = parseApprovedBlastJson(blueprint.approved_blast_json);
        if (
            blueprint.approval_status !== 'approved'
            || !parsed.ok
            || blueprint.approved_intent_fingerprint !== intentFingerprint(blueprint)
        ) {
            diagnosticLog('reconcile skipped: no valid approval', {
                blueprintId: blueprint.id,
                effectiveApproval: preview.effectiveApproval,
            });
            return;
        }

        const authorized = filterAuthorizedExecutorActions(parsed.entries, preview.executorActions);
        if (authorized.length === 0) {
            diagnosticLog('reconcile skipped: no authorized executor actions', { blueprintId: blueprint.id });
            return;
        }

        diagnosticLog('decision authorized', {
            blueprintId: blueprint.id,
            blueprintName: blueprint.name,
            revision: blueprint.revision,
            authorized: authorized.length,
            unauthorized: preview.unauthorizedActions.length,
        });

        const byId = new Map(allNodes.map(n => [n.id, n]));
        await this.executeAuthorizedActions(blueprint, byId, authorized);
    }

    private async executeAuthorizedActions(
        blueprint: Blueprint,
        byId: Map<number, Node>,
        actions: ConfirmableActionRef[],
    ): Promise<ConfirmedActionOutcome[]> {
        const svc = BlueprintService.getInstance();
        const outcomes: ConfirmedActionOutcome[] = [];
        for (const { nodeId, action } of actions) {
            const node = byId.get(nodeId);
            if (!node) {
                console.warn(
                    `[BlueprintReconciler] confirmed plan skipped missing node ${nodeId} for blueprint ${blueprint.id}`,
                );
                outcomes.push({
                    nodeId,
                    nodeName: `node-${nodeId}`,
                    action,
                    status: 'skipped',
                    error: 'Node not found',
                });
                continue;
            }
            outcomes.push(await this.executeOneAction(blueprint, node, action, svc));
        }
        return outcomes;
    }

    private async executeOneAction(
        blueprint: Blueprint,
        node: Node,
        action: PreviewAction,
        svc: BlueprintService,
    ): Promise<ConfirmedActionOutcome> {
        const base = { nodeId: node.id, nodeName: node.name, action };
        switch (action) {
            case 'await_state_review': {
                const existing = DatabaseService.getInstance().getDeployment(blueprint.id, node.id);
                commitBlueprintDeploymentCause('await_state_review', blueprint.id, node.id, {
                    status: 'pending_state_review',
                    last_checked_at: Date.now(),
                    drift_summary: existing
                        ? 'Stateful blueprint revision change awaits operator confirmation'
                        : 'Stateful blueprint awaiting operator confirmation before first deploy',
                }, null);
                return { ...base, status: 'ok' };
            }
            case 'await_evict_confirm': {
                commitBlueprintDeploymentCause('await_evict_confirm', blueprint.id, node.id, {
                    status: 'evict_blocked',
                    last_checked_at: Date.now(),
                    drift_summary: 'Stateful blueprint eviction requires operator confirmation',
                }, null);
                return { ...base, status: 'ok' };
            }
            case 'clear_reversed_evict':
                applyClearReversedEvict(blueprint.id, node.id);
                return { ...base, status: 'ok' };
            case 'clear_stale_guard':
                applyClearStaleGuard(blueprint.id, node.id);
                return { ...base, status: 'ok' };
            case 'create':
            case 'update': {
                const result = await svc.deployToNode(blueprint, node);
                return mapDeployOutcome(base, result);
            }
            case 'remove': {
                const result = await svc.withdrawFromNode(blueprint, node);
                return mapDeployOutcome(base, result);
            }
            case 'check_observe':
            case 'check_enforce': {
                const driftResult = await svc.checkForDrift(blueprint, node);
                if (!driftResult.drifted) return { ...base, status: 'ok' };
                const reason = driftResult.reason ?? 'unknown drift';
                commitBlueprintDeploymentCause('drift_observed', blueprint.id, node.id, {
                    status: 'drifted',
                    last_checked_at: Date.now(),
                    last_drift_at: Date.now(),
                    drift_summary: reason,
                }, null);
                // observe/suggest/enforce: notify path via handleDrift still respects drift_mode
                await this.handleDrift(blueprint, node, reason);
                return { ...base, status: 'ok' };
            }
            default:
                return { ...base, status: 'skipped', error: `Unsupported action ${action}` };
        }
    }

    /**
     * Validate Accept against current approval and placement.
     * Returns ok when the guard row and approved place outcome still match.
     */
    validateGuardConfirmation(
        blueprintId: number,
        nodeId: number,
        kind: 'accept' | 'evict',
    ): { ok: true } | { ok: false; code: string; error: string } {
        if (kind === 'evict') {
            // Guard-path Evict still requires the evict_blocked row; open withdraw uses
            // validateWithdrawConfirmation without that flag.
            return this.validateWithdrawConfirmation(blueprintId, nodeId, { requireEvictBlocked: true });
        }
        const db = DatabaseService.getInstance();
        const blueprint = db.getBlueprint(blueprintId);
        if (!blueprint) return { ok: false, code: 'not_found', error: 'Blueprint not found' };
        const node = db.getNode(nodeId);
        if (!node) return { ok: false, code: 'not_found', error: 'Node not found' };
        const dep = db.getDeployment(blueprintId, nodeId);
        if (!dep || dep.status !== 'pending_state_review') {
            return { ok: false, code: 'STALE_GUARD', error: 'Deployment is not awaiting state review' };
        }

        const approval = this.requireApprovedRemoveOrPlace(blueprint, nodeId, 'place');
        if (!approval.ok) return approval;
        const desired = this.listDesiredNodes(blueprint, db.getNodes()).some(n => n.id === nodeId);
        if (!desired) {
            return { ok: false, code: 'STALE_GUARD', error: 'Node is no longer an approved placement target' };
        }
        return { ok: true };
    }

    /**
     * Validate manual withdraw/evict against current remove approval.
     * Manual destroy of an active row still requires an approved remove outcome
     * and a node that is no longer desired (same contract as reconciler remove).
     */
    validateWithdrawConfirmation(
        blueprintId: number,
        nodeId: number,
        opts: { requireEvictBlocked?: boolean } = {},
    ): { ok: true } | { ok: false; code: string; error: string } {
        const db = DatabaseService.getInstance();
        const blueprint = db.getBlueprint(blueprintId);
        if (!blueprint) return { ok: false, code: 'not_found', error: 'Blueprint not found' };
        const node = db.getNode(nodeId);
        if (!node) return { ok: false, code: 'not_found', error: 'Node not found' };
        const dep = db.getDeployment(blueprintId, nodeId);
        if (!dep || dep.status === 'withdrawn') {
            return { ok: false, code: 'STALE_GUARD', error: 'No withdrawable deployment on this node' };
        }
        if (opts.requireEvictBlocked && dep.status !== 'evict_blocked') {
            return { ok: false, code: 'STALE_GUARD', error: 'Deployment is not awaiting eviction confirmation' };
        }

        const approval = this.requireApprovedRemoveOrPlace(blueprint, nodeId, 'remove');
        if (!approval.ok) return approval;
        const desired = this.listDesiredNodes(blueprint, db.getNodes()).some(n => n.id === nodeId);
        if (desired) {
            return { ok: false, code: 'STALE_GUARD', error: 'Node is no longer an approved removal target' };
        }
        return { ok: true };
    }

    private requireApprovedRemoveOrPlace(
        blueprint: Blueprint,
        nodeId: number,
        outcomeNeeded: 'place' | 'remove',
    ): { ok: true } | { ok: false; code: string; error: string } {
        const parsed = parseApprovedBlastJson(blueprint.approved_blast_json);
        if (
            blueprint.approval_status !== 'approved'
            || !parsed.ok
            || blueprint.approved_intent_fingerprint !== intentFingerprint(blueprint)
        ) {
            return { ok: false, code: 'STALE_GUARD', error: 'Blueprint approval is no longer valid; preview and confirm again' };
        }
        const outcome = parsed.entries.find(e => e.nodeId === nodeId)?.outcome;
        if (outcome !== outcomeNeeded) {
            const errors: Record<'place' | 'remove', string> = {
                place: 'Node is no longer an approved placement target',
                remove: 'Node is no longer an approved removal target',
            };
            return { ok: false, code: 'STALE_GUARD', error: errors[outcomeNeeded] };
        }
        return { ok: true };
    }

    /** Public wrapper for preview/approval projection (read-only). */
    computeDecisionForPreview(blueprint: Blueprint, allNodes: Node[]): ReconcileDecision {
        return this.computeDecision(blueprint, allNodes);
    }

    /** Desired node set after pin/selector (read-only). */
    listDesiredNodes(blueprint: Blueprint, allNodes: Node[]): Node[] {
        if (blueprint.pinned_node_id !== null) {
            const pinned = allNodes.find(n => n.id === blueprint.pinned_node_id);
            return pinned ? [pinned] : [];
        }
        return NodeLabelService.getInstance().matchSelector(blueprint.selector, allNodes);
    }

    private computeDecision(blueprint: Blueprint, allNodes: Node[]): ReconcileDecision {
        // Pin override: a pinned blueprint deploys only on its pinned node,
        // regardless of the selector. The pinned node also wins over a
        // cordon flag (pin is an explicit operator decision; cordon governs
        // automatic placement only).
        let desiredNodes: Node[];
        if (blueprint.pinned_node_id !== null) {
            const pinned = allNodes.find(n => n.id === blueprint.pinned_node_id);
            if (!pinned) {
                console.warn(
                    `[BlueprintReconciler] blueprint "${blueprint.name}" pinned to node ${blueprint.pinned_node_id} which no longer exists; treating desired set as empty`,
                );
                desiredNodes = [];
            } else {
                desiredNodes = [pinned];
            }
        } else {
            const labelSvc = NodeLabelService.getInstance();
            desiredNodes = labelSvc.matchSelector(blueprint.selector, allNodes);
        }
        const desiredIds = new Set(desiredNodes.map(n => n.id));

        const existingDeployments = DatabaseService.getInstance().listDeployments(blueprint.id);
        const deploymentByNode = new Map<number, BlueprintDeployment>();
        for (const dep of existingDeployments) deploymentByNode.set(dep.node_id, dep);

        const decision: ReconcileDecision = {
            deploy: [],
            withdraw: [],
            check: [],
            stateReview: [],
            evictBlocked: [],
        };

        // Desired but not active or stale
        for (const node of desiredNodes) {
            const dep = deploymentByNode.get(node.id);
            if (!dep) {
                // Cordon filter: skip new placements onto cordoned nodes.
                // Pin always wins, so the pinned node is exempt. Existing
                // deployments below are untouched: cordon does not evict.
                if (node.cordoned && blueprint.pinned_node_id !== node.id) {
                    continue;
                }
                if (blueprint.classification === 'stateful' || blueprint.classification === 'unknown') {
                    decision.stateReview.push(node);
                } else {
                    decision.deploy.push(node);
                }
                continue;
            }
            // In-flight and operator-blocking states: projection emits informational
            // or await_* rows. Never queue effectful deploy/withdraw while in flight.
            if (
                dep.status === 'deploying'
                || dep.status === 'correcting'
                || dep.status === 'withdrawing'
                || dep.status === 'pending_state_review'
                || dep.status === 'evict_blocked'
                || dep.status === 'name_conflict'
            ) {
                continue;
            }
            if (dep.status === 'active' && dep.applied_revision === blueprint.revision) {
                decision.check.push(node);
                continue;
            }
            if (dep.applied_revision !== blueprint.revision) {
                if (blueprint.classification === 'stateful' || blueprint.classification === 'unknown') {
                    decision.stateReview.push(node);
                } else {
                    decision.deploy.push(node);
                }
                continue;
            }
            if (dep.status === 'failed' || dep.status === 'pending') {
                decision.deploy.push(node);
                continue;
            }
        }

        // Active on a node that is no longer desired
        for (const dep of existingDeployments) {
            if (desiredIds.has(dep.node_id)) continue;
            if (dep.status === 'withdrawn') continue;
            // Projection owns informational in-flight rows and clear_stale_guard
            // (never-deployed pending_state_review). Do not queue withdraw/evict.
            if (
                dep.status === 'deploying'
                || dep.status === 'correcting'
                || dep.status === 'withdrawing'
                || dep.status === 'name_conflict'
                || (dep.status === 'pending_state_review' && dep.last_deployed_at == null)
            ) {
                continue;
            }
            const node = allNodes.find(n => n.id === dep.node_id);
            if (!node) continue;
            if (blueprint.classification === 'stateful' || blueprint.classification === 'unknown') {
                if (dep.status !== 'evict_blocked') decision.evictBlocked.push(node);
            } else {
                decision.withdraw.push(node);
            }
        }

        return decision;
    }

    private async handleDrift(blueprint: Blueprint, node: Node, reason: string): Promise<void> {
        const notifications = NotificationService.getInstance();
        switch (blueprint.drift_mode) {
            case 'observe':
                return; // detection only; UI surfaces the drift

            case 'suggest':
                notifications.dispatchAlert(
                    'warning',
                    'blueprint_drift_detected',
                    `Blueprint "${blueprint.name}" drifted ${nodeLocationClause(node)}: ${reason}`,
                    { stackName: blueprint.name, actor: 'system:blueprint' },
                );
                return;

            case 'enforce': {
                // Stateful safeguard: if the upcoming redeploy would destroy named volumes,
                // downgrade to suggest semantics for this drift event.
                if (blueprint.classification === 'stateful') {
                    const marker = await BlueprintService.getInstance().readMarker(blueprint.name, node);
                    if (!marker) {
                        notifications.dispatchAlert(
                            'warning',
                            'blueprint_drift_detected',
                            `Blueprint "${blueprint.name}" lost its marker ${nodeLocationClause(node)}; auto-fix declined to avoid stomping unowned data. Reason: ${reason}`,
                            { stackName: blueprint.name, actor: 'system:blueprint' },
                        );
                        return;
                    }
                }
                commitBlueprintDeploymentCause('drift_enforce_start', blueprint.id, node.id, {
                    status: 'correcting',
                    last_checked_at: Date.now(),
                }, null);
                const result = await BlueprintService.getInstance().deployToNode(blueprint, node);
                if (result.status !== 'active') {
                    notifications.dispatchAlert(
                        'error',
                        'blueprint_drift_correction_failed',
                        `Auto-fix for "${blueprint.name}" ${nodeLocationClause(node)} failed: ${result.error ?? 'unknown error'}`,
                        { stackName: blueprint.name, actor: 'system:blueprint' },
                    );
                }
                return;
            }
        }
    }

    /**
     * Used by an operator-confirmed redeploy of a deployment in a guard
     * state. Re-reads the deployment row and refuses unless it is in a
     * transition-eligible state, so a TOCTOU window between the route
     * handler's check and the actual deploy can't smuggle a name_conflict
     * row through.
     */
    async forceDeploy(blueprintId: number, nodeId: number): Promise<void> {
        const blueprint = DatabaseService.getInstance().getBlueprint(blueprintId);
        if (!blueprint) return;
        const node = DatabaseService.getInstance().getNode(nodeId);
        if (!node) return;
        const dep = DatabaseService.getInstance().getDeployment(blueprintId, nodeId);
        // Allow forceDeploy when:
        //   - dep is missing (operator-driven first deploy outside selector)
        //   - dep.status is pending_state_review (operator accepted)
        //   - dep.status is failed (manual retry)
        // Refuse when dep is name_conflict (must be cleared explicitly) or evict_blocked
        // (operator must use the withdraw flow first).
        if (dep && (dep.status === 'name_conflict' || dep.status === 'evict_blocked')) {
            console.warn(`[BlueprintReconciler] forceDeploy refused for blueprint ${blueprintId} on node ${nodeId}: status=${dep.status}`);
            return;
        }
        await BlueprintService.getInstance().deployToNode(blueprint, node);
    }

    /**
     * Used to react to a compose change that introduces volume-destroying
     * differences. Returns true when the change would destroy data on the
     * given deployment. Reconciler uses this to refuse Enforce on a
     * stateful drift that would wipe volumes.
     */
    static wouldDestroyVolumes(blueprint: Blueprint, priorCompose: string): boolean {
        if (blueprint.classification !== 'stateful') return false;
        return BlueprintAnalyzer.wouldDestroyVolumes(priorCompose, blueprint.compose_content);
    }
}
