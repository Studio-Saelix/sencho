import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import DockerController from '../services/DockerController';
import { DatabaseService } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';
import { CacheService } from '../services/CacheService';
import { ImageUpdateService } from '../services/ImageUpdateService';
import { FileSystemService } from '../services/FileSystemService';
import { ComposeService } from '../services/ComposeService';
import { NotificationService } from '../services/NotificationService';
import { enforcePolicyPreDeploy } from '../services/PolicyEnforcement';
import { HealthGateService } from '../services/HealthGateService';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin } from '../middleware/tierGates';
import { buildPolicyGateOptions } from '../helpers/policyGate';
import { isValidStackName } from '../utils/validation';
import { sanitizeForLog } from '../utils/safeLog';
import { getErrorMessage } from '../utils/errors';

// Fleet aggregation cache: 2-minute TTL, shared across dashboard tabs.
const FLEET_UPDATE_CACHE_KEY = 'fleet-updates';
const FLEET_CACHE_TTL = 120_000;
const REMOTE_NODE_FETCH_TIMEOUT_MS = 5000;

export const imageUpdatesRouter = Router();

imageUpdatesRouter.get('/', authMiddleware, (req: Request, res: Response): void => {
  try {
    const updates = DatabaseService.getInstance().getStackUpdateStatus(req.nodeId);
    res.json(updates);
  } catch (error) {
    console.error('Failed to fetch image update status:', error);
    res.status(500).json({ error: 'Failed to fetch image update status' });
  }
});

imageUpdatesRouter.post('/refresh', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  try {
    const triggered = ImageUpdateService.getInstance().triggerManualRefresh();
    if (!triggered) {
      const mins = ImageUpdateService.manualCooldownMinutes;
      res.status(429).json({ error: `Rate limited. Please wait at least ${mins} minute${mins !== 1 ? 's' : ''} between manual refreshes.` });
      return;
    }
    res.json({ success: true, message: 'Image update check started in background.' });
  } catch (error) {
    console.error('Failed to trigger image update refresh:', error);
    res.status(500).json({ error: 'Failed to trigger refresh' });
  }
});

imageUpdatesRouter.get('/status', authMiddleware, (_req: Request, res: Response): void => {
  res.json(ImageUpdateService.getInstance().getStatus());
});

// Min/max mirror ImageUpdateService's clamp; the service is the authority and
// re-clamps on read, so this is the user-facing validation boundary.
const IntervalPatchSchema = z.object({
  minutes: z.coerce.number().int().min(15).max(1440),
});

imageUpdatesRouter.put('/interval', authMiddleware, (req: Request, res: Response): void => {
  if (!requireAdmin(req, res)) return;
  const parsed = IntervalPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'minutes must be an integer between 15 and 1440' });
    return;
  }
  try {
    DatabaseService.getInstance().updateGlobalSetting('image_update_check_interval_minutes', String(parsed.data.minutes));
    // Reschedule the live timer so the new cadence takes effect without a restart.
    ImageUpdateService.getInstance().restartPolling();
    res.json(ImageUpdateService.getInstance().getStatus());
  } catch (error) {
    console.error('Failed to update image-update interval:', error);
    res.status(500).json({ error: 'Failed to update interval' });
  }
});

imageUpdatesRouter.get('/fleet', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const result = await CacheService.getInstance().getOrFetch<Record<number, Record<string, boolean>>>(
      FLEET_UPDATE_CACHE_KEY,
      FLEET_CACHE_TTL,
      async () => {
        const db = DatabaseService.getInstance();
        const nodes = db.getNodes();
        const nr = NodeRegistry.getInstance();
        const data: Record<number, Record<string, boolean>> = {};

        // Local nodes: synchronous DB reads.
        for (const node of nodes) {
          if (node.type === 'local') {
            data[node.id] = db.getStackUpdateStatus(node.id);
          }
        }

        // Remote nodes: parallel fetches with per-request timeouts.
        // Pilot-agent rows have no api_url; rely on getProxyTarget for the
        // reachability predicate AND the base URL so pilots with an active
        // tunnel participate in the fan-out.
        const remoteCandidates = nodes
          .filter(n => n.type === 'remote' && n.status === 'online')
          .map(node => ({ node, proxyTarget: nr.getProxyTarget(node.id) }))
          .filter((entry): entry is { node: typeof entry.node; proxyTarget: NonNullable<typeof entry.proxyTarget> } => entry.proxyTarget !== null);
        const remoteResults = await Promise.allSettled(
          remoteCandidates.map(async ({ node, proxyTarget }) => {
            const baseUrl = proxyTarget.apiUrl.replace(/\/$/, '');
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), REMOTE_NODE_FETCH_TIMEOUT_MS);
            try {
              const resp = await fetch(`${baseUrl}/api/image-updates`, {
                headers: proxyTarget.apiToken
                  ? { Authorization: `Bearer ${proxyTarget.apiToken}` }
                  : {},
                signal: controller.signal,
              });
              clearTimeout(timeout);
              if (resp.ok) return { nodeId: node.id, data: await resp.json() as Record<string, boolean> };
            } catch {
              clearTimeout(timeout);
            }
            return null;
          }),
        );

        for (const entry of remoteResults) {
          if (entry.status === 'fulfilled' && entry.value) {
            data[entry.value.nodeId] = entry.value.data;
          }
        }

        return data;
      },
    );
    res.json(result);
  } catch (error) {
    console.error('Failed to aggregate fleet update status:', error);
    res.status(500).json({ error: 'Failed to aggregate fleet update status' });
  }
});

imageUpdatesRouter.post('/fleet/refresh', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(_req, res)) return;

  const db = DatabaseService.getInstance();
  const nodes = db.getNodes();
  const nr = NodeRegistry.getInstance();
  const triggered: number[] = [];
  const rateLimited: number[] = [];
  const failed: number[] = [];

  // ImageUpdateService is a per-instance singleton, so the local node's manual
  // refresh fires at most once per request regardless of how many local rows
  // exist in the schema.
  const localNode = nodes.find(n => n.type === 'local');
  if (localNode) {
    try {
      if (ImageUpdateService.getInstance().triggerManualRefresh()) {
        triggered.push(localNode.id);
      } else {
        rateLimited.push(localNode.id);
      }
    } catch (e) {
      console.error(`[ImageUpdates] Local fleet refresh failed for node ${localNode.id}:`, e);
      failed.push(localNode.id);
    }
  }

  // Pilot-agent rows have no api_url; rely on getProxyTarget for the
  // reachability predicate AND the base URL so pilots with an active
  // tunnel participate in the fan-out.
  const remoteCandidates = nodes
    .filter(n => n.type === 'remote' && n.status === 'online')
    .map(node => ({ node, proxyTarget: nr.getProxyTarget(node.id) }))
    .filter((entry): entry is { node: typeof entry.node; proxyTarget: NonNullable<typeof entry.proxyTarget> } => entry.proxyTarget !== null);
  const remoteResults = await Promise.allSettled(
    remoteCandidates.map(async ({ node, proxyTarget }) => {
      const baseUrl = proxyTarget.apiUrl.replace(/\/$/, '');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REMOTE_NODE_FETCH_TIMEOUT_MS);
      try {
        const resp = await fetch(`${baseUrl}/api/image-updates/refresh`, {
          method: 'POST',
          headers: proxyTarget.apiToken
            ? { Authorization: `Bearer ${proxyTarget.apiToken}` }
            : {},
          signal: controller.signal,
        });
        clearTimeout(timeout);
        return { nodeId: node.id, status: resp.status };
      } catch (e) {
        clearTimeout(timeout);
        return { nodeId: node.id, status: 0, error: e };
      }
    }),
  );

  for (const entry of remoteResults) {
    if (entry.status !== 'fulfilled') continue;
    const { nodeId, status } = entry.value;
    if (status >= 200 && status < 300) {
      triggered.push(nodeId);
    } else if (status === 429) {
      rateLimited.push(nodeId);
    } else {
      failed.push(nodeId);
    }
  }

  CacheService.getInstance().invalidate(FLEET_UPDATE_CACHE_KEY);
  res.json({ triggered, rateLimited, failed });
});

/**
 * Execute auto-update for a single stack (or for every stack on the local
 * node when target="*"). This runs on whichever Sencho instance receives
 * the request; the gateway scheduler proxies to remote nodes via HTTP.
 */
export const autoUpdateRouter = Router();

autoUpdateRouter.post('/execute', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  if (!requireAdmin(req, res)) return;
  try {
    const { target } = req.body as { target?: string };
    console.log(`[AutoUpdate] Execute requested: target="${sanitizeForLog(target || '')}"`);
    if (!target || typeof target !== 'string') {
      res.status(400).json({ error: 'Missing "target" (stack name or "*" for all)' });
      return;
    }

    let stackNames: string[];
    if (target === '*') {
      stackNames = await FileSystemService.getInstance(req.nodeId).getStacks();
      if (stackNames.length === 0) {
        res.json({ result: 'No stacks found on node; skipped.' });
        return;
      }
    } else {
      if (!isValidStackName(target)) {
        res.status(400).json({ error: 'Invalid stack name' });
        return;
      }
      stackNames = [target];
    }

    const docker = DockerController.getInstance(req.nodeId);
    const imageUpdateService = ImageUpdateService.getInstance();
    const compose = ComposeService.getInstance(req.nodeId);
    const db = DatabaseService.getInstance();
    const atomic = true;
    const results: string[] = [];

    for (const stackName of stackNames) {
      try {
        const containers = await docker.getContainersByStack(stackName);
        if (!containers || containers.length === 0) {
          results.push(`Stack "${stackName}": no containers found; skipped.`);
          continue;
        }

        const imageRefs = [...new Set(
          containers
            .map((c: { Image?: string }) => c.Image)
            .filter((img): img is string => !!img && !img.startsWith('sha256:')),
        )];

        if (imageRefs.length === 0) {
          results.push(`Stack "${stackName}": no pullable images; skipped.`);
          continue;
        }

        let hasUpdate = false;
        const updatedImages: string[] = [];
        const checkErrors: string[] = [];
        for (const imageRef of imageRefs) {
          try {
            const result = await imageUpdateService.checkImage(docker, imageRef);
            if (result.error) {
              checkErrors.push(result.error);
            } else if (result.hasUpdate) {
              hasUpdate = true;
              updatedImages.push(imageRef);
            }
          } catch (e) {
            const errMsg = getErrorMessage(e, String(e));
            checkErrors.push(errMsg);
            console.warn('[AutoUpdate] Failed to check image %s:', sanitizeForLog(imageRef), sanitizeForLog((e as Error)?.message ?? String(e)));
          }
        }

        if (!hasUpdate) {
          if (checkErrors.length > 0 && checkErrors.length === imageRefs.length) {
            results.push(`Stack "${stackName}": WARNING - all image checks failed (${checkErrors.join('; ')}). Unable to determine update status.`);
          } else if (checkErrors.length > 0) {
            results.push(`Stack "${stackName}": all reachable images up to date (${checkErrors.length} check(s) failed).`);
          } else {
            results.push(`Stack "${stackName}": all images up to date.`);
          }
          continue;
        }

        // Auto-update runs from the scheduler: a policy bypass is never
        // appropriate. If updated images fail the gate, skip the stack and
        // raise a notification so an operator can review before a manual retry.
        const autoUpdateGate = await enforcePolicyPreDeploy(
          stackName,
          req.nodeId,
          buildPolicyGateOptions(req, {
            bypass: false,
            actor: `auto-update:${req.user?.username ?? 'scheduler'}`,
          }),
        );
        if (!autoUpdateGate.ok) {
          const blockedImages = autoUpdateGate.violations.map((v) => v.imageRef).join(', ');
          const blockedMsg = `Policy "${autoUpdateGate.policy?.name}" blocked auto-update: ${autoUpdateGate.violations.length} image(s) exceed ${autoUpdateGate.policy?.max_severity}${blockedImages ? ` (${blockedImages})` : ''}`;
          NotificationService.getInstance().dispatchAlert('warning', 'scan_finding', blockedMsg, { stackName, actor: 'system:image-update' });
          results.push(`Stack "${stackName}": ${blockedMsg}`);
          continue;
        }

        await compose.updateStack(stackName, undefined, atomic);
        db.clearStackUpdateStatus(req.nodeId, stackName);
        HealthGateService.getInstance().begin(req.nodeId, stackName, 'update', `auto-update:${req.user?.username ?? 'scheduler'}`);

        NotificationService.getInstance().broadcastEvent({
          type: 'state-invalidate',
          scope: 'image-updates',
          nodeId: req.nodeId,
          stackName,
          action: 'stack-updated',
          ts: Date.now(),
        });

        NotificationService.getInstance().dispatchAlert(
          'info',
          'image_update_applied',
          `Auto-update: stack "${stackName}" updated with new images`,
          { stackName, actor: 'system:image-update' },
        );

        results.push(`Stack "${stackName}": updated (${updatedImages.join(', ')}).`);
      } catch (e) {
        const msg = getErrorMessage(e, String(e));
        results.push(`Stack "${stackName}" failed: ${msg}`);
        console.error(`[AutoUpdate] Failed for stack "${stackName}":`, e);
      }
    }

    CacheService.getInstance().invalidate(FLEET_UPDATE_CACHE_KEY);
    res.json({ result: results.join('\n') });
  } catch (error) {
    const msg = getErrorMessage(error, 'Auto-update execution failed');
    console.error('[AutoUpdate] Execute error:', msg);
    res.status(500).json({ error: msg });
  }
});
