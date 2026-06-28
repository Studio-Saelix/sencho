import { Router, type Request, type Response } from 'express';
import DockerController from '../services/DockerController';
import { FileSystemService } from '../services/FileSystemService';
import { requireAdmin } from '../middleware/tierGates';
import { requirePermission } from '../middleware/permissions';
import { invalidateNodeCaches } from '../helpers/cacheInvalidation';

export const containersRouter = Router();

containersRouter.get('/', async (req: Request, res: Response) => {
  if (!requirePermission(req, res, 'stack:read')) return;
  try {
    const dockerController = DockerController.getInstance(req.nodeId);
    const containers = await dockerController.getRunningContainers();
    res.json(containers);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch containers' });
  }
});

containersRouter.get('/:id/logs', async (req: Request, res: Response) => {
  if (!requirePermission(req, res, 'stack:read')) return;
  try {
    const id = req.params.id as string;
    const dockerController = DockerController.getInstance(req.nodeId);
    await dockerController.streamContainerLogs(id, req, res);
  } catch (error) {
    res.status(500).json({ error: 'Failed to initialize log stream' });
  }
});

containersRouter.post('/:id/start', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = req.params.id as string;
    const dockerController = DockerController.getInstance(req.nodeId);
    await dockerController.startContainer(id);
    invalidateNodeCaches(req.nodeId);
    res.json({ message: 'Container started' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start container' });
  }
});

containersRouter.post('/:id/stop', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = req.params.id as string;
    const dockerController = DockerController.getInstance(req.nodeId);
    await dockerController.stopContainer(id);
    invalidateNodeCaches(req.nodeId);
    res.json({ message: 'Container stopped' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to stop container' });
  }
});

containersRouter.post('/:id/restart', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = req.params.id as string;
    const dockerController = DockerController.getInstance(req.nodeId);
    await dockerController.restartContainer(id);
    invalidateNodeCaches(req.nodeId);
    res.json({ message: 'Container restarted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to restart container' });
  }
});

export const portsRouter = Router();

portsRouter.get('/in-use', async (req: Request, res: Response) => {
  if (!requirePermission(req, res, 'stack:read')) return;
  try {
    const fsService = FileSystemService.getInstance(req.nodeId);
    const stacks = await fsService.getStacks();
    const dockerController = DockerController.getInstance(req.nodeId);
    const portsInUse = await dockerController.getPortsInUse(stacks);
    res.json(portsInUse);
  } catch (error) {
    console.error('[Ports] Failed to fetch ports in use:', error);
    res.status(500).json({ error: 'Failed to fetch ports in use' });
  }
});
