import {
    DatabaseService,
    type Blueprint,
    type BlueprintDeployment,
    type Node,
} from './DatabaseService';
import { BlueprintService, type DeployOutcome, type DriftCause, type RepairBlock } from './BlueprintService';
import { BlueprintAnalyzer } from './BlueprintAnalyzer';
import { NodeLabelService } from './NodeLabelService';
import { NotificationService } from './NotificationService';
import { sanitizeForLog } from '../utils/safeLog';
import {
    type ConfirmableActionRef,
    type PreviewAction,
    type ApprovedNodeOutcome,
    filterAuthorizedExecutorActions,
    intentFingerprint,
    outcomeForConfirmableAction,
    parseApprovedBlastJson,
} from './blueprintApproval';
import {
    applyClearReversedEvict,
    applyClearStaleGuard,
    buildBlueprintPreview,
} from './blueprintPreviewProjection';
import { commitBlueprintDeploymentCause } from './gitops/blueprintDeploymentProducers';
import {
    decodeGitOpsApprovedTargetEffectJson,
    decodeGitOpsRequiredTargetsJson,
} from './gitops/json';
import { GitOpsStore, placementEffectCompatible } from './gitops/store';
import { isGitManagedBlueprint } from './gitops/gitManaged';
import { materializeAndFreezeGitManagedArtifactSet } from './gitops/gitManagedMaterialization';
import { buildAcceptedGeneration, holdBlockedRolloutDispatch } from './gitops/handoff';
import { GitSourceService } from './GitSourceService';
import type { GitOpsApplicationRow } from './gitops/types';

const RECONCILER_INTERVAL_MS = 60_000;
const RECONCILER_INITIAL_DELAY_MS = 5_000;

export type ConfirmedActionOutcomeStatus = 'ok' | 'failed' | 'name_conflict' | 'pending' | 'skipped';

export interface ConfirmedActionOutcome {
    nodeId: number;
    nodeName: string;
    action: PreviewAction;
    status: ConfirmedActionOutcomeStatus;
    error?: string | null;
    /** Machine-readable registry delivery refusal code, when the action failed on one. */
    code?: string;
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
    return { ...base, status: 'failed', error: result.error ?? result.status, code: result.code };
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
    /** Nodes whose canonical target is severed; no automatic action may run. */
    severedNodeIds: number[];
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
    /**
     * The last preparation attempt per application, keyed to the generation it
     * was for, so the retry is bounded by the artifact retry interval instead
     * of probing the registry on every tick.
     */
    private readonly gitManagedPreparationAttempts = new Map<string, { generationId: string; at: number }>();
    /**
     * A generation whose preparation was refused by the authored-text parser.
     * The refusal is a statement about the content, so it is remembered per
     * generation and never retried; the reason itself is persisted as an
     * evidence limitation by the freeze.
     */
    private readonly refusedGitManagedPreparations = new Map<string, string>();

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
        if (isGitManagedBlueprint(blueprint)) {
            diagnosticLog('reconcileConfirmedPlan skipped: git-managed content', { blueprintId });
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
        const gitopsGate = this.authorizeAgainstGitOpsPlacement(blueprint, parsed.entries, executorActions);
        if (!gitopsGate.ok) {
            diagnosticLog('reconcileConfirmedPlan skipped: GitOps placement gate refused', { blueprintId });
            return { outcomes: [], refused: true };
        }
        const authorized = gitopsGate.authorized;
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
            // The content pass runs for every live Git-managed application,
            // enabled or not: preparation belongs to the accepted generation,
            // and a disabled Blueprint still has one waiting to be resolved.
            for (const app of GitOpsStore.getInstance().listLiveGitManagedApplications()) {
                try {
                    await this.retryGitManagedPreparation(app);
                } catch (err) {
                    console.error(`[BlueprintReconciler] Git-managed preparation retry failed for ${app.id}:`, err);
                }
            }
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
        if (isGitManagedBlueprint(blueprint)) {
            // Skip place/withdraw/content apply; still observe runtime identity
            // and run Observe/Suggest/Enforce against the authorized generation.
            // The content retry runs once per tick for every live Git-managed
            // application, ahead of this loop.
            await this.reconcileGitManagedDriftObservation(blueprint, allNodes);
            return;
        }
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

        const gitopsGate = this.authorizeAgainstGitOpsPlacement(blueprint, parsed.entries, preview.executorActions);
        if (!gitopsGate.ok) {
            // Clear so the tick does not keep retrying a refused live placement.
            diagnosticLog('reconcile skipped: GitOps placement gate refused; clearing stale approval', {
                blueprintId: blueprint.id,
            });
            DatabaseService.getInstance().clearBlueprintApproval(blueprint.id);
            return;
        }
        const authorized = gitopsGate.authorized;
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

    /**
     * Retry an accepted generation whose preparation did not finish.
     *
     * The accept paths prepare once and then either dispatch or report a note.
     * A registry outage, or a crash between the acceptance commit and the
     * materialize call, would otherwise strand that generation: re-accepting is
     * refused (it is already accepted), and the per-target artifact retry only
     * looks at the generation a target has acknowledged, which is still the
     * previous one until a new rollout reaches it. This tick is the
     * application-driven retry that closes that hole.
     *
     * A refusal (a compose shape the authored-text parser cannot model) is
     * remembered per generation: it is a statement about the content and no
     * number of retries changes it. The reason is persisted as an evidence
     * limitation by the freeze, so the surface names the cause.
     */
    private async retryGitManagedPreparation(app: GitOpsApplicationRow): Promise<void> {
        const store = GitOpsStore.getInstance();
        if (app.target_mode !== 'blueprint' || !app.accepted_generation_id) return;
        // Suspension freezes automation for this source, exactly as it does for
        // the SourceController's own acceptance and for GitSourceService.retry.
        // Preparing and dispatching around it would bypass that hold.
        if (app.suspended_at) return;
        const generationId = app.accepted_generation_id;
        if (this.refusedGitManagedPreparations.get(app.id) === generationId) return;
        const artifact = app.artifact_set_id ? store.getArtifactSet(app.artifact_set_id) : undefined;
        if (artifact && (artifact.qualification === 'exact' || artifact.qualification === 'qualified')) return;

        const intervalMs = DatabaseService.getInstance().getGitOpsArtifactRetryIntervalMins() * 60_000;
        const last = this.gitManagedPreparationAttempts.get(app.id);
        if (last && last.generationId === generationId && Date.now() - last.at < intervalMs) return;
        this.gitManagedPreparationAttempts.set(app.id, { generationId, at: Date.now() });

        const outcome = await materializeAndFreezeGitManagedArtifactSet({
            applicationId: app.id,
            generationId,
            actor: 'system:blueprint-reconciler',
            trigger: 'git_managed_preparation_retried',
        });
        if (outcome.status === 'refused') {
            this.refusedGitManagedPreparations.set(app.id, generationId);
            return;
        }
        if (outcome.status !== 'resolved') return;

        // Prepared now. Under the automatic policy, complete the handoff the
        // acceptance attempt could not: mint the authorization and dispatch. A
        // pause or suspension is an execution hold and still wins; a manual
        // policy leaves the authorization to the operator. The application is
        // re-read after the freeze's await: a newer acceptance landing in that
        // window supersedes this generation, and dispatching it would hold the
        // healthy successor behind a stale reason.
        const fresh = store.getApplication(app.id);
        if (!fresh || fresh.suspended_at || fresh.pause_at) return;
        if (fresh.accepted_generation_id !== generationId) return;
        if (fresh.rollout_authorization_policy !== 'automatic') return;
        // Preparation runs for a disabled Blueprint (content is not execution),
        // but its execution authority is withheld until it is enabled again,
        // the same rule the authorize route enforces.
        const blueprintRow = fresh.blueprint_id !== null
            ? DatabaseService.getInstance().getBlueprint(fresh.blueprint_id)
            : undefined;
        if (!blueprintRow?.enabled) return;
        const genRow = store.getGeneration(generationId);
        if (!genRow) return;
        try {
            const dispatch = await GitSourceService.getInstance().dispatchAcceptedGeneration(
                buildAcceptedGeneration(genRow),
                GitSourceService.dispatchContextFor(fresh),
                { trigger: 'retry', actor: 'system:blueprint-reconciler' },
            );
            if (dispatch.status === 'blocked') {
                console.warn(
                    '[BlueprintReconciler] Git-managed dispatch blocked for %s: %s',
                    sanitizeForLog(app.id),
                    sanitizeForLog(dispatch.reason),
                );
                holdBlockedRolloutDispatch(app.id, dispatch);
            }
        } catch (err) {
            console.error(
                '[BlueprintReconciler] Git-managed dispatch failed for %s:',
                sanitizeForLog(app.id),
                err instanceof Error ? err.message : String(err),
            );
        }
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
                if (driftResult.kind === 'matched') {
                    this.clearSettledDriftState(blueprint.id, node.id);
                    return { ...base, status: 'ok' };
                }
                if (driftResult.kind === 'unverified') {
                    // Nothing drifted that Sencho can name. A blocked repair still
                    // belongs on the row, because it is a decision an operator has
                    // to make, but it is not drift.
                    diagnosticLog('drift unverified', {
                        blueprintId: blueprint.id,
                        nodeId: node.id,
                        reason: driftResult.reason ?? 'unverified',
                    });
                    if (driftResult.repairBlock && blueprint.drift_mode === 'enforce') {
                        this.recordRepairHold(blueprint, node, driftResult.repairBlock);
                    }
                    return { ...base, status: 'ok' };
                }
                // One write per tick, and which one depends on whether a repair
                // would have been attempted. Writing the drift and then the hold
                // would flip the row between the two states every tick, so
                // neither write would ever be suppressed and every tick would
                // append history and fire an alert.
                if (blueprint.drift_mode === 'enforce') {
                    const block = await this.effectiveRepairBlock(blueprint, node, driftResult.repairBlock);
                    if (block) {
                        this.recordRepairHold(blueprint, node, block);
                        return { ...base, status: 'ok' };
                    }
                }
                const reason = driftResult.reason;
                // The drift episode began when the row first read drifted, so a
                // tick that re-observes the same drift must not restamp it.
                // Restamping made a drift that outlived one tick report itself
                // as just found, forever, which is the one thing the drift age
                // on the row exists to say.
                const alreadyDrifted =
                    DatabaseService.getInstance().getDeployment(blueprint.id, node.id)?.status === 'drifted';
                commitBlueprintDeploymentCause('drift_observed', blueprint.id, node.id, {
                    status: 'drifted',
                    last_checked_at: Date.now(),
                    ...(alreadyDrifted ? {} : { last_drift_at: Date.now() }),
                    drift_summary: reason,
                }, null);
                // A block about auto-repair means nothing to Observe or Suggest,
                // so the drift is recorded and the mode's own response runs. A
                // stateful or unclassifiable workload is never auto-repaired,
                // and that is decided at the mutation site, inside handleDrift.
                await this.handleDrift(blueprint, node, reason, driftResult.cause);
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
        const gitopsGate = this.authorizeAgainstGitOpsPlacement(blueprint, parsed.entries, [
            { nodeId, action: outcomeNeeded === 'place' ? 'create' : 'remove' },
        ]);
        if (!gitopsGate.ok || gitopsGate.authorized.length === 0) {
            return { ok: false, code: 'STALE_GUARD', error: 'Blueprint placement approval no longer authorizes this node' };
        }
        return { ok: true };
    }

    /**
     * After legacy blueprints.approval_* passes, also require a live GitOps
     * placement_approval when one exists.
     *
     * Dual-write period: a live app with no placement_approval_ref still
     * executes under legacy columns alone. Once placement is set, resolve must
     * succeed and the frozen required set must not be widened by the current
     * blast; otherwise refuse closed.
     */
    private authorizeAgainstGitOpsPlacement(
        blueprint: Blueprint,
        blastEntries: ApprovedNodeOutcome[],
        executorActions: ConfirmableActionRef[],
    ): { ok: true; authorized: ConfirmableActionRef[] } | { ok: false } {
        const store = GitOpsStore.getInstance();
        const app = store.getLiveBlueprintApplication(blueprint.id);
        if (!app || !app.placement_approval_ref) {
            return {
                ok: true,
                authorized: filterAuthorizedExecutorActions(blastEntries, executorActions),
            };
        }
        if (!app.intent_revision_id) return { ok: false };

        const frozenRequired = this.frozenRequiredNodeIds(app);
        if (!frozenRequired) return { ok: false };

        const placement = store.resolveApprovalRef(app.placement_approval_ref, {
            kind: 'placement_approval',
            applicationId: app.id,
            intentRevisionId: app.intent_revision_id,
            requiredNodeIds: frozenRequired,
        });
        if (!placement?.blast_json) return { ok: false };

        // Refuse when the legacy blast would place outside the frozen set
        // (widen) or remove a still-required node.
        if (!placementEffectCompatible(blastEntries, frozenRequired)) {
            return { ok: false };
        }

        let placementEffect: ApprovedNodeOutcome[];
        try {
            placementEffect = decodeGitOpsApprovedTargetEffectJson(placement.blast_json);
        } catch (error) {
            console.error(
                `[BlueprintReconciler] placement blast decode failed for ${placement.id}:`,
                error instanceof Error ? error.message : String(error),
            );
            return { ok: false };
        }

        const required = new Set(frozenRequired);
        const effectByNode = new Map(placementEffect.map((e) => [e.nodeId, e.outcome]));
        const authorized = filterAuthorizedExecutorActions(blastEntries, executorActions)
            .filter((ref) => this.actionInsideFrozenAuthorization(ref, required, effectByNode));
        return { ok: true, authorized };
    }

    private frozenRequiredNodeIds(app: GitOpsApplicationRow): number[] | null {
        const store = GitOpsStore.getInstance();
        let requiredTargetsJson: string | null = null;
        let sourceLabel: string | null = null;

        if (app.rollout_generation_id) {
            const generation = store.getRolloutGeneration(app.rollout_generation_id);
            if (!generation || generation.application_id !== app.id) return null;
            requiredTargetsJson = generation.required_targets_json;
            sourceLabel = `rollout generation ${app.rollout_generation_id}`;
        } else if (app.placement_approval_ref) {
            const approval = store.getApproval(app.placement_approval_ref);
            if (!approval?.required_targets_json) return null;
            requiredTargetsJson = approval.required_targets_json;
            sourceLabel = `placement approval ${app.placement_approval_ref}`;
        } else {
            return null;
        }

        try {
            return decodeGitOpsRequiredTargetsJson(requiredTargetsJson).nodeIds;
        } catch (error) {
            console.error(
                `[BlueprintReconciler] ${sourceLabel} required_targets decode failed:`,
                error instanceof Error ? error.message : String(error),
            );
            return null;
        }
    }

    /**
     * An executor action must stay inside the frozen place set and the
     * placement blast: place only on required nodes, remove only when the
     * blast explicitly removes that node.
     */
    private actionInsideFrozenAuthorization(
        ref: ConfirmableActionRef,
        required: ReadonlySet<number>,
        effectByNode: ReadonlyMap<number, 'place' | 'remove'>,
    ): boolean {
        const needed = outcomeForConfirmableAction(ref.action);
        if (!needed) return false;
        if (needed === 'place') {
            return required.has(ref.nodeId)
                && (effectByNode.get(ref.nodeId) === 'place' || !effectByNode.has(ref.nodeId));
        }
        if (required.has(ref.nodeId)) return false;
        return effectByNode.get(ref.nodeId) === 'remove';
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

        // A tombstoned target is a placement the model has severed (withdraw,
        // node delete). Redeploying onto one would run the workload while the
        // projection insists the target is gone, so automatic placement skips
        // it. Only an explicit deploy re-opens the placement, and that revival
        // is recorded by the transition itself.
        const gitopsApp = GitOpsStore.getInstance().getLiveBlueprintApplication(blueprint.id);
        const severedNodes = new Set<number>(
            gitopsApp
                ? GitOpsStore.getInstance().listTargets(gitopsApp.id)
                    .filter((t) => t.target_status === 'tombstoned')
                    .map((t) => t.node_id)
                : [],
        );

        const decision: ReconcileDecision = {
            deploy: [],
            withdraw: [],
            check: [],
            stateReview: [],
            evictBlocked: [],
            severedNodeIds: [...severedNodes],
        };

        // Desired but not active or stale
        for (const node of desiredNodes) {
            const dep = deploymentByNode.get(node.id);
            if (!dep) {
                if (severedNodes.has(node.id)) continue;
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
            // A drifted row at the current revision belongs to the drift check,
            // for the same reason an active one does: the drift is still there
            // until a check says otherwise, and under Enforce the check is what
            // repairs it. The projection also reaches such a row through its own
            // status fallback, so this changes nothing an operator sees; it is
            // here so the decision a tick acts on is not two files away in the
            // preview projection, which is no place to keep a recovery path.
            if (dep.status === 'drifted' && dep.applied_revision === blueprint.revision) {
                decision.check.push(node);
                continue;
            }
            // A held target keeps its check. The hold is a state, not a latch:
            // the cause can clear (a node returns, a rollout lands, a rollback
            // finishes), and this is the only thing that notices. Without it a
            // held row matches no branch here and is never re-examined, so a
            // transient cause would strand the target permanently.
            if (dep.status === 'repair_held' && dep.applied_revision === blueprint.revision) {
                decision.check.push(node);
                continue;
            }
            if (dep.applied_revision !== blueprint.revision) {
                if (severedNodes.has(node.id)) continue;
                if (blueprint.classification === 'stateful' || blueprint.classification === 'unknown') {
                    decision.stateReview.push(node);
                } else {
                    decision.deploy.push(node);
                }
                continue;
            }
            if (dep.status === 'failed' || dep.status === 'pending') {
                if (severedNodes.has(node.id)) continue;
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

    private async handleDrift(
        blueprint: Blueprint,
        node: Node,
        reason: string,
        cause: DriftCause,
    ): Promise<void> {
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
                // The classification guard is repeated here, at the site that
                // mutates, rather than trusted from the caller. Deciding it early
                // keeps a held target from being written as drifted first; the
                // decision itself belongs to whoever is about to write to a node.
                const heldByClassification = await this.repairHeldByClassification(blueprint, node);
                if (heldByClassification) {
                    this.recordRepairHold(blueprint, node, {
                        reason: 'classification_forbids_repair',
                        detail: heldByClassification,
                    });
                    return;
                }
                // Read before the attempt, because the answer to "is this failure
                // new" cannot come from the row afterwards: a repair that reaches
                // a deploy writes its own status and its own `last_error`, and it
                // writes the very string it returns, so the row it leaves behind
                // already looks like a failure someone has reported.
                const before = DatabaseService.getInstance().getDeployment(blueprint.id, node.id);
                commitBlueprintDeploymentCause('drift_enforce_start', blueprint.id, node.id, {
                    status: 'correcting',
                    last_checked_at: Date.now(),
                }, null);
                let result: DeployOutcome;
                try {
                    result = await this.runDriftRepair(blueprint, node, cause);
                } catch (err) {
                    // A repair that throws has not written anything either, and
                    // the row is already reading `correcting`, so it is settled
                    // exactly like a refusal. Without this the throw escapes to
                    // the per-blueprint catch and strands the row, which is the
                    // same ambiguity a refusal used to leave.
                    //
                    // The throw is logged rather than only alerted, because this
                    // boundary cannot tell an operational failure from a bug in
                    // the repair itself, and both look identical here. Letting a
                    // bug through as an alert alone would repeat it every tick
                    // with a cryptic message and never reach a developer, while
                    // re-throwing would strand the row again. Logging covers the
                    // developer and the alert covers the operator.
                    console.error(
                        `[BlueprintReconciler] drift repair threw for blueprint ${blueprint.id} on node ${node.id}:`,
                        err instanceof Error ? err.stack ?? err.message : String(err),
                    );
                    result = { status: 'failed', error: BlueprintService.formatError(err) };
                }
                // A hold is a decision, not a failed attempt. The repair
                // re-resolved its authority and found it unprovable, so this
                // tick records the hold and leaves no `correcting` row behind.
                // Reporting it as a failure would page the operator about a
                // choice Sencho made on purpose.
                if (result.status === 'repair_held') {
                    this.recordRepairHold(
                        blueprint,
                        node,
                        {
                            reason: result.holdReason ?? 'evidence_incomplete',
                            detail: result.error ?? 'the repair authority could not be resolved',
                        },
                    );
                    return;
                }
                if (result.status !== 'active') {
                    // Losing a race for the deploy lock is not a failure and
                    // carries no message of its own. The row still has to leave
                    // `correcting` so the next tick picks it up, but there is
                    // nothing to page about.
                    const deferred = result.status === 'pending';
                    // A refusal that wrote no status of its own is settled here,
                    // so the row never keeps reading `correcting` and the next
                    // tick gets to try again. The settle decides whether this is
                    // news, because that question can only be answered against
                    // the row and the snapshot together.
                    const report = this.settleRefusedDriftRepair(
                        blueprint,
                        node,
                        result,
                        before,
                        deferred,
                    );
                    if (report) {
                        notifications.dispatchAlert(
                            'error',
                            'blueprint_drift_correction_failed',
                            `Auto-fix for "${blueprint.name}" ${nodeLocationClause(node)} failed: ${report}`,
                            { stackName: blueprint.name, actor: 'system:blueprint' },
                        );
                    }
                }
                return;
            }
        }
    }

    /**
     * Run the repair a drift calls for.
     *
     * Three methods, one per cause, because a frozen image identity must be
     * restored through the approved digest rather than by tag, and a Git-managed
     * target has no authored compose to deploy at all. A throw is left to the
     * caller, which settles the row: every one of these can reject before it
     * writes anything.
     */
    private runDriftRepair(blueprint: Blueprint, node: Node, cause: DriftCause): Promise<DeployOutcome> {
        if (cause === 'digest') {
            return BlueprintService.getInstance().enforceDigestRepair(blueprint, node);
        }
        if (isGitManagedBlueprint(blueprint)) {
            return BlueprintService.getInstance().reapplyAuthorizedMaterialization(blueprint, node);
        }
        return BlueprintService.getInstance().deployToNode(blueprint, node);
    }

    /**
     * Settle a drift repair that refused, and report whether the operator needs
     * telling about it.
     *
     * `drift_enforce_start` writes `correcting` before the repair runs, so any
     * repair path that answers without reaching a deploy leaves the row there.
     * A `correcting` row is skipped by the decision buckets and projected as
     * informational, so nothing would re-examine it: the drift would sit
     * unrepaired, with the wrong image still running, behind a single alert.
     * A repair that reaches a deploy writes its own terminal status, and a hold
     * writes its own row, so the row is only rewritten when the refusal wrote
     * nothing at all.
     *
     * Such a row returns to `drifted` because the drift is still real and still
     * owed a repair, and `drifted` is re-checked on every following tick.
     * Writing `failed` or `pending` instead would be a worse answer: both are
     * retry buckets for an ordinary deploy, so the next tick would repair by tag
     * and adopt whatever the tag points at now, which is exactly what a
     * digest-pinned repair exists to prevent.
     *
     * The alert is for a failure that is **new**, judged against the row as it
     * stood before this tick's attempt. That snapshot is the only honest basis
     * for it: a repair that reaches a deploy writes its own status and its own
     * `last_error`, and it writes the very string it returns, so the row it
     * leaves behind already looks like a failure someone reported. Comparing
     * against the row afterwards would silence the first real failure of every
     * kind, and comparing `last_error` alone would go on silencing a failure
     * that recurs after the drift converged in between.
     *
     * The key is a message rather than a code because every refusal that reaches
     * here answers with a constant string: the preconditions in the digest repair
     * and the authorized reapply, a lock the deploy could not take, or the thrown
     * error of a repair that failed outright. A code column is the thing to add
     * if a refusal ever starts composing its own text.
     *
     * Every tick of a persistent refusal records a `blueprint_correcting` and a
     * `blueprint_drifted` observation, so the history grows by two rows a minute
     * while it persists. That is left in place deliberately: the row really does
     * move between the two states on every attempt, and the projection reads the
     * latest stage, so suppressing either write would leave the history claiming
     * a state the row is not in. A hold, which does not move, suppresses instead.
     *
     * Returns the message to report, or null when the operator has already been
     * told this one.
     */
    private settleRefusedDriftRepair(
        blueprint: Blueprint,
        node: Node,
        outcome: DeployOutcome,
        before: BlueprintDeployment | undefined,
        deferred: boolean,
    ): string | null {
        const row = DatabaseService.getInstance().getDeployment(blueprint.id, node.id);
        // A repair that reached a deploy wrote its own terminal status, and a
        // hold wrote its own row. Only the refusals that wrote nothing are
        // settled here.
        const stranded = row?.status === 'correcting';
        // When the repair reached a deploy, the row it left behind spells this
        // failure out and the outcome may only carry a shorthand: the
        // name-conflict paths return the bare word `name_conflict` and then park
        // the row for good, so that one alert is the only signal the operator
        // gets and it has to name the directory in the way. When the row is
        // still `correcting` nothing was written, so the row's `last_error` is
        // the *previous* failure and the outcome is the only honest source.
        const message = stranded
            ? outcome.error ?? 'unknown error'
            : row?.last_error ?? outcome.error ?? 'unknown error';
        if (stranded) {
            // Neither `last_drift_at` nor `last_error` is restamped by a
            // deferral. The timestamp answers when this drift episode began, and
            // the error is the replay key: writing a note about a lost lock race
            // over the failure being replayed would make the very next tick
            // report that same failure again as though it were new. What the row
            // already says is worth more to an operator than a note about a race
            // that is over.
            commitBlueprintDeploymentCause('drift_observed', blueprint.id, node.id, {
                status: 'drifted',
                last_checked_at: Date.now(),
                ...(deferred ? {} : { last_error: message }),
            }, null);
        }
        const nowStatus = stranded ? 'drifted' : row?.status;
        const nowError = stranded && !deferred ? message : row?.last_error;
        if (deferred) return null;
        // A row that converged while the repair was in flight has no drift left
        // for this failure to be about, so reporting it would page the operator
        // over a target that is already healthy.
        if (nowStatus === 'active') return null;
        const isNew = nowStatus !== before?.status || nowError !== before?.last_error;
        return isNew ? message : null;
    }

    /**
     * Git-managed Blueprints skip place/withdraw/content apply on the tick, but
     * still re-observe runtime identity against the already-authorized generation
     * and apply Observe/Suggest/Enforce from `drift_mode`.
     */
    private async reconcileGitManagedDriftObservation(
        blueprint: Blueprint,
        allNodes: Node[],
    ): Promise<void> {
        const deployments = DatabaseService.getInstance().listDeployments(blueprint.id);
        if (deployments.length === 0) {
            diagnosticLog('git-managed drift skipped: no deployments', { blueprintId: blueprint.id });
            return;
        }
        const byId = new Map(allNodes.map((n) => [n.id, n]));
        const svc = BlueprintService.getInstance();
        for (const dep of deployments) {
            // A held target keeps being checked: the hold is a state the rollout
            // or an operator can clear, so a tick has to keep looking for the
            // authority that would release it.
            if (
                dep.status !== 'active'
                && dep.status !== 'drifted'
                && dep.status !== 'correcting'
                && dep.status !== 'repair_held'
            ) {
                continue;
            }
            const node = byId.get(dep.node_id);
            if (!node) continue;
            const driftResult = await svc.checkForDrift(blueprint, node);
            if (driftResult.kind === 'matched') {
                this.clearSettledDriftState(blueprint.id, node.id);
                continue;
            }
            if (driftResult.kind === 'unverified') {
                diagnosticLog('git-managed drift unverified', {
                    blueprintId: blueprint.id,
                    nodeId: node.id,
                    reason: driftResult.reason ?? 'unverified',
                });
                if (driftResult.repairBlock && blueprint.drift_mode === 'enforce') {
                    this.recordRepairHold(blueprint, node, driftResult.repairBlock);
                }
                continue;
            }
            // One write per tick; see the Inline path for why the hold replaces
            // the drift write rather than following it.
            if (blueprint.drift_mode === 'enforce') {
                const block = await this.effectiveRepairBlock(blueprint, node, driftResult.repairBlock);
                if (block) {
                    this.recordRepairHold(blueprint, node, block);
                    continue;
                }
            }
            const reason = driftResult.reason;
            const alreadyDrifted =
                DatabaseService.getInstance().getDeployment(blueprint.id, node.id)?.status === 'drifted';
            commitBlueprintDeploymentCause('drift_observed', blueprint.id, node.id, {
                status: 'drifted',
                last_checked_at: Date.now(),
                ...(alreadyDrifted ? {} : { last_drift_at: Date.now() }),
                drift_summary: reason,
            }, null);
            await this.handleDrift(blueprint, node, reason, driftResult.cause);
        }
    }

    /**
     * Why Enforce may not act on this drift, if it may not.
     *
     * Two independent sources: the evidence the drift check carried, and the
     * Blueprint's classification. Both are resolved before the row is written so
     * a held target takes exactly one write per tick. A classification hold
     * belongs only in Enforce, because "auto-fix was declined" is not an answer
     * for an operator who chose Observe or Suggest and never asked for one.
     */
    private async effectiveRepairBlock(
        blueprint: Blueprint,
        node: Node,
        evidenceBlock: RepairBlock | undefined,
    ): Promise<RepairBlock | undefined> {
        if (evidenceBlock) return evidenceBlock;
        const heldByClassification = await this.repairHeldByClassification(blueprint, node);
        return heldByClassification
            ? { reason: 'classification_forbids_repair', detail: heldByClassification }
            : undefined;
    }

    /**
     * Whether this Blueprint's classification forbids an automatic repair, and
     * the operator-facing reason when it does.
     *
     * Restoring the approved generation on a stateless stack converges. Doing it
     * on a stateful one can destroy or strand named volumes, and a Blueprint
     * Sencho cannot classify is in the same position because its volumes are
     * unknown. Both are held so a human or a rollout decides, rather than
     * downgraded to a notification that leaves the drift in place.
     *
     * The text is deliberately free of the drift reason. It is the replay key:
     * a reason that changes every tick (a container exit message, say) would make
     * every tick look like a new decision and append a history row and an alert
     * per tick for a hold that never changes. The drift is not on the row in
     * Enforce, because a held target takes one write per tick and that write is
     * the hold; the Drift panel reads the same evidence from the projection.
     *
     * Returns null for a Blueprint that may be repaired, so the caller reads as a
     * question rather than a flag.
     */
    private async repairHeldByClassification(
        blueprint: Blueprint,
        node: Node,
    ): Promise<string | null> {
        if (blueprint.classification !== 'stateful' && blueprint.classification !== 'unknown') {
            return null;
        }
        const markerRead = await BlueprintService.getInstance().readMarker(blueprint.name, node);
        // Only a marker that is provably gone is one this Blueprint lost. A read
        // that failed leaves it unknown, and the classification still holds the
        // repair either way, so the text stays the one that asserts nothing about
        // the marker.
        return markerRead.kind === 'missing'
            ? `this Blueprint lost its marker and is ${blueprint.classification}, so auto-fix was declined to avoid stomping unowned data`
            : `this Blueprint is ${blueprint.classification}, so auto-fix is declined to avoid touching data Sencho cannot prove is safe`;
    }

    /**
     * Return a row that no longer has drift to `active`.
     *
     * Without this a target that was drifted, or whose repair was held, keeps
     * reading that way forever once the cause clears: nothing else writes an
     * `active` row on a check. Only the two states a check can resolve are
     * touched, so an in-flight or operator-owned row is never stomped.
     */
    private clearSettledDriftState(blueprintId: number, nodeId: number): void {
        const previous = DatabaseService.getInstance().getDeployment(blueprintId, nodeId);
        if (previous?.status !== 'drifted' && previous?.status !== 'repair_held') return;
        commitBlueprintDeploymentCause('drift_cleared', blueprintId, nodeId, {
            status: 'active',
            last_checked_at: Date.now(),
            last_drift_at: null,
            drift_summary: null,
            // Cleared with the drift, like the deploy acknowledgement clears it.
            // Left behind, it would keep naming a failure that has since been
            // repaired, and a failure that recurs after this would be read as one
            // already reported.
            last_error: null,
        }, null);
    }

    /**
     * Record that a drift repair was declined, and say why.
     *
     * A hold is a decision, not a failed attempt, so it gets its own
     * deployment status, its own drift summary, and its own history stage. It
     * never mutates the workload, and it never reports itself as converged: a
     * target that cannot be repaired is still drifted and still needs an
     * operator or a rollout to resolve it.
     */
    private recordRepairHold(
        blueprint: Blueprint,
        node: Node,
        block: RepairBlock,
    ): void {
        const previous = DatabaseService.getInstance().getDeployment(blueprint.id, node.id);
        // Re-asserting the same hold on every tick is not news. Recording it once
        // per transition keeps the history readable, and it is also what keeps the
        // hold in the projection: the runtime observation stamps a stage on every
        // check, so skipping this write would let the hold's stage be overwritten
        // and the hold disappear from every drift surface on the next tick.
        if (previous?.status === 'repair_held' && previous.drift_summary === block.detail) {
            return;
        }
        commitBlueprintDeploymentCause('drift_repair_held', blueprint.id, node.id, {
            status: 'repair_held',
            last_checked_at: Date.now(),
            drift_summary: block.detail,
        }, null);
        diagnosticLog('drift repair held', {
            blueprintId: blueprint.id,
            nodeId: node.id,
            reason: block.reason,
        });
        NotificationService.getInstance().dispatchAlert(
            'warning',
            'blueprint_drift_repair_held',
            `Auto-fix for "${blueprint.name}" ${nodeLocationClause(node)} was declined: ${block.detail}`,
            { stackName: blueprint.name, actor: 'system:blueprint' },
        );
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
        if (isGitManagedBlueprint(blueprint)) {
            console.warn(`[BlueprintReconciler] forceDeploy refused for git-managed blueprint ${blueprintId}`);
            return;
        }
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
