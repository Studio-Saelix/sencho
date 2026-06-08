import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin, requireBody } from '../middleware/tierGates';
import { DatabaseService } from '../services/DatabaseService';
import { NodeLabelService } from '../services/NodeLabelService';
import { parseIntParam } from '../utils/parseIntParam';

export const nodeLabelsRouter = Router();

nodeLabelsRouter.use(authMiddleware);

nodeLabelsRouter.get('/', (req: Request, res: Response): void => {
    try {
        const map = NodeLabelService.getInstance().listAll();
        res.json(map);
    } catch (error) {
        console.error('[NodeLabels] List error:', error);
        res.status(500).json({ error: 'Failed to list node labels' });
    }
});

nodeLabelsRouter.get('/all', (req: Request, res: Response): void => {
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
    if (!requireAdmin(req, res)) return;
    if (!requireBody(req, res)) return;
    const nodeId = parseIntParam(req, res, 'nodeId');
    if (nodeId === null) return;
    const label = typeof req.body.label === 'string' ? req.body.label : '';
    try {
        const node = DatabaseService.getInstance().getNode(nodeId);
        if (!node) {
            res.status(404).json({ error: 'Node not found' });
            return;
        }
        const result = NodeLabelService.getInstance().addLabel(nodeId, label);
        if (!result.ok) {
            res.status(400).json(result.error);
            return;
        }
        res.status(201).json({ nodeId, label: result.label });
    } catch (error) {
        console.error('[NodeLabels] Add error:', error);
        res.status(500).json({ error: 'Failed to add label' });
    }
});

nodeLabelsRouter.delete('/:nodeId/:label', (req: Request, res: Response): void => {
    if (!requireAdmin(req, res)) return;
    const nodeId = parseIntParam(req, res, 'nodeId');
    if (nodeId === null) return;
    const labelParam = req.params.label;
    const label = typeof labelParam === 'string' ? labelParam : '';
    if (!label) {
        res.status(400).json({ error: 'label is required' });
        return;
    }
    try {
        const removed = NodeLabelService.getInstance().removeLabel(nodeId, label);
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
