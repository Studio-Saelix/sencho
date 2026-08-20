import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireBody } from '../middleware/tierGates';
import { requirePermission } from '../middleware/permissions';
import { DatabaseService } from '../services/DatabaseService';
import { NodeLabelService } from '../services/NodeLabelService';
import { parseIntParam } from '../utils/parseIntParam';
import { BlueprintReconciler } from '../services/BlueprintReconciler';
import { recordPlacementShift, snapshotPlacementWith } from '../services/gitops/nodePlacementProducers';
import { projectCommittedRevisions } from '../helpers/gitopsResponse';

export const nodeLabelsRouter = Router();

/**
 * Placement as it currently resolves, for every Blueprint.
 *
 * Taken either side of a label write so the recording covers only the
 * Blueprints the label actually moved. A label no selector mentions moves
 * nothing, and minting for it would invalidate acknowledgements fleet-wide over
 * an edit no node can observe.
 */
function snapshotPlacement() {
    const db = DatabaseService.getInstance();
    const nodes = db.getNodes();
    return snapshotPlacementWith(
        (blueprint) => BlueprintReconciler.getInstance().listDesiredNodes(blueprint, nodes).map(n => n.id),
        db.listBlueprints(),
    );
}

nodeLabelsRouter.use(authMiddleware);

nodeLabelsRouter.get('/', (req: Request, res: Response): void => {
    if (!requirePermission(req, res, 'node:read')) return;
    try {
        const map = NodeLabelService.getInstance().listAll();
        res.json(map);
    } catch (error) {
        console.error('[NodeLabels] List error:', error);
        res.status(500).json({ error: 'Failed to list node labels' });
    }
});

nodeLabelsRouter.get('/all', (req: Request, res: Response): void => {
    if (!requirePermission(req, res, 'node:read')) return;
    try {
        const labels = NodeLabelService.getInstance().listDistinct();
        res.json({ labels });
    } catch (error) {
        console.error('[NodeLabels] List distinct error:', error);
        res.status(500).json({ error: 'Failed to list distinct labels' });
    }
});

nodeLabelsRouter.get('/:nodeId', (req: Request, res: Response): void => {
    const nodeId = parseIntParam(req, res, 'nodeId');
    if (nodeId === null) return;
    if (!requirePermission(req, res, 'node:read', 'node', String(nodeId))) return;
    try {
        const node = DatabaseService.getInstance().getNode(nodeId);
        if (!node) {
            res.status(404).json({ error: 'Node not found' });
            return;
        }
        const labels = NodeLabelService.getInstance().listForNode(nodeId);
        res.json({ nodeId, labels });
    } catch (error) {
        console.error('[NodeLabels] Get-for-node error:', error);
        res.status(500).json({ error: 'Failed to fetch node labels' });
    }
});

nodeLabelsRouter.post('/:nodeId', (req: Request, res: Response): void => {
    if (!requireBody(req, res)) return;
    const nodeId = parseIntParam(req, res, 'nodeId');
    if (nodeId === null) return;
    if (!requirePermission(req, res, 'node:manage', 'node', String(nodeId))) return;
    const label = typeof req.body.label === 'string' ? req.body.label : '';
    try {
        const node = DatabaseService.getInstance().getNode(nodeId);
        if (!node) {
            res.status(404).json({ error: 'Node not found' });
            return;
        }
        // The label and the placement it moves commit together, so a recording
        // failure cannot leave a fleet selecting on a label nothing recorded.
        const { added, moved } = DatabaseService.getInstance().getDb().transaction(() => {
            const before = snapshotPlacement();
            const added = NodeLabelService.getInstance().addLabel(nodeId, label);
            const moved = added.ok
                ? recordPlacementShift(before, snapshotPlacement(), req.user?.username ?? null, 'node_label_add')
                : [];
            return { added, moved };
        })();
        if (!added.ok) {
            res.status(400).json(added.error);
            return;
        }
        // Projected after the commit, so the revisions describe what the label
        // write actually left behind. A label no selector mentions moves nothing
        // and reports an empty list rather than every Blueprint in the fleet.
        res.status(201).json({ nodeId, label: added.label, gitopsRevisions: projectCommittedRevisions(moved, 'node label add') });
    } catch (error) {
        console.error('[NodeLabels] Add error:', error);
        res.status(500).json({ error: 'Failed to add label' });
    }
});

nodeLabelsRouter.delete('/:nodeId/:label', (req: Request, res: Response): void => {
    const nodeId = parseIntParam(req, res, 'nodeId');
    if (nodeId === null) return;
    if (!requirePermission(req, res, 'node:manage', 'node', String(nodeId))) return;
    const labelParam = req.params.label;
    const label = typeof labelParam === 'string' ? labelParam : '';
    if (!label) {
        res.status(400).json({ error: 'label is required' });
        return;
    }
    try {
        const removed = DatabaseService.getInstance().getDb().transaction(() => {
            const before = snapshotPlacement();
            const gone = NodeLabelService.getInstance().removeLabel(nodeId, label);
            if (gone) {
                recordPlacementShift(before, snapshotPlacement(), req.user?.username ?? null, 'node_label_remove');
            }
            return gone;
        })();
        if (!removed) {
            res.status(404).json({ error: 'Label assignment not found' });
            return;
        }
        res.status(204).end();
    } catch (error) {
        console.error('[NodeLabels] Remove error:', error);
        res.status(500).json({ error: 'Failed to remove label' });
    }
});
