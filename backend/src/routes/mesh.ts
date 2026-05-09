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

const MAX_ALIASES_PER_PUSH = 1024;

/**
 * Accepts a fleet-wide alias list from central and writes a mesh override
 * for the named stack onto THIS Sencho's local DATA_DIR. The pilot looks
 * up its own service names and uses its own static IP on `sencho_mesh`,
 * so alias hostnames in user containers always resolve to the LOCAL
 * Sencho IP on the deploying node. Always writes against the LOCAL
 * Sencho's default node id.
 */
meshRouter.put('/local-override/:stackName', async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmiral(req, res)) return;
    const stackName = req.params.stackName as string;
    if (!isValidStackName(stackName)) { res.status(400).json({ error: 'Invalid stack name' }); return; }
    const body = req.body as { aliases?: unknown };
    if (!Array.isArray(body?.aliases)) { res.status(400).json({ error: 'Missing aliases array in body' }); return; }
    if (body.aliases.length > MAX_ALIASES_PER_PUSH) {
        res.status(413).json({ error: `Alias list exceeds ${MAX_ALIASES_PER_PUSH} entries` });
        return;
    }
    const aliases: { host: string }[] = [];
    for (const entry of body.aliases) {
        const host = (entry as { host?: unknown } | null | undefined)?.host;
        if (typeof host !== 'string' || host.length === 0 || host.length > 253) {
            // 253 octets is the DNS hostname ceiling. Defensive against a
            // malicious or buggy central sending a multi-KB host string.
            res.status(400).json({ error: 'Invalid alias entry' });
            return;
        }
        aliases.push({ host });
    }
    try {
        const written = await MeshService.getInstance().applyLocalOverride(stackName, aliases);
        if (!written) { res.status(400).json({ error: 'Refused to write override (path validation failed)' }); return; }
        res.json({ ok: true, path: written });
    } catch (err) {
        if (err instanceof MeshError && err.code === 'push_failed') {
            res.status(503).json({ error: err.message, code: err.code });
            return;
        }
        console.warn('[mesh] /local-override failed:', sanitizeForLog((err as Error).message));
        res.status(500).json({ error: 'Failed to write local override' });
    }
});

/**
 * Delete a previously written local override. Mirror of the PUT endpoint;
 * called by central when a stack is opted out so stale overrides do not
 * linger on the deploying node.
 */
meshRouter.delete('/local-override/:stackName', async (req: Request, res: Response): Promise<void> => {
    if (!requireAdmiral(req, res)) return;
    const stackName = req.params.stackName as string;
    if (!isValidStackName(stackName)) { res.status(400).json({ error: 'Invalid stack name' }); return; }
    try {
        await MeshService.getInstance().removeLocalOverride(stackName);
        res.json({ ok: true });
    } catch (err) {
        console.warn('[mesh] DELETE /local-override failed:', sanitizeForLog((err as Error).message));
        res.status(500).json({ error: 'Failed to remove local override' });
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
        if (err instanceof MeshError && err.code === 'push_failed') {
            res.status(503).json({ error: err.message, code: err.code });
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

meshRouter.get('/activity', (req: Request, res: Response): void => {
    if (!requireAdmiral(req, res)) return;
    const alias = typeof req.query.alias === 'string' ? req.query.alias : undefined;
    const source = typeof req.query.source === 'string' ? (req.query.source as 'pilot' | 'mesh') : undefined;
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
