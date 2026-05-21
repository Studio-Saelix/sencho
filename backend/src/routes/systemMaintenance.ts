import { Router, type Request, type Response } from 'express';
import DockerController, { type CreateNetworkOptions, type NetworkDriver } from '../services/DockerController';
import { FileSystemService } from '../services/FileSystemService';
import { requireAdmin } from '../middleware/tierGates';
import { invalidateNodeCaches } from '../helpers/cacheInvalidation';
import { isValidDockerResourceId, isValidCidr, isValidIPv4 } from '../utils/validation';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';

export const systemMaintenanceRouter = Router();

systemMaintenanceRouter.get('/orphans', async (req: Request, res: Response) => {
  try {
    const knownStacks = await FileSystemService.getInstance(req.nodeId).getStacks();
    const dockerController = DockerController.getInstance(req.nodeId);
    const orphans = await dockerController.getOrphanContainers(knownStacks);
    res.json(orphans);
  } catch (error) {
    console.error('Failed to fetch orphan containers:', error);
    res.status(500).json({ error: 'Failed to fetch orphan containers' });
  }
});

systemMaintenanceRouter.post('/prune/orphans', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { containerIds } = req.body;
    if (!Array.isArray(containerIds)) {
      return res.status(400).json({ error: 'containerIds must be an array' });
    }
    const invalidIds = containerIds.filter((id: unknown) => typeof id !== 'string' || !isValidDockerResourceId(id));
    if (invalidIds.length > 0) {
      return res.status(400).json({ error: 'One or more container IDs have an invalid format' });
    }
    console.log(`[Resources] Prune orphans: ${sanitizeForLog(containerIds.length)} container(s) requested`);
    const dockerController = DockerController.getInstance(req.nodeId);
    const results = await dockerController.removeContainers(containerIds);
    const succeeded = results.filter((r: { success: boolean }) => r.success).length;
    console.log(`[Resources] Prune orphans completed: ${succeeded}/${sanitizeForLog(containerIds.length)} removed`);
    invalidateNodeCaches(req.nodeId);
    res.json({ results });
  } catch (error) {
    console.error('Failed to prune orphan containers:', error);
    res.status(500).json({ error: 'Failed to prune orphan containers' });
  }
});

systemMaintenanceRouter.post('/prune/system', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { target, scope, dryRun } = req.body as { target: string; scope?: string; dryRun?: boolean };
    if (!['containers', 'images', 'networks', 'volumes'].includes(target)) {
      return res.status(400).json({ error: 'Invalid prune target' });
    }

    const pruneScope = scope === 'managed' ? 'managed' : 'all';
    const isDryRun = dryRun === true;
    const dockerController = DockerController.getInstance(req.nodeId);

    if (isDryRun) {
      // Rehearse the destructive path: same scope resolution, same Docker
      // enumeration, no remove calls. Containers have no managed estimate
      // helper because pruneManagedOnly does not handle them.
      const knownStacks = await FileSystemService.getInstance(req.nodeId).getStacks();
      let estimate: { reclaimableBytes: number };
      if (pruneScope === 'managed' && target !== 'containers') {
        estimate = await dockerController.estimateManagedReclaim(
          target as 'images' | 'volumes' | 'networks',
          knownStacks,
        );
      } else {
        estimate = await dockerController.estimateSystemReclaim(
          target as 'containers' | 'images' | 'networks' | 'volumes',
          knownStacks,
        );
      }
      res.json({ message: 'Dry run', success: true, dryRun: true, reclaimedBytes: estimate.reclaimableBytes });
      return;
    }

    console.log(`[Resources] System prune: ${target} (scope: ${pruneScope})`);
    let result: { success: boolean; reclaimedBytes: number };
    if (pruneScope === 'managed' && target !== 'containers') {
      const knownStacks = await FileSystemService.getInstance(req.nodeId).getStacks();
      result = await dockerController.pruneManagedOnly(
        target as 'images' | 'volumes' | 'networks',
        knownStacks
      );
    } else {
      result = await dockerController.pruneSystem(target as 'containers' | 'images' | 'networks' | 'volumes');
    }

    console.log(`[Resources] System prune completed: ${target}, reclaimed ${result.reclaimedBytes} bytes`);
    if (target === 'containers') {
      invalidateNodeCaches(req.nodeId);
    }
    res.json({ message: 'Prune completed', ...result });
  } catch (error: unknown) {
    console.error('System prune error:', error);
    res.status(500).json({ error: 'System prune failed' });
  }
});

// Non-destructive size estimate for a prune target/scope. The Fleet Actions
// "Prune fleet-wide" card calls this on each remote node to populate its live
// blast-radius readout before the operator confirms. Reuses the same Docker
// enumeration as `/prune/system` so the estimate matches what the destructive
// path would reclaim.
systemMaintenanceRouter.post('/prune/estimate', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { target, scope } = req.body as { target: string; scope?: string };
    if (!['containers', 'images', 'networks', 'volumes'].includes(target)) {
      return res.status(400).json({ error: 'Invalid prune target' });
    }
    const pruneScope = scope === 'managed' ? 'managed' : 'all';
    const dockerController = DockerController.getInstance(req.nodeId);
    const knownStacks = await FileSystemService.getInstance(req.nodeId).getStacks();

    let result: { reclaimableBytes: number };
    if (pruneScope === 'managed' && target !== 'containers') {
      result = await dockerController.estimateManagedReclaim(
        target as 'images' | 'volumes' | 'networks',
        knownStacks,
      );
    } else {
      result = await dockerController.estimateSystemReclaim(
        target as 'containers' | 'images' | 'networks' | 'volumes',
        knownStacks,
      );
    }
    res.json({ reclaimableBytes: result.reclaimableBytes });
  } catch (error: unknown) {
    console.error('Prune estimate error:', error);
    res.status(500).json({ error: 'Failed to estimate reclaimable bytes' });
  }
});

systemMaintenanceRouter.get('/docker-df', async (req: Request, res: Response) => {
  try {
    const knownStacks = await FileSystemService.getInstance(req.nodeId).getStacks();
    const df = await DockerController.getInstance(req.nodeId).getDiskUsageClassified(knownStacks);
    res.json(df);
  } catch (error) {
    console.error('Failed to fetch docker disk usage:', error);
    res.status(500).json({ error: 'Failed to fetch docker disk usage' });
  }
});

systemMaintenanceRouter.get('/resources', async (req: Request, res: Response) => {
  try {
    const knownStacks = await FileSystemService.getInstance(req.nodeId).getStacks();
    const result = await DockerController.getInstance(req.nodeId).getClassifiedResources(knownStacks);
    res.json(result);
  } catch (error) {
    console.error('Failed to fetch classified resources:', error);
    res.status(500).json({ error: 'Failed to fetch resources' });
  }
});

systemMaintenanceRouter.get('/images', async (req: Request, res: Response) => {
  try {
    const knownStacks = await FileSystemService.getInstance(req.nodeId).getStacks();
    const { images } = await DockerController.getInstance(req.nodeId).getClassifiedResources(knownStacks);
    res.json(images);
  } catch (error) {
    console.error('Failed to fetch images:', error);
    res.status(500).json({ error: 'Failed to fetch images' });
  }
});

systemMaintenanceRouter.get('/volumes', async (req: Request, res: Response) => {
  try {
    const knownStacks = await FileSystemService.getInstance(req.nodeId).getStacks();
    const { volumes } = await DockerController.getInstance(req.nodeId).getClassifiedResources(knownStacks);
    res.json(volumes);
  } catch (error) {
    console.error('Failed to fetch volumes:', error);
    res.status(500).json({ error: 'Failed to fetch volumes' });
  }
});

systemMaintenanceRouter.get('/networks', async (req: Request, res: Response) => {
  try {
    const knownStacks = await FileSystemService.getInstance(req.nodeId).getStacks();
    const { networks } = await DockerController.getInstance(req.nodeId).getClassifiedResources(knownStacks);
    res.json(networks);
  } catch (error) {
    console.error('Failed to fetch networks:', error);
    res.status(500).json({ error: 'Failed to fetch networks' });
  }
});

systemMaintenanceRouter.get('/images/:id', async (req: Request, res: Response) => {
  try {
    const rawId = req.params.id as string;
    if (!rawId) return res.status(400).json({ error: 'Invalid image ID format' });
    const hexId = rawId.startsWith('sha256:') ? rawId.slice('sha256:'.length) : rawId;
    if (!isValidDockerResourceId(hexId)) {
      return res.status(400).json({ error: 'Invalid image ID format' });
    }
    const result = await DockerController.getInstance(req.nodeId).inspectImage(hexId);
    res.json(result);
  } catch (error: unknown) {
    console.error('Failed to inspect image:', error);
    const err = error as Record<string, unknown>;
    const is404 = (typeof err.statusCode === 'number' && err.statusCode === 404)
      || (error instanceof Error && error.message.includes('404'));
    res.status(is404 ? 404 : 500).json({ error: is404 ? 'Image not found' : 'Failed to inspect image' });
  }
});

systemMaintenanceRouter.post('/images/delete', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'ID is required' });
    if (typeof id !== 'string' || !isValidDockerResourceId(id)) {
      return res.status(400).json({ error: 'Invalid image ID format' });
    }
    console.log(`[Resources] Delete image: ${id.substring(0, 12)}`);
    const dockerController = DockerController.getInstance(req.nodeId);
    await dockerController.removeImage(id);
    invalidateNodeCaches(req.nodeId);
    res.json({ success: true, message: 'Image deleted' });
  } catch (error: unknown) {
    console.error('Failed to delete image:', error);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

systemMaintenanceRouter.post('/volumes/delete', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { id } = req.body;
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Volume name is required' });
    console.log(`[Resources] Delete volume: ${sanitizeForLog(id)}`);
    const dockerController = DockerController.getInstance(req.nodeId);
    await dockerController.removeVolume(id);
    invalidateNodeCaches(req.nodeId);
    res.json({ success: true, message: 'Volume deleted' });
  } catch (error: unknown) {
    console.error('Failed to delete volume:', error);
    res.status(500).json({ error: 'Failed to delete volume' });
  }
});

systemMaintenanceRouter.post('/networks/delete', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'ID is required' });
    if (typeof id !== 'string' || !isValidDockerResourceId(id)) {
      return res.status(400).json({ error: 'Invalid network ID format' });
    }
    console.log(`[Resources] Delete network: ${id.substring(0, 12)}`);
    const dockerController = DockerController.getInstance(req.nodeId);
    await dockerController.removeNetwork(id);
    invalidateNodeCaches(req.nodeId);
    res.json({ success: true, message: 'Network deleted' });
  } catch (error: unknown) {
    console.error('Failed to delete network:', error);
    res.status(500).json({ error: 'Failed to delete network' });
  }
});

systemMaintenanceRouter.get('/networks/topology', async (req: Request, res: Response) => {
  try {
    const includeSystem = req.query.includeSystem === 'true';
    const knownStacks = await FileSystemService.getInstance(req.nodeId).getStacks();
    const dockerController = DockerController.getInstance(req.nodeId);
    const topology = await dockerController.getTopologyData(knownStacks, includeSystem);
    console.log(`[Resources] Topology fetched: ${topology.length} networks, includeSystem=${includeSystem}`);
    if (isDebugEnabled()) console.debug('[Resources:debug] Topology fetched', { networkCount: topology.length, includeSystem });
    res.json(topology);
  } catch (error: unknown) {
    console.error('Failed to fetch network topology:', error);
    res.status(500).json({ error: 'Failed to fetch network topology' });
  }
});

systemMaintenanceRouter.get('/networks/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    if (!id) return res.status(400).json({ error: 'Network ID is required' });
    const dockerController = DockerController.getInstance(req.nodeId);
    const networkInfo = await dockerController.inspectNetwork(id);
    res.json(networkInfo);
  } catch (error: unknown) {
    console.error('Failed to inspect network:', error);
    const err = error as Record<string, unknown>;
    const is404 = (typeof err.statusCode === 'number' && err.statusCode === 404)
      || (error instanceof Error && error.message.includes('404'));
    res.status(is404 ? 404 : 500).json({ error: is404 ? 'Network not found' : 'Failed to inspect network' });
  }
});

systemMaintenanceRouter.post('/networks', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { name, driver, subnet, gateway, labels, internal, attachable } = req.body;
    if (!name) return res.status(400).json({ error: 'Network name is required' });

    const options: CreateNetworkOptions = { Name: name };

    const VALID_DRIVERS: NetworkDriver[] = ['bridge', 'overlay', 'macvlan', 'host', 'none'];
    if (driver) {
      if (!VALID_DRIVERS.includes(driver)) return res.status(400).json({ error: 'Invalid network driver' });
      options.Driver = driver;
    }
    if (subnet || gateway) {
      if (subnet && !isValidCidr(subnet)) return res.status(400).json({ error: 'Invalid subnet CIDR notation (e.g. 172.20.0.0/16)' });
      if (gateway && !isValidIPv4(gateway)) return res.status(400).json({ error: 'Invalid gateway IP address (e.g. 172.20.0.1)' });
      options.IPAM = { Config: [{}] };
      if (subnet) options.IPAM.Config[0].Subnet = subnet;
      if (gateway) options.IPAM.Config[0].Gateway = gateway;
    }
    if (labels && typeof labels === 'object' && !Array.isArray(labels)) options.Labels = labels;
    if (internal) options.Internal = true;
    if (attachable) options.Attachable = true;

    const dockerController = DockerController.getInstance(req.nodeId);
    const network = await dockerController.createNetwork(options);
    console.log(`[Resources] Network created: ${sanitizeForLog(name)}`);
    invalidateNodeCaches(req.nodeId);
    res.status(201).json({ success: true, message: 'Network created', id: network.id });
  } catch (error: unknown) {
    console.error('Failed to create network:', error);
    const msg = getErrorMessage(error, '');
    const safePatterns = ['already exists', 'name is invalid', 'invalid network name'];
    const lowerMsg = msg.toLowerCase();
    const isSafe = safePatterns.some(p => lowerMsg.includes(p));
    res.status(isSafe ? 409 : 500).json({ error: isSafe ? msg : 'Failed to create network' });
  }
});
