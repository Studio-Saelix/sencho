import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requirePaid, requireAdmiral, requireAdmin, requireBody } from '../middleware/tierGates';
import {
    DatabaseService,
    type BlueprintSelector,
    type DriftMode,
} from '../services/DatabaseService';
import { BlueprintService } from '../services/BlueprintService';
import { BlueprintReconciler } from '../services/BlueprintReconciler';
import { BlueprintAnalyzer } from '../services/BlueprintAnalyzer';
import { NodeLabelService } from '../services/NodeLabelService';
import { isValidStackName } from '../utils/validation';
import { parseIntParam } from '../utils/parseIntParam';
import { isSqliteUniqueViolation, getErrorMessage } from '../utils/errors';

export const blueprintsRouter = Router();

blueprintsRouter.use(authMiddleware);

const VALID_DRIFT_MODES: readonly DriftMode[] = ['observe', 'suggest', 'enforce'];
const MAX_SELECTOR_ENTRIES = 200;
const MAX_DESCRIPTION_LENGTH = 2048;
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

function summarizeBlueprint(blueprintId: number) {
    const db = DatabaseService.getInstance();
    const blueprint = db.getBlueprint(blueprintId);
    if (!blueprint) return null;
    const deployments = db.listDeployments(blueprintId);
    const counts: Record<string, number> = {};
    for (const dep of deployments) {
        counts[dep.status] = (counts[dep.status] ?? 0) + 1;
    }
    return { blueprint, deployments, statusCounts: counts };
}

blueprintsRouter.get('/', (req: Request, res: Response): void => {
    if (!requirePaid(req, res)) return;
    try {
        const blueprints = DatabaseService.getInstance().listBlueprints();
        const summaries = blueprints.map(b => {
            const deployments = DatabaseService.getInstance().listDeployments(b.id);
            const counts: Record<string, number> = {};
            for (const dep of deployments) counts[dep.status] = (counts[dep.status] ?? 0) + 1;
            return { ...b, deploymentCounts: counts, deploymentTotal: deployments.length };
        });
        res.json(summaries);
    } catch (error) {
        console.error('[Blueprints] List error:', error);
        res.status(500).json({ error: 'Failed to list blueprints' });
    }
});

blueprintsRouter.post('/', (req: Request, res: Response): void => {
    if (!requirePaid(req, res)) return;
    if (!requireAdmin(req, res)) return;
    if (!requireBody(req, res)) return;
    const body = req.body as BlueprintBody;
    const nameError = validateName(body.name);
    if (nameError) { res.status(400).json({ error: nameError }); return; }
    if (typeof body.compose_content !== 'string' || body.compose_content.trim().length === 0) {
        res.status(400).json({ error: 'compose_content must be a non-empty string' });
        return;
    }
    const descError = validateDescription(body.description);
    if (descError) { res.status(400).json({ error: descError }); return; }
    const selectorResult = parseSelector(body.selector);
    if (!selectorResult.ok) { res.status(400).json({ error: selectorResult.error }); return; }
    const driftModeError = validateDriftMode(body.drift_mode ?? 'suggest');
    if (driftModeError) { res.status(400).json({ error: driftModeError }); return; }
    try {
        const analysis = BlueprintAnalyzer.analyze(body.compose_content);
        const blueprint = DatabaseService.getInstance().createBlueprint({
            name: (body.name as string).trim(),
            description: typeof body.description === 'string' ? body.description : null,
            compose_content: body.compose_content,
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
    if (!requirePaid(req, res)) return;
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
    if (!requirePaid(req, res)) return;
    if (!requireAdmin(req, res)) return;
    if (!requireBody(req, res)) return;
    const id = parseIntParam(req, res, 'id');
    if (id === null) return;
    const body = req.body as BlueprintBody;
    const updates: Parameters<DatabaseService['updateBlueprint']>[1] = {};
    if (body.name !== undefined) {
        const nameError = validateName(body.name);
        if (nameError) { res.status(400).json({ error: nameError }); return; }
        updates.name = (body.name as string).trim();
    }
    if (body.description !== undefined) {
        const descError = validateDescription(body.description);
        if (descError) { res.status(400).json({ error: descError }); return; }
        updates.description = body.description as string | null;
    }
    if (body.compose_content !== undefined) {
        if (typeof body.compose_content !== 'string' || body.compose_content.trim().length === 0) {
            res.status(400).json({ error: 'compose_content must be a non-empty string' });
            return;
        }
        const analysis = BlueprintAnalyzer.analyze(body.compose_content);
        updates.compose_content = body.compose_content;
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
            // Refuse to disable a blueprint with active deployments — operator must withdraw explicitly.
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
    if (!requirePaid(req, res)) return;
    if (!requireAdmin(req, res)) return;
    const id = parseIntParam(req, res, 'id');
    if (id === null) return;
    try {
        const blueprint = DatabaseService.getInstance().getBlueprint(id);
        if (!blueprint) { res.status(404).json({ error: 'Blueprint not found' }); return; }
        // Refuse delete on stateful blueprints with active deployments — operator must withdraw explicitly first
        if (blueprint.classification === 'stateful' || blueprint.classification === 'unknown') {
            const deployments = DatabaseService.getInstance().listDeployments(id);
            const blocking = deployments.filter(d => d.status === 'active' || d.status === 'evict_blocked' || d.status === 'pending_state_review');
            if (blocking.length > 0) {
                res.status(409).json({
                    error: `Cannot delete a stateful blueprint with ${blocking.length} active or pending deployment(s). Withdraw each deployment explicitly first.`,
                    code: 'stateful_deployments_blocking',
                });
                return;
            }
        }
        // For stateless: best-effort withdraw before delete
        const nodes = DatabaseService.getInstance().getNodes();
        const deployments = DatabaseService.getInstance().listDeployments(id);
        for (const dep of deployments) {
            const node = nodes.find(n => n.id === dep.node_id);
            if (!node) continue;
            try {
                await BlueprintService.getInstance().withdrawFromNode(blueprint, node);
            } catch (err) {
                console.warn(`[Blueprints] Pre-delete withdraw failed for blueprint ${id} on node ${node.id}:`, err);
            }
        }
        DatabaseService.getInstance().deleteBlueprint(id);
        res.status(204).end();
    } catch (error) {
        console.error('[Blueprints] Delete error:', error);
        res.status(500).json({ error: 'Failed to delete blueprint' });
    }
});

blueprintsRouter.post('/:id/apply', async (req: Request, res: Response): Promise<void> => {
    if (!requirePaid(req, res)) return;
    if (!requireAdmin(req, res)) return;
    const id = parseIntParam(req, res, 'id');
    if (id === null) return;
    try {
        const blueprint = DatabaseService.getInstance().getBlueprint(id);
        if (!blueprint) { res.status(404).json({ error: 'Blueprint not found' }); return; }
        if (!blueprint.enabled) {
            res.status(409).json({ error: 'Blueprint is disabled. Enable it before applying.', code: 'blueprint_disabled' });
            return;
        }
        await BlueprintReconciler.getInstance().reconcileOne(id);
        res.json({ message: 'Reconciliation triggered', blueprintId: id });
    } catch (error) {
        console.error('[Blueprints] Apply error:', error);
        res.status(500).json({ error: 'Failed to apply blueprint' });
    }
});

blueprintsRouter.post('/:id/withdraw/:nodeId', async (req: Request, res: Response): Promise<void> => {
    if (!requirePaid(req, res)) return;
    if (!requireAdmin(req, res)) return;
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
                    filename: 'docker-compose.yml',
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
    if (!requirePaid(req, res)) return;
    if (!requireAdmin(req, res)) return;
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
        const dep = DatabaseService.getInstance().getDeployment(id, nodeId);
        if (!dep || dep.status !== 'pending_state_review') {
            res.status(409).json({ error: 'Deployment is not awaiting state review' });
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

blueprintsRouter.get('/:id/preview', (req: Request, res: Response): void => {
    if (!requirePaid(req, res)) return;
    const id = parseIntParam(req, res, 'id');
    if (id === null) return;
    try {
        const blueprint = DatabaseService.getInstance().getBlueprint(id);
        if (!blueprint) { res.status(404).json({ error: 'Blueprint not found' }); return; }
        const allNodes = DatabaseService.getInstance().getNodes();
        const desired = NodeLabelService.getInstance().matchSelector(blueprint.selector, allNodes);
        const existing = DatabaseService.getInstance().listDeployments(id);
        const desiredIds = new Set(desired.map(n => n.id));
        const willDeploy = desired.filter(n => !existing.some(d => d.node_id === n.id));
        const willCheck = desired.filter(n => existing.some(d => d.node_id === n.id && d.status === 'active'));
        const willEvict = existing
            .filter(d => !desiredIds.has(d.node_id) && d.status !== 'withdrawn')
            .map(d => d.node_id);
        res.json({
            blueprintId: id,
            classification: blueprint.classification,
            matchedNodes: desired.map(n => ({ id: n.id, name: n.name, type: n.type })),
            plannedDeployments: willDeploy.map(n => ({ id: n.id, name: n.name })),
            plannedDriftChecks: willCheck.map(n => ({ id: n.id, name: n.name })),
            plannedEvictions: willEvict,
        });
    } catch (error) {
        console.error('[Blueprints] Preview error:', error);
        res.status(500).json({ error: 'Failed to preview blueprint' });
    }
});

blueprintsRouter.put('/:id/pin', async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmiral(req, res)) return;
    if (!requireAdmin(req, res)) return;
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
    try {
        const blueprint = DatabaseService.getInstance().getBlueprint(id);
        if (!blueprint) { res.status(404).json({ error: 'Blueprint not found' }); return; }
        if (nodeId !== null) {
            const node = DatabaseService.getInstance().getNode(nodeId);
            if (!node) { res.status(404).json({ error: 'Node not found' }); return; }
        }
        const updated = DatabaseService.getInstance().setBlueprintPinnedNode(id, nodeId);
        if (!updated) { res.status(404).json({ error: 'Blueprint not found' }); return; }
        // Trigger immediate reconciliation so the pin takes effect without
        // waiting for the next 60s tick. Errors here are logged but do not
        // fail the request: the pin is already persisted.
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
    if (!requirePaid(req, res)) return;
    if (!requireBody(req, res)) return;
    const composeContent = typeof req.body?.compose_content === 'string' ? req.body.compose_content : '';
    if (!composeContent.trim()) {
        res.status(400).json({ error: 'compose_content is required' });
        return;
    }
    const result = BlueprintAnalyzer.analyze(composeContent);
    res.json(result);
});
