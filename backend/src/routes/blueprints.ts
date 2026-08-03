import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireBody } from '../middleware/tierGates';
import { requirePermission } from '../middleware/permissions';
import {
    DatabaseService,
    type BlueprintSelector,
    type DriftMode,
} from '../services/DatabaseService';
import { BlueprintService, BlueprintNameConflictError, BlueprintOwnershipProbeError } from '../services/BlueprintService';
import { DeployedStackDeletionService } from '../services/DeployedStackDeletionService';
import { refuseIfSelfStack } from '../helpers/selfStackGuard';
import {
    BlueprintReconciler,
    messageForConfirmedOutcomes,
    messageForSnapshotFinishedWithStaleApproval,
    summarizeConfirmedOutcomes,
} from '../services/BlueprintReconciler';
import { BlueprintAnalyzer } from '../services/BlueprintAnalyzer';
import { buildBlueprintPreview, evaluateLightweightEffectiveApproval } from '../services/blueprintPreviewProjection';
import {
    confirmableActionsEqual,
    deriveBlastFromConfirmableActions,
    evaluateEffectiveApproval,
    intentFingerprint,
    parseConfirmableActionsBody,
    serializeApprovedBlast,
} from '../services/blueprintApproval';
import { isValidStackName } from '../utils/validation';
import { parseIntParam } from '../utils/parseIntParam';
import { isDebugEnabled } from '../utils/debug';
import { sanitizeForLog } from '../utils/safeLog';
import { isSqliteUniqueViolation, getErrorMessage } from '../utils/errors';

export const blueprintsRouter = Router();

blueprintsRouter.use(authMiddleware);

const VALID_DRIFT_MODES: readonly DriftMode[] = ['observe', 'suggest', 'enforce'];
const MAX_SELECTOR_ENTRIES = 200;
const MAX_DESCRIPTION_LENGTH = 2048;
export const MAX_BLUEPRINT_COMPOSE_BYTES = 96 * 1024;
const BLUEPRINT_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

interface BlueprintBody {
    name?: unknown;
    description?: unknown;
    compose_content?: unknown;
    selector?: unknown;
    drift_mode?: unknown;
    enabled?: unknown;
}

function parseSelector(raw: unknown): { ok: true; selector: BlueprintSelector } | { ok: false; error: string } {
    if (!raw || typeof raw !== 'object') return { ok: false, error: 'selector is required' };
    const obj = raw as Record<string, unknown>;
    if (obj.type === 'nodes') {
        if (!Array.isArray(obj.ids)) return { ok: false, error: 'selector.ids must be an array' };
        if (obj.ids.length > MAX_SELECTOR_ENTRIES) return { ok: false, error: `selector.ids may not exceed ${MAX_SELECTOR_ENTRIES} entries` };
        const seen = new Set<number>();
        for (const v of obj.ids) {
            if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) return { ok: false, error: 'selector.ids must contain positive integers' };
            seen.add(v);
        }
        return { ok: true, selector: { type: 'nodes', ids: Array.from(seen) } };
    }
    if (obj.type === 'labels') {
        const anyRaw = Array.isArray(obj.any) ? obj.any : [];
        const allRaw = Array.isArray(obj.all) ? obj.all : [];
        if (anyRaw.length > MAX_SELECTOR_ENTRIES || allRaw.length > MAX_SELECTOR_ENTRIES) {
            return { ok: false, error: `selector.any and selector.all may not exceed ${MAX_SELECTOR_ENTRIES} entries each` };
        }
        for (const v of [...anyRaw, ...allRaw]) {
            if (typeof v !== 'string') return { ok: false, error: 'selector labels must be strings' };
        }
        const any = Array.from(new Set(anyRaw as string[]));
        const all = Array.from(new Set(allRaw as string[]));
        return { ok: true, selector: { type: 'labels', any, all } };
    }
    return { ok: false, error: 'selector.type must be "labels" or "nodes"' };
}

function validateName(name: unknown): string | null {
    if (typeof name !== 'string') return 'name must be a string';
    const trimmed = name.trim();
    if (trimmed.length === 0) return 'name is required';
    if (trimmed.length > 64) return 'name must be 64 characters or fewer';
    if (!isValidStackName(trimmed)) return 'name must be alphanumeric, hyphens, or underscores only';
    // Compose normalizes project names to lowercase; require it up-front so container labels match.
    if (!BLUEPRINT_NAME_PATTERN.test(trimmed)) return 'name must be lowercase letters, digits, hyphens, and underscores (must start with a letter or digit)';
    return null;
}

function validateDescription(description: unknown): string | null {
    if (description == null) return null;
    if (typeof description !== 'string') return 'description must be a string';
    if (description.length > MAX_DESCRIPTION_LENGTH) return `description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`;
    return null;
}

function validateDriftMode(mode: unknown): string | null {
    if (typeof mode !== 'string') return 'drift_mode must be a string';
    if (!VALID_DRIFT_MODES.includes(mode as DriftMode)) return `drift_mode must be one of: ${VALID_DRIFT_MODES.join(', ')}`;
    return null;
}

function validateComposeContent(composeContent: unknown): string | null {
    if (typeof composeContent !== 'string' || composeContent.trim().length === 0) {
        return 'compose_content must be a non-empty string';
    }
    if (Buffer.byteLength(composeContent, 'utf8') > MAX_BLUEPRINT_COMPOSE_BYTES) {
        return `compose_content must be ${MAX_BLUEPRINT_COMPOSE_BYTES} bytes or fewer`;
    }
    const analysis = BlueprintAnalyzer.analyze(composeContent);
    if (analysis.parseError) return `compose_content must be valid YAML: ${analysis.parseError}`;
    return null;
}

function summarizeBlueprint(blueprintId: number) {
    const db = DatabaseService.getInstance();
    const blueprint = db.getBlueprint(blueprintId);
    if (!blueprint) return null;
    const deployments = db.listDeployments(blueprintId);
    const counts: Record<string, number> = {};
    for (const dep of deployments) {
        counts[dep.status] = (counts[dep.status] ?? 0) + 1;
    }
    const auth = evaluateLightweightEffectiveApproval(blueprintId);
    return {
        blueprint,
        deployments,
        statusCounts: counts,
        effectiveApproval: auth?.effectiveApproval ?? 'pending',
        unauthorizedActions: auth?.unauthorizedActions ?? [],
    };
}

blueprintsRouter.get('/', (req: Request, res: Response): void => {
    if (!requirePermission(req, res, 'node:read')) return;
    try {
        const blueprints = DatabaseService.getInstance().listBlueprints();
        const summaries = blueprints.map(b => {
            const deployments = DatabaseService.getInstance().listDeployments(b.id);
            const counts: Record<string, number> = {};
            for (const dep of deployments) counts[dep.status] = (counts[dep.status] ?? 0) + 1;
            const auth = evaluateLightweightEffectiveApproval(b.id);
            return {
                ...b,
                deploymentCounts: counts,
                deploymentTotal: deployments.length,
                effectiveApproval: auth?.effectiveApproval ?? 'pending',
                unauthorizedActions: auth?.unauthorizedActions ?? [],
            };
        });
        res.json(summaries);
    } catch (error) {
        console.error('[Blueprints] List error:', error);
        res.status(500).json({ error: 'Failed to list blueprints' });
    }
});

blueprintsRouter.post('/', (req: Request, res: Response): void => {
    if (!requirePermission(req, res, 'stack:create')) return;
    if (!requireBody(req, res)) return;
    const body = req.body as BlueprintBody;
    const nameError = validateName(body.name);
    if (nameError) { res.status(400).json({ error: nameError }); return; }
    const composeError = validateComposeContent(body.compose_content);
    if (composeError) { res.status(400).json({ error: composeError }); return; }
    const descError = validateDescription(body.description);
    if (descError) { res.status(400).json({ error: descError }); return; }
    const selectorResult = parseSelector(body.selector);
    if (!selectorResult.ok) { res.status(400).json({ error: selectorResult.error }); return; }
    const driftModeError = validateDriftMode(body.drift_mode ?? 'suggest');
    if (driftModeError) { res.status(400).json({ error: driftModeError }); return; }
    try {
        const composeContent = body.compose_content as string;
        const analysis = BlueprintAnalyzer.analyze(composeContent);
        const blueprint = DatabaseService.getInstance().createBlueprint({
            name: (body.name as string).trim(),
            description: typeof body.description === 'string' ? body.description : null,
            compose_content: composeContent,
            selector: selectorResult.selector,
            drift_mode: (body.drift_mode as DriftMode | undefined) ?? 'suggest',
            classification: analysis.classification,
            classification_reasons: analysis.reasons,
            enabled: body.enabled === undefined ? true : Boolean(body.enabled),
            created_by: req.user?.username ?? null,
        });
        res.status(201).json(blueprint);
    } catch (error) {
        if (isSqliteUniqueViolation(error)) {
            res.status(409).json({ error: 'A blueprint with that name already exists' });
            return;
        }
        console.error('[Blueprints] Create error:', error);
        res.status(500).json({ error: 'Failed to create blueprint' });
    }
});

blueprintsRouter.get('/:id', (req: Request, res: Response): void => {
    if (!requirePermission(req, res, 'node:read')) return;
    const id = parseIntParam(req, res, 'id');
    if (id === null) return;
    try {
        const summary = summarizeBlueprint(id);
        if (!summary) { res.status(404).json({ error: 'Blueprint not found' }); return; }
        res.json(summary);
    } catch (error) {
        console.error('[Blueprints] Get error:', error);
        res.status(500).json({ error: 'Failed to fetch blueprint' });
    }
});

blueprintsRouter.put('/:id', (req: Request, res: Response): void => {
    if (!requirePermission(req, res, 'stack:edit')) return;
    if (!requireBody(req, res)) return;
    const id = parseIntParam(req, res, 'id');
    if (id === null) return;
    const body = req.body as BlueprintBody;
    const updates: Parameters<DatabaseService['updateBlueprint']>[1] = {};
    if (body.name !== undefined) {
        const nameError = validateName(body.name);
        if (nameError) { res.status(400).json({ error: nameError }); return; }
        const nextName = (body.name as string).trim();
        const existing = DatabaseService.getInstance().getBlueprint(id);
        if (existing && existing.name !== nextName
            && DatabaseService.getInstance().hasNonWithdrawnBlueprintDeployments(id)) {
            res.status(409).json({
                error: 'Rename is blocked while non-withdrawn deployments or guards exist. Withdraw or resolve them first.',
                code: 'RENAME_BLOCKED',
            });
            return;
        }
        updates.name = nextName;
    }
    if (body.description !== undefined) {
        const descError = validateDescription(body.description);
        if (descError) { res.status(400).json({ error: descError }); return; }
        updates.description = body.description as string | null;
    }
    if (body.compose_content !== undefined) {
        const composeError = validateComposeContent(body.compose_content);
        if (composeError) { res.status(400).json({ error: composeError }); return; }
        const composeContent = body.compose_content as string;
        const analysis = BlueprintAnalyzer.analyze(composeContent);
        updates.compose_content = composeContent;
        updates.classification = analysis.classification;
        updates.classification_reasons = analysis.reasons;
        updates.bumpRevision = true;
    }
    if (body.selector !== undefined) {
        const selectorResult = parseSelector(body.selector);
        if (!selectorResult.ok) { res.status(400).json({ error: selectorResult.error }); return; }
        updates.selector = selectorResult.selector;
    }
    if (body.drift_mode !== undefined) {
        const driftModeError = validateDriftMode(body.drift_mode);
        if (driftModeError) { res.status(400).json({ error: driftModeError }); return; }
        updates.drift_mode = body.drift_mode as DriftMode;
    }
    if (body.enabled !== undefined) {
        const next = Boolean(body.enabled);
        if (!next) {
            // Refuse to disable a blueprint with active deployments. Operator must withdraw explicitly.
            const existing = DatabaseService.getInstance().getBlueprint(id);
            if (existing?.enabled) {
                const deployments = DatabaseService.getInstance().listDeployments(id);
                const blocking = deployments.filter(d =>
                    d.status === 'active' || d.status === 'drifted' || d.status === 'correcting' || d.status === 'evict_blocked',
                );
                if (blocking.length > 0) {
                    res.status(409).json({
                        error: `Cannot disable a blueprint with ${blocking.length} active or drifted deployment(s). Withdraw each deployment first.`,
                        code: 'has_active_deployments',
                    });
                    return;
                }
            }
        }
        updates.enabled = next;
    }
    try {
        const updated = DatabaseService.getInstance().updateBlueprint(id, updates);
        if (!updated) { res.status(404).json({ error: 'Blueprint not found' }); return; }
        res.json(updated);
    } catch (error) {
        if (isSqliteUniqueViolation(error)) {
            res.status(409).json({ error: 'A blueprint with that name already exists' });
            return;
        }
        console.error('[Blueprints] Update error:', error);
        res.status(500).json({ error: 'Failed to update blueprint' });
    }
});

blueprintsRouter.delete('/:id', async (req: Request, res: Response): Promise<void> => {
    if (!requirePermission(req, res, 'stack:delete')) return;
    const id = parseIntParam(req, res, 'id');
    if (id === null) return;
    try {
        const blueprint = DatabaseService.getInstance().getBlueprint(id);
        if (!blueprint) { res.status(404).json({ error: 'Blueprint not found' }); return; }
        // Refuse delete on stateful blueprints that still have a stack Sencho deployed and
        // owns on a node; the operator must withdraw those explicitly so the snapshot-vs-destroy
        // choice is made. "Deployed by us" is last_deployed_at != null, which holds regardless of
        // the current status (a previously deployed stack that later failed still carries it). A
        // never-deployed row (e.g. a reconciler-created pending_state_review awaiting first deploy)
        // has nothing of ours on the node, so it must not block delete. name_conflict is a
        // same-name stack we do not own, and withdrawn is already gone, so neither blocks.
        if (blueprint.classification === 'stateful' || blueprint.classification === 'unknown') {
            const deployments = DatabaseService.getInstance().listDeployments(id);
            const blocking = deployments.filter(d =>
                d.last_deployed_at != null && d.status !== 'name_conflict' && d.status !== 'withdrawn',
            );
            if (blocking.length > 0) {
                res.status(409).json({
                    error: `Cannot delete a stateful blueprint with ${blocking.length} live deployment(s). Withdraw each from the deployment table first.`,
                    code: 'stateful_deployments_blocking',
                });
                return;
            }
        }
        // Withdraw owned deployments before delete. Fail closed: if any withdraw does not
        // complete as withdrawn, keep the blueprint (and its deployment rows) so the operator
        // can retry. Never orphan a live stack by deleting the only control-plane record.
        const nodes = DatabaseService.getInstance().getNodes();
        const deployments = DatabaseService.getInstance().listDeployments(id);
        for (const dep of deployments) {
            if (dep.last_deployed_at == null || dep.status === 'name_conflict' || dep.status === 'withdrawn') continue;
            const node = nodes.find(n => n.id === dep.node_id);
            if (!node) continue;
            try {
                const outcome = await BlueprintService.getInstance().withdrawFromNode(blueprint, node);
                if (outcome.status !== 'withdrawn') {
                    res.status(409).json({
                        error: `Cannot delete blueprint: withdraw on node "${node.name}" ended as ${outcome.status}. Resolve that deployment, then retry.`,
                        code: 'withdraw_failed_blocking_delete',
                        nodeId: node.id,
                        withdrawStatus: outcome.status,
                    });
                    return;
                }
            } catch (err) {
                console.warn(`[Blueprints] Pre-delete withdraw failed for blueprint ${id} on node ${node.id}:`, err);
                res.status(409).json({
                    error: `Cannot delete blueprint: withdraw on node "${node.name}" failed. Resolve that deployment, then retry.`,
                    code: 'withdraw_failed_blocking_delete',
                    nodeId: node.id,
                });
                return;
            }
        }
        DatabaseService.getInstance().deleteBlueprint(id);
        res.status(204).end();
    } catch (error) {
        console.error('[Blueprints] Delete error:', error);
        res.status(500).json({ error: 'Failed to delete blueprint' });
    }
});

// Node-to-node atomic blueprint apply. A hub posts here on the node that owns
// the stack so the create / write compose+marker / deploy runs under that node's
// per-stack lock (a remote node's lock is process-local and cannot be held by
// the hub over separate HTTP calls). Gated by per-stack stack:edit
// and stack:deploy, the same permissions as the PUT-compose + deploy it bundles;
// the node token the hub presents satisfies them.
blueprintsRouter.post('/apply-local', async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as { stackName?: unknown; composeContent?: unknown; markerContent?: unknown };
    if (typeof body.stackName !== 'string' || !isValidStackName(body.stackName)) {
        res.status(400).json({ error: 'Invalid stack name' });
        return;
    }
    // Same per-stack RBAC as writing the compose file and deploying it directly.
    if (!requirePermission(req, res, 'stack:edit', 'stack', body.stackName)) return;
    if (!requirePermission(req, res, 'stack:deploy', 'stack', body.stackName)) return;
    if (typeof body.composeContent !== 'string' || typeof body.markerContent !== 'string') {
        res.status(400).json({ error: 'composeContent and markerContent are required strings' });
        return;
    }
    if (Buffer.byteLength(body.composeContent, 'utf8') > MAX_BLUEPRINT_COMPOSE_BYTES) {
        res.status(413).json({ error: 'compose content too large' });
        return;
    }
    if (BlueprintService.parseMarker(body.markerContent) === null) {
        res.status(400).json({ error: 'Invalid blueprint marker' });
        return;
    }
    try {
        const outcome = await BlueprintService.getInstance().applyLocalUnderLock(
            req.nodeId, body.stackName, body.composeContent, body.markerContent, '/api/blueprints/apply-local',
        );
        if (!outcome.ran) {
            res.status(409).json({
                error: `${body.stackName} is busy: another operation (${outcome.existingAction}) is already in progress`,
                code: 'stack_op_in_progress',
                inProgress: { action: outcome.existingAction },
            });
            return;
        }
        res.json({ deployed: true });
    } catch (error) {
        if (error instanceof BlueprintNameConflictError) {
            res.status(409).json({ error: error.message, code: 'name_conflict' });
            return;
        }
        if (error instanceof BlueprintOwnershipProbeError) {
            console.error('[Blueprints] apply-local ownership probe failed:', sanitizeForLog(error.message));
            res.status(500).json({ error: error.message });
            return;
        }
        console.error('[Blueprints] apply-local error:', sanitizeForLog(getErrorMessage(error, 'apply failed')));
        res.status(500).json({ error: getErrorMessage(error, 'Blueprint apply failed') });
    }
});

// Node-to-node atomic blueprint withdraw. Ownership is validated under the
// delete lock on this node. Requires stack:delete and refuses Sencho's own stack.
blueprintsRouter.post('/withdraw-local', async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as { stackName?: unknown; blueprintId?: unknown };
    if (typeof body.stackName !== 'string' || !isValidStackName(body.stackName)) {
        res.status(400).json({ error: 'Invalid stack name' });
        return;
    }
    if (typeof body.blueprintId !== 'number' || !Number.isInteger(body.blueprintId) || body.blueprintId <= 0) {
        res.status(400).json({ error: 'blueprintId must be a positive integer' });
        return;
    }
    if (!requirePermission(req, res, 'stack:delete', 'stack', body.stackName)) return;
    if (await refuseIfSelfStack(req, res, body.stackName)) return;

    try {
        const result = await DeployedStackDeletionService.getInstance().deleteDeployedStack({
            nodeId: req.nodeId,
            stackName: body.stackName,
            pruneVolumes: false,
            actor: req.user?.username ?? 'system:blueprint',
            requireBlueprintId: body.blueprintId,
        });
        if (result.ok) {
            res.json({
                status: result.status === 'already_absent' ? 'already_absent' : 'withdrawn',
            });
            return;
        }
        if (result.code === 'name_conflict') {
            res.status(409).json({ error: result.error, code: 'name_conflict' });
            return;
        }
        if (result.code === 'lock_conflict') {
            res.status(409).json({
                error: result.error,
                code: 'stack_op_in_progress',
                inProgress: { action: result.existingAction },
            });
            return;
        }
        res.status(500).json({ error: result.error });
    } catch (error) {
        console.error('[Blueprints] withdraw-local error:', sanitizeForLog(getErrorMessage(error, 'withdraw failed')));
        res.status(500).json({ error: getErrorMessage(error, 'Blueprint withdraw failed') });
    }
});

blueprintsRouter.post('/:id/apply', async (req: Request, res: Response): Promise<void> => {
    if (!requirePermission(req, res, 'stack:create')) return;
    if (!requirePermission(req, res, 'stack:deploy')) return;
    const id = parseIntParam(req, res, 'id');
    if (id === null) return;
    try {
        const blueprint = DatabaseService.getInstance().getBlueprint(id);
        if (!blueprint) { res.status(404).json({ error: 'Blueprint not found' }); return; }
        if (!blueprint.enabled) {
            res.status(409).json({ error: 'Blueprint is disabled. Enable it before applying.', code: 'blueprint_disabled' });
            return;
        }

        const body = (req.body ?? {}) as { planFingerprint?: unknown; actions?: unknown };
        if (typeof body.planFingerprint !== 'string' || body.planFingerprint.length === 0) {
            res.status(400).json({ error: 'planFingerprint is required', code: 'CONFIRM_REQUIRED' });
            return;
        }
        const parsedActions = parseConfirmableActionsBody(body.actions);
        if (!parsedActions.ok) {
            res.status(400).json({ error: `Invalid actions: ${parsedActions.reason}`, code: 'CONFIRM_REQUIRED' });
            return;
        }

        const preview = await buildBlueprintPreview(id);
        if (!preview) {
            res.status(404).json({ error: 'Blueprint not found' });
            return;
        }
        if (preview.summary.blocker > 0) {
            res.status(409).json({ error: 'Plan has blockers', code: 'PLAN_BLOCKED', preview });
            return;
        }
        if (
            body.planFingerprint !== preview.planFingerprint
            || !confirmableActionsEqual(parsedActions.actions, preview.confirmableActions)
        ) {
            res.status(409).json({ error: 'Preview is stale; refresh and confirm again', code: 'PREVIEW_STALE', preview });
            return;
        }

        const blast = deriveBlastFromConfirmableActions(preview.confirmableActions);
        const approved = DatabaseService.getInstance().setBlueprintApproval(id, {
            intentFingerprint: preview.planFingerprint,
            blastJson: serializeApprovedBlast(blast),
            approvedBy: req.user?.username ?? null,
        });
        // planFingerprint is from an earlier preview. Concurrent compose/selector
        // edits can invalidate it before approval persists, or the reconciler can
        // refuse if the live gate no longer matches. Both paths clear and 409.
        const approvalMatches = !!approved && intentFingerprint(approved) === preview.planFingerprint;
        const plan = approvalMatches
            ? await BlueprintReconciler.getInstance().reconcileConfirmedPlan(id, preview.executorActions)
            : null;
        if (!plan || plan.refused) {
            DatabaseService.getInstance().clearBlueprintApproval(id);
            const fresh = await buildBlueprintPreview(id);
            res.status(409).json({
                error: 'Preview is stale; refresh and confirm again',
                code: 'PREVIEW_STALE',
                preview: fresh,
            });
            return;
        }
        // Snapshot deploy may finish after a concurrent edit cleared approval.
        // Report live effectiveApproval; do not hardcode "approved".
        const live = DatabaseService.getInstance().getBlueprint(id);
        const { effectiveApproval } = live
            ? evaluateEffectiveApproval(live, preview.executorActions)
            : { effectiveApproval: 'pending' as const };
        const outcomeSummary = summarizeConfirmedOutcomes(plan.outcomes);
        const message = effectiveApproval === 'approved'
            ? messageForConfirmedOutcomes(outcomeSummary)
            : messageForSnapshotFinishedWithStaleApproval(outcomeSummary);
        res.json({
            message,
            blueprintId: id,
            effectiveApproval,
            outcomes: plan.outcomes,
            outcomeSummary,
        });
    } catch (error) {
        console.error('[Blueprints] Apply error:', error);
        res.status(500).json({ error: 'Failed to apply blueprint' });
    }
});

blueprintsRouter.post('/:id/withdraw/:nodeId', async (req: Request, res: Response): Promise<void> => {
    const id = parseIntParam(req, res, 'id');
    if (id === null) return;
    const nodeId = parseIntParam(req, res, 'nodeId');
    if (nodeId === null) return;
    const confirm = typeof req.body?.confirm === 'string' ? req.body.confirm : 'standard';
    if (!['standard', 'snapshot_then_evict', 'evict_and_destroy'].includes(confirm)) {
        res.status(400).json({ error: 'confirm must be one of: standard, snapshot_then_evict, evict_and_destroy' });
        return;
    }
    try {
        const blueprint = DatabaseService.getInstance().getBlueprint(id);
        if (!blueprint) { res.status(404).json({ error: 'Blueprint not found' }); return; }
        if (!requirePermission(req, res, 'stack:delete', 'stack', blueprint.name, nodeId)) return;
        const node = DatabaseService.getInstance().getNode(nodeId);
        if (!node) { res.status(404).json({ error: 'Node not found' }); return; }
        const isStateful = blueprint.classification === 'stateful' || blueprint.classification === 'unknown';
        if (isStateful && confirm === 'standard') {
            res.status(409).json({
                error: 'This blueprint is stateful. Pass confirm = "snapshot_then_evict" or "evict_and_destroy" to evict.',
                code: 'evict_blocked',
            });
            return;
        }
        // Destructive eviction (and reconciler-queued evict_blocked rows) require a
        // current approved remove outcome. Plain stateless "standard" withdraw
        // remains an immediate operator stop (no remove blast required).
        const existingDep = DatabaseService.getInstance().getDeployment(id, nodeId);
        const destructiveConfirm = confirm === 'snapshot_then_evict' || confirm === 'evict_and_destroy';
        if (destructiveConfirm || existingDep?.status === 'evict_blocked') {
            const guard = BlueprintReconciler.getInstance().validateWithdrawConfirmation(id, nodeId);
            if (!guard.ok) {
                res.status(409).json({ error: guard.error, code: guard.code });
                return;
            }
        }
        let snapshotId: number | null = null;
        if (confirm === 'snapshot_then_evict') {
            const compose = blueprint.compose_content;
            if (!compose || compose.trim().length === 0) {
                res.status(500).json({
                    error: 'Blueprint has no compose content to snapshot',
                    code: 'snapshot_failed',
                });
                return;
            }
            try {
                const db = DatabaseService.getInstance();
                const username = req.user?.username ?? 'admin';
                snapshotId = db.createSnapshot(
                    `Pre-eviction: blueprint=${blueprint.name} node=${node.name}`,
                    username,
                    1,
                    1,
                    '[]',
                );
                db.insertSnapshotFiles(snapshotId, [{
                    nodeId: node.id,
                    nodeName: node.name,
                    stackName: blueprint.name,
                    filename: 'compose.yaml',
                    content: compose,
                }]);
            } catch (snapErr) {
                console.error('[Blueprints] Pre-eviction snapshot failed:', snapErr);
                if (snapshotId !== null) {
                    try { DatabaseService.getInstance().deleteSnapshot(snapshotId); }
                    catch (cleanupErr) { console.error('[Blueprints] Failed to clean up orphan snapshot row:', cleanupErr); }
                }
                res.status(500).json({
                    error: 'Failed to capture compose snapshot before eviction',
                    code: 'snapshot_failed',
                });
                return;
            }
        }
        const result = await BlueprintService.getInstance().withdrawFromNode(blueprint, node);
        res.json({
            status: result.status,
            error: result.error ?? null,
            snapshotPolicy: confirm,
            snapshotId,
        });
    } catch (error) {
        console.error('[Blueprints] Withdraw error:', error);
        res.status(500).json({ error: getErrorMessage(error, 'Failed to withdraw blueprint') });
    }
});

blueprintsRouter.post('/:id/accept/:nodeId', async (req: Request, res: Response): Promise<void> => {
    const id = parseIntParam(req, res, 'id');
    if (id === null) return;
    const nodeId = parseIntParam(req, res, 'nodeId');
    if (nodeId === null) return;
    const mode = typeof req.body?.mode === 'string' ? req.body.mode : '';
    if (!['fresh', 'restore_from_snapshot'].includes(mode)) {
        res.status(400).json({ error: 'mode must be "fresh" or "restore_from_snapshot"' });
        return;
    }
    try {
        const blueprint = DatabaseService.getInstance().getBlueprint(id);
        if (!blueprint) { res.status(404).json({ error: 'Blueprint not found' }); return; }
        if (!requirePermission(req, res, 'stack:deploy', 'stack', blueprint.name, nodeId)) return;
        const guard = BlueprintReconciler.getInstance().validateGuardConfirmation(id, nodeId, 'accept');
        if (!guard.ok) {
            res.status(409).json({ error: guard.error, code: guard.code });
            return;
        }
        // 'restore_from_snapshot' is reserved for the future Volume Migration feature.
        // v1 always proceeds with a fresh deploy; the mode is recorded for audit purposes only.
        await BlueprintReconciler.getInstance().forceDeploy(id, nodeId);
        res.json({ status: 'deploying', mode });
    } catch (error) {
        console.error('[Blueprints] Accept error:', error);
        res.status(500).json({ error: getErrorMessage(error, 'Failed to accept deployment') });
    }
});

blueprintsRouter.get('/:id/preview', async (req: Request, res: Response): Promise<void> => {
    if (!requirePermission(req, res, 'node:read')) return;
    const id = parseIntParam(req, res, 'id');
    if (id === null) return;
    try {
        const preview = await buildBlueprintPreview(id);
        if (!preview) { res.status(404).json({ error: 'Blueprint not found' }); return; }
        res.json(preview);
    } catch (error) {
        console.error('[Blueprints] Preview error:', error);
        res.status(500).json({ error: 'Failed to preview blueprint' });
    }
});

blueprintsRouter.put('/:id/pin', async (req: Request, res: Response): Promise<void> => {
    if (!requireBody(req, res)) return;
    const id = parseIntParam(req, res, 'id');
    if (id === null) return;
    const rawNodeId = (req.body as { nodeId?: unknown }).nodeId;
    let nodeId: number | null;
    if (rawNodeId === null) {
        nodeId = null;
    } else if (typeof rawNodeId === 'number' && Number.isInteger(rawNodeId) && rawNodeId > 0) {
        nodeId = rawNodeId;
    } else {
        res.status(400).json({ error: 'nodeId must be a positive integer or null' });
        return;
    }
    if (!requirePermission(req, res, 'node:manage', nodeId === null ? undefined : 'node', nodeId === null ? undefined : String(nodeId))) return;
    try {
        const blueprint = DatabaseService.getInstance().getBlueprint(id);
        if (!blueprint) { res.status(404).json({ error: 'Blueprint not found' }); return; }
        if (nodeId !== null) {
            const node = DatabaseService.getInstance().getNode(nodeId);
            if (!node) { res.status(404).json({ error: 'Node not found' }); return; }
        }
        const updated = DatabaseService.getInstance().setBlueprintPinnedNode(id, nodeId);
        if (!updated) { res.status(404).json({ error: 'Blueprint not found' }); return; }
        if (isDebugEnabled()) console.log('[Federation:diag] pinned blueprint=%s node=%s', sanitizeForLog(id), sanitizeForLog(nodeId));
        // Pin clears approval, so reconcileOne cannot mutate until Confirm Apply.
        // Still call it so the fail-closed pending state is evaluated immediately
        // instead of waiting for the next tick.
        if (updated.enabled) {
            BlueprintReconciler.getInstance().reconcileOne(id).catch(err => {
                console.warn('[Blueprints] post-pin reconcileOne failed:', err);
            });
        }
        res.json(updated);
    } catch (error) {
        console.error('[Blueprints] Pin error:', error);
        res.status(500).json({ error: 'Failed to update blueprint pin' });
    }
});

blueprintsRouter.post('/analyze', (req: Request, res: Response): void => {
    if (!requireBody(req, res)) return;
    const composeContent = typeof req.body?.compose_content === 'string' ? req.body.compose_content : '';
    if (!composeContent.trim()) {
        res.status(400).json({ error: 'compose_content is required' });
        return;
    }
    if (Buffer.byteLength(composeContent, 'utf8') > MAX_BLUEPRINT_COMPOSE_BYTES) {
        res.status(400).json({ error: `compose_content must be ${MAX_BLUEPRINT_COMPOSE_BYTES} bytes or fewer` });
        return;
    }
    const result = BlueprintAnalyzer.analyze(composeContent);
    res.json(result);
});
