import {
    DatabaseService,
    type Blueprint,
    type BlueprintDeployment,
    type Node,
} from './DatabaseService';
import { BlueprintService } from './BlueprintService';
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

const RECONCILER_INTERVAL_MS = 60_000;
const RECONCILER_INITIAL_DELAY_MS = 5_000;

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
     * Does not recompute or widen the action set.
     */
    async reconcileConfirmedPlan(
        blueprintId: number,
        executorActions: ConfirmableActionRef[],
    ): Promise<void> {
        const blueprint = DatabaseService.getInstance().getBlueprint(blueprintId);
        if (!blueprint || !blueprint.enabled) return;
        const parsed = parseApprovedBlastJson(blueprint.approved_blast_json);
        if (!parsed.ok || blueprint.approval_status !== 'approved') {
            diagnosticLog('reconcileConfirmedPlan skipped: approval missing or invalid', { blueprintId });
            return;
        }
        const authorized = filterAuthorizedExecutorActions(parsed.entries, executorActions);
        const nodes = DatabaseService.getInstance().getNodes();
        const byId = new Map(nodes.map(n => [n.id, n]));
        await this.executeAuthorizedActions(blueprint, byId, authorized);
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
        const preview = buildBlueprintPreview(blueprint.id);
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
    ): Promise<void> {
        const svc = BlueprintService.getInstance();
        for (const { nodeId, action } of actions) {
            const node = byId.get(nodeId);
            if (!node) {
                console.warn(
                    `[BlueprintReconciler] confirmed plan skipped missing node ${nodeId} for blueprint ${blueprint.id}`,
                );
                continue;
            }
            await this.executeOneAction(blueprint, node, action, svc);
        }
    }

    private async executeOneAction(
        blueprint: Blueprint,
        node: Node,
        action: PreviewAction,
        svc: BlueprintService,
    ): Promise<void> {
        switch (action) {
            case 'await_state_review': {
                const existing = DatabaseService.getInstance().getDeployment(blueprint.id, node.id);
                DatabaseService.getInstance().upsertDeployment({
                    blueprint_id: blueprint.id,
                    node_id: node.id,
                    status: 'pending_state_review',
                    last_checked_at: Date.now(),
                    drift_summary: existing
                        ? 'Stateful blueprint revision change awaits operator confirmation'
                        : 'Stateful blueprint awaiting operator confirmation before first deploy',
                });
                return;
            }
            case 'await_evict_confirm': {
                DatabaseService.getInstance().upsertDeployment({
                    blueprint_id: blueprint.id,
                    node_id: node.id,
                    status: 'evict_blocked',
                    last_checked_at: Date.now(),
                    drift_summary: 'Stateful blueprint eviction requires operator confirmation',
                });
                return;
            }
            case 'clear_reversed_evict':
                applyClearReversedEvict(blueprint.id, node.id);
                return;
            case 'clear_stale_guard':
                applyClearStaleGuard(blueprint.id, node.id);
                return;
            case 'create':
            case 'update':
                await svc.deployToNode(blueprint, node);
                return;
            case 'remove':
                await svc.withdrawFromNode(blueprint, node);
                return;
            case 'check_observe':
            case 'check_enforce': {
                const driftResult = await svc.checkForDrift(blueprint, node);
                if (!driftResult.drifted) return;
                const reason = driftResult.reason ?? 'unknown drift';
                DatabaseService.getInstance().upsertDeployment({
                    blueprint_id: blueprint.id,
                    node_id: node.id,
                    status: 'drifted',
                    last_checked_at: Date.now(),
                    last_drift_at: Date.now(),
                    drift_summary: reason,
                });
                if (action === 'check_enforce') {
                    await this.handleDrift(blueprint, node, reason);
                } else {
                    // observe/suggest: notify path via handleDrift still respects drift_mode
                    await this.handleDrift(blueprint, node, reason);
                }
                return;
            }
            default:
                return;
        }
    }

    /**
     * Validate Accept/evict-from-guard against current approval and placement.
     * Returns null when OK, or an error code/message.
     */
    validateGuardConfirmation(
        blueprintId: number,
        nodeId: number,
        kind: 'accept' | 'evict',
    ): { ok: true } | { ok: false; code: string; error: string } {
        const db = DatabaseService.getInstance();
        const blueprint = db.getBlueprint(blueprintId);
        if (!blueprint) return { ok: false, code: 'not_found', error: 'Blueprint not found' };
        const node = db.getNode(nodeId);
        if (!node) return { ok: false, code: 'not_found', error: 'Node not found' };
        const dep = db.getDeployment(blueprintId, nodeId);
        if (kind === 'accept') {
            if (!dep || dep.status !== 'pending_state_review') {
                return { ok: false, code: 'STALE_GUARD', error: 'Deployment is not awaiting state review' };
            }
        } else if (!dep || dep.status !== 'evict_blocked') {
            return { ok: false, code: 'STALE_GUARD', error: 'Deployment is not awaiting eviction confirmation' };
        }

        const preview = buildBlueprintPreview(blueprintId);
        if (!preview) return { ok: false, code: 'STALE_GUARD', error: 'Unable to evaluate approval' };
        const parsed = parseApprovedBlastJson(blueprint.approved_blast_json);
        if (
            blueprint.approval_status !== 'approved'
            || !parsed.ok
            || blueprint.approved_intent_fingerprint !== intentFingerprint(blueprint)
        ) {
            return { ok: false, code: 'STALE_GUARD', error: 'Blueprint approval is no longer valid; preview and confirm again' };
        }
        const outcome = parsed.entries.find(e => e.nodeId === nodeId)?.outcome;
        const desired = this.listDesiredNodes(blueprint, db.getNodes()).some(n => n.id === nodeId);
        if (kind === 'accept') {
            if (outcome !== 'place' || !desired) {
                return { ok: false, code: 'STALE_GUARD', error: 'Node is no longer an approved placement target' };
            }
        } else if (outcome !== 'remove' || desired) {
            return { ok: false, code: 'STALE_GUARD', error: 'Node is no longer an approved removal target' };
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
                DatabaseService.getInstance().upsertDeployment({
                    blueprint_id: blueprint.id,
                    node_id: node.id,
                    status: 'correcting',
                    last_checked_at: Date.now(),
                });
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
