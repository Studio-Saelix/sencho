import { Router, type Request, type Response } from 'express';
import { DatabaseService } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';
import { MeshError, MeshService } from '../services/MeshService';
import { requireAdmin, requireAdmiral } from '../middleware/tierGates';
import { sanitizeForLog } from '../utils/safeLog';
import { isValidStackName } from '../utils/validation';

export const meshRouter = Router();

function actorFor(req: Request): string {
    const user = (req as Request & { user?: { username?: string } }).user;
    return user?.username || 'system';
}

meshRouter.get('/status', async (_req: Request, res: Response): Promise<void> => {
    if (!requireAdmiral(_req, res)) return;
    try {
        const status = await MeshService.getInstance().getStatus();
        res.json({ nodes: status });
    } catch (err) {
        console.warn('[mesh] /status failed:', sanitizeForLog((err as Error).message));
        res.status(500).json({ error: 'Failed to load mesh status' });
    }
});

meshRouter.post('/nodes/:nodeId/enable', async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmiral(req, res)) return;
    if (!requireAdmin(req, res)) return;
    const nodeId = Number.parseInt(req.params.nodeId as string, 10);
    if (!Number.isFinite(nodeId)) { res.status(400).json({ error: 'Invalid node id' }); return; }
    try {
        await MeshService.getInstance().enableForNode(nodeId);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

meshRouter.post('/nodes/:nodeId/disable', async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmiral(req, res)) return;
    if (!requireAdmin(req, res)) return;
    const nodeId = Number.parseInt(req.params.nodeId as string, 10);
    if (!Number.isFinite(nodeId)) { res.status(400).json({ error: 'Invalid node id' }); return; }
    try {
        await MeshService.getInstance().disableForNode(nodeId);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

/**
 * Returns the LOCAL Docker daemon's services for a stack with their listening
 * ports. Always queries this Sencho instance's own Dockerode regardless of
 * `x-node-id`. Central calls this endpoint against each remote node via the
 * existing proxy chain (`NodeRegistry.getProxyTarget`) so it can build the
 * cross-fleet alias cache without violating the local-only Dockerode rule.
 */
/**
 * Sidecar lifecycle endpoints that always operate on the LOCAL Docker
 * daemon. Central's MeshService HTTP-calls these against each remote node
 * via the existing proxy chain so spawn/stop/inspect respect the
 * "remote-Docker is not directly accessible" rule. Mirrors the
 * `/local-services/:stackName` pattern from PR #992.
 *
 * `nodeId` in the request body is the FLEET-wide node id used to label and
 * uniquely name the sidecar container. Each Sencho instance only ever sees
 * its own assigned id, so there is no cross-node collision.
 */
meshRouter.post('/local-sidecar/spawn', async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmiral(req, res)) return;
    if (!requireAdmin(req, res)) return;
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    try {
        await MeshService.getInstance().spawnLocalSidecar(nodeId);
        res.json({ ok: true });
    } catch (err) {
        console.warn('[mesh] /local-sidecar/spawn failed:', sanitizeForLog((err as Error).message));
        res.status(500).json({ error: (err as Error).message });
    }
});

meshRouter.post('/local-sidecar/stop', async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmiral(req, res)) return;
    if (!requireAdmin(req, res)) return;
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    try {
        await MeshService.getInstance().stopLocalSidecar(nodeId);
        res.json({ ok: true });
    } catch (err) {
        console.warn('[mesh] /local-sidecar/stop failed:', sanitizeForLog((err as Error).message));
        res.status(500).json({ error: (err as Error).message });
    }
});

meshRouter.get('/local-sidecar/inspect', async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmiral(req, res)) return;
    const nodeId = NodeRegistry.getInstance().getDefaultNodeId();
    try {
        const running = await MeshService.getInstance().isLocalSidecarRunning(nodeId);
        res.json({ running });
    } catch (err) {
        console.warn('[mesh] /local-sidecar/inspect failed:', sanitizeForLog((err as Error).message));
        res.status(500).json({ error: 'Failed to inspect sidecar' });
    }
});

meshRouter.get('/local-services/:stackName', async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmiral(req, res)) return;
    const stackName = req.params.stackName as string;
    if (!isValidStackName(stackName)) { res.status(400).json({ error: 'Invalid stack name' }); return; }
    try {
        const services = await MeshService.getInstance().inspectLocalStackServices(stackName);
        res.json({ services });
    } catch (err) {
        console.warn('[mesh] /local-services failed:', sanitizeForLog((err as Error).message));
        res.status(500).json({ error: 'Failed to list local services' });
    }
});

meshRouter.get('/nodes/:nodeId/stacks', async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmiral(req, res)) return;
    const nodeId = Number.parseInt(req.params.nodeId as string, 10);
    if (!Number.isFinite(nodeId)) { res.status(400).json({ error: 'Invalid node id' }); return; }
    try {
        const db = DatabaseService.getInstance();
        const optedIn = new Set(db.listMeshStacks(nodeId).map((s) => s.stack_name));
        const fsSvc = (await import('../services/FileSystemService')).FileSystemService.getInstance(nodeId);
        const stacks = await fsSvc.getStacks();
        res.json({
            stacks: stacks.map((stackName: string) => ({
                name: stackName,
                optedIn: optedIn.has(stackName),
            })),
        });
    } catch (err) {
        console.warn('[mesh] list stacks failed:', sanitizeForLog((err as Error).message));
        res.status(500).json({ error: 'Failed to list stacks' });
    }
});

meshRouter.post('/nodes/:nodeId/stacks/:stackName/opt-in', async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmiral(req, res)) return;
    if (!requireAdmin(req, res)) return;
    const nodeId = Number.parseInt(req.params.nodeId as string, 10);
    const stackName = req.params.stackName as string;
    if (!Number.isFinite(nodeId) || !stackName) { res.status(400).json({ error: 'Invalid params' }); return; }
    try {
        await MeshService.getInstance().optInStack(nodeId, stackName, actorFor(req));
        res.json({ ok: true });
    } catch (err) {
        if (err instanceof MeshError && err.code === 'port_collision') {
            res.status(409).json({ error: err.message, code: err.code });
            return;
        }
        if (err instanceof MeshError) {
            res.status(400).json({ error: err.message, code: err.code });
            return;
        }
        console.warn('[mesh] opt-in failed:', sanitizeForLog((err as Error).message));
        res.status(500).json({ error: 'Opt-in failed' });
    }
});

meshRouter.post('/nodes/:nodeId/stacks/:stackName/opt-out', async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmiral(req, res)) return;
    if (!requireAdmin(req, res)) return;
    const nodeId = Number.parseInt(req.params.nodeId as string, 10);
    const stackName = req.params.stackName as string;
    if (!Number.isFinite(nodeId) || !stackName) { res.status(400).json({ error: 'Invalid params' }); return; }
    try {
        await MeshService.getInstance().optOutStack(nodeId, stackName, actorFor(req));
        res.json({ ok: true });
    } catch (err) {
        console.warn('[mesh] opt-out failed:', sanitizeForLog((err as Error).message));
        res.status(500).json({ error: 'Opt-out failed' });
    }
});

meshRouter.get('/aliases', async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmiral(req, res)) return;
    try {
        const aliases = await MeshService.getInstance().listAliases();
        res.json({ aliases });
    } catch (err) {
        console.warn('[mesh] /aliases failed:', sanitizeForLog((err as Error).message));
        res.status(500).json({ error: 'Failed to list aliases' });
    }
});

meshRouter.get('/aliases/:alias/diagnostic', async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmiral(req, res)) return;
    try {
        const diag = await MeshService.getInstance().getRouteDiagnostic(req.params.alias as string);
        res.json(diag);
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

meshRouter.post('/aliases/:alias/test', async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmiral(req, res)) return;
    try {
        const sourceNodeId = NodeRegistry.getInstance().getDefaultNodeId();
        const result = await MeshService.getInstance().testUpstream(req.params.alias as string, sourceNodeId);
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

meshRouter.get('/nodes/:nodeId/diagnostic', async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmiral(req, res)) return;
    const nodeId = Number.parseInt(req.params.nodeId as string, 10);
    if (!Number.isFinite(nodeId)) { res.status(400).json({ error: 'Invalid node id' }); return; }
    try {
        const diag = await MeshService.getInstance().getNodeDiagnostic(nodeId);
        res.json(diag);
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

meshRouter.post('/nodes/:nodeId/sidecar/restart', async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmiral(req, res)) return;
    if (!requireAdmin(req, res)) return;
    const nodeId = Number.parseInt(req.params.nodeId as string, 10);
    if (!Number.isFinite(nodeId)) { res.status(400).json({ error: 'Invalid node id' }); return; }
    try {
        await MeshService.getInstance().stopSidecar(nodeId);
        await MeshService.getInstance().spawnSidecar(nodeId);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: (err as Error).message });
    }
});

meshRouter.get('/activity', (req: Request, res: Response): void => {
    if (!requireAdmiral(req, res)) return;
    const alias = typeof req.query.alias === 'string' ? req.query.alias : undefined;
    const source = typeof req.query.source === 'string' ? (req.query.source as 'sidecar' | 'pilot' | 'mesh') : undefined;
    const level = typeof req.query.level === 'string' ? (req.query.level as 'info' | 'warn' | 'error') : undefined;
    const limit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 200;
    const events = MeshService.getInstance().getActivity({ alias, source, level, limit });
    res.json({ events });
});

meshRouter.get('/activity/stream', (req: Request, res: Response): void => {
    if (!requireAdmiral(req, res)) return;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const send = (event: object) => {
        try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* ignore */ }
    };
    const unsubscribe = MeshService.getInstance().subscribeActivity(send);
    req.on('close', () => unsubscribe());
});
