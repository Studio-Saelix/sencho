import { Router, type Request, type Response } from 'express';
import DockerController, {
  PrunePlanStaleError,
  type CreateNetworkOptions,
  type NetworkDriver,
  type PruneScope,
  type PruneTarget,
} from '../services/DockerController';
import { isPruneTarget } from '../services/prunePlan';
import { FileSystemService } from '../services/FileSystemService';
import { ServiceUpdateRecoveryService } from '../services/ServiceUpdateRecoveryService';
import { StackUpdateRecoveryService, shortGenerationId } from '../services/StackUpdateRecoveryService';
import { buildUnifiedHeldImagePredicate } from '../services/recoveryHeldImages';
import { DatabaseService } from '../services/DatabaseService';
import SelfIdentityService from '../services/SelfIdentityService';
import { requireAdmin } from '../middleware/tierGates';
import { invalidateNodeCaches } from '../helpers/cacheInvalidation';
import { activeBulkActions } from '../helpers/bulkActionLocks';
import { isValidDockerResourceId, isValidCidr, isValidIPv4 } from '../utils/validation';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';
import { withTimeout, TimeoutError } from '../utils/withTimeout';
import { buildNodeLabelInventory } from '../services/LabelInventoryService';
import { labelInventoryOptionsFromRequest, requireRevealAdmin } from '../helpers/labelInventoryRequest';
import { requirePermission } from '../middleware/permissions';
import { buildStackNetworkFacts } from '../services/network/composeNetworkInspector';
import { evaluateNetworkDeleteGuard } from '../services/network/networkDeleteGuards';
import { loadNetworkingSnapshot } from '../services/network/networkingAggregate';

// The prune estimate and plan paths are bounded at 12 s. `docker system df`
// cost scales with image-store size (measured ~7.4 s on a 34 GB store), so
// the estimate budget must leave headroom above a single df call. 12 s sits
// strictly below the hub's 15 s AbortSignal.timeout on the fleet estimate
// fetch, keeping the remote 503 the actionable failure instead of a hub-side
// abort. The MonitorService janitor keeps its own 8 s budget
// (JANITOR_TIMEOUT_MS) so Sencho's destructive paths never stack more than
// ~16 s of concurrent daemon pressure with the janitor.
const PRUNE_ESTIMATE_TIMEOUT_MS = 12_000;

function respondDfSlow(res: Response): Response {
  return res.status(503).json({
    error: 'Docker daemon is busy. Please try again in a moment.',
    code: 'docker_df_slow',
  });
}

export const systemMaintenanceRouter = Router();

// 423 Locked is sent when the operator targets the running Sencho container's
// own image / volume / network. The frontend surfaces the `error` string as a
// toast; `kind` is for diagnostics.
function rejectIfSelf(kind: 'image' | 'volume' | 'network', id: string, res: Response): boolean {
  const self = SelfIdentityService.getInstance();
  const matched =
    (kind === 'image' && self.isOwnImage(id)) ||
    (kind === 'volume' && self.isOwnVolume(id)) ||
    (kind === 'network' && self.isOwnNetwork(id));
  if (!matched) return false;
  res.status(423).json({
    error: 'Cannot delete the running Sencho instance',
    kind,
    id,
  });
  return true;
}

systemMaintenanceRouter.get('/orphans', async (req: Request, res: Response) => {
  if (!requirePermission(req, res, 'stack:read')) return;
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
    // Silently drop the running Sencho container if a stale client somehow
    // includes it in the prune set. The Unmanaged tab already filters self
    // out, so this is a belt-and-braces guard.
    const self = SelfIdentityService.getInstance();
    const skippedSelf = (containerIds as string[]).some((id) => self.isOwnContainer(id));
    const safeIds: string[] = (containerIds as string[]).filter((id) => !self.isOwnContainer(id));
    console.log(`[Resources] Prune orphans: ${sanitizeForLog(safeIds.length)} container(s) requested${skippedSelf ? ' (self skipped)' : ''}`);
    const dockerController = DockerController.getInstance(req.nodeId);
    const results = await dockerController.removeContainers(safeIds);
    const succeeded = results.filter((r: { success: boolean }) => r.success).length;
    console.log(`[Resources] Prune orphans completed: ${succeeded}/${sanitizeForLog(safeIds.length)} removed`);
    invalidateNodeCaches(req.nodeId);
    res.json(skippedSelf ? { results, skipped: 'self' } : { results });
  } catch (error) {
    console.error('Failed to prune orphan containers:', error);
    res.status(500).json({ error: 'Failed to prune orphan containers' });
  }
});

function parsePruneTargets(body: {
  target?: unknown;
  targets?: unknown;
}): PruneTarget[] | null {
  if (Array.isArray(body.targets)) {
    if (body.targets.length === 0) return null;
    if (!body.targets.every(isPruneTarget)) return null;
    return body.targets;
  }
  if (isPruneTarget(body.target)) return [body.target];
  return null;
}

function parsePruneScope(scope: unknown): PruneScope {
  return scope === 'managed' ? 'managed' : 'all';
}

// Preview an itemized prune plan (no deletes). Resources confirm dialogs call
// this before enabling the destructive confirm button.
systemMaintenanceRouter.post('/prune/plan', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const targets = parsePruneTargets(req.body as { target?: unknown; targets?: unknown });
    if (!targets) {
      return res.status(400).json({ error: 'Invalid prune target(s)' });
    }
    const pruneScope = parsePruneScope((req.body as { scope?: unknown }).scope);
    const dockerController = DockerController.getInstance(req.nodeId);
    const knownStacks = await FileSystemService.getInstance(req.nodeId).getStacks();
    const isImageHeld = ServiceUpdateRecoveryService.getInstance().buildHeldImagePredicate(req.nodeId);
    const plan = await withTimeout(
      dockerController.buildPrunePlan(targets, pruneScope, knownStacks, req.nodeId, isImageHeld),
      PRUNE_ESTIMATE_TIMEOUT_MS,
      'docker prune plan',
    );
    if (isDebugEnabled()) {
      console.debug('[Resources:debug] Prune plan', {
        scope: pruneScope,
        targets: plan.targets,
        items: plan.items.length,
        reclaimableBytes: plan.reclaimableBytes,
      });
    }
    res.json(plan);
  } catch (error: unknown) {
    if (error instanceof TimeoutError) {
      console.warn('Prune plan: docker enumeration timed out');
      return respondDfSlow(res);
    }
    console.error('Prune plan error:', error);
    res.status(500).json({ error: 'Failed to build prune plan' });
  }
});

systemMaintenanceRouter.post('/prune/system', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  let pruneLockHeld = false;
  try {
    const body = req.body as {
      target?: unknown;
      targets?: unknown;
      scope?: unknown;
      dryRun?: unknown;
      planFingerprint?: unknown;
    };
    const targets = parsePruneTargets(body);
    if (!targets) {
      return res.status(400).json({ error: 'Invalid prune target(s)' });
    }

    const pruneScope = parsePruneScope(body.scope);
    const isDryRun = body.dryRun === true;
    const planFingerprint = typeof body.planFingerprint === 'string' ? body.planFingerprint : null;
    const dockerController = DockerController.getInstance(req.nodeId);
    const knownStacks = await FileSystemService.getInstance(req.nodeId).getStacks();
    const isImageHeld = ServiceUpdateRecoveryService.getInstance().buildHeldImagePredicate(req.nodeId);

    if (isDryRun) {
      // Dry-run returns the same itemized plan shape Resources uses for preview.
      const plan = await withTimeout(
        dockerController.buildPrunePlan(targets, pruneScope, knownStacks, req.nodeId, isImageHeld),
        PRUNE_ESTIMATE_TIMEOUT_MS,
        'docker prune plan',
      );
      if (isDebugEnabled()) {
        console.debug('[Resources:debug] Prune dry-run', {
          targets: plan.targets,
          scope: pruneScope,
          reclaimableBytes: plan.reclaimableBytes,
          items: plan.items.length,
        });
      }
      res.json({
        message: 'Dry run',
        success: true,
        dryRun: true,
        reclaimedBytes: plan.reclaimableBytes,
        ...plan,
      });
      return;
    }

    const pruneLockKey = `bulk-prune:${req.nodeId}`;
    if (activeBulkActions.has(pruneLockKey)) {
      return res.status(409).json({
        error: 'A prune is already running on this node',
        code: 'PRUNE_ALREADY_RUNNING',
      });
    }
    activeBulkActions.add(pruneLockKey);
    pruneLockHeld = true;

    // Fingerprint-bound execute used by Resources and Fleet.
    if (planFingerprint) {
      const built = await withTimeout(
        dockerController.buildPrunePlan(targets, pruneScope, knownStacks, req.nodeId, isImageHeld),
        PRUNE_ESTIMATE_TIMEOUT_MS,
        'docker prune plan',
      );
      if (built.fingerprint !== planFingerprint) {
        return res.status(409).json({
          error: 'Prune plan is stale; refresh and confirm again',
          code: 'PRUNE_PLAN_STALE',
        });
      }
      console.log(
        `[Resources] System prune (plan): ${built.targets.join(',')} (scope: ${pruneScope}, items: ${built.items.length})`,
      );
      const pruneStartedAt = Date.now();
      const result = await dockerController.executePrunePlan(built, knownStacks, isImageHeld);
      console.log(
        `[Resources] System prune completed: reclaimed ${result.reclaimedBytes} bytes, outcomes=${result.outcomes.length}`,
      );
      if (isDebugEnabled()) {
        console.debug('[Resources:debug] System prune (plan)', {
          targets: built.targets,
          scope: pruneScope,
          ms: Date.now() - pruneStartedAt,
          reclaimedBytes: result.reclaimedBytes,
          success: result.success,
        });
      }
      if (result.outcomes.some((outcome) => outcome.status === 'removed')) {
        invalidateNodeCaches(req.nodeId);
      }
      res.json({
        message: 'Prune completed',
        success: result.success,
        reclaimedBytes: result.reclaimedBytes,
        outcomes: result.outcomes,
      });
      return;
    }

    // Legacy single-target path for Fleet (and any caller without a plan).
    if (targets.length > 1) {
      return res.status(400).json({
        error: 'Multi-target prune requires a planFingerprint from POST /system/prune/plan',
      });
    }
    const target = targets[0];
    console.log(`[Resources] System prune: ${sanitizeForLog(target)} (scope: ${pruneScope})`);
    const pruneStartedAt = Date.now();
    let result: { success: boolean; reclaimedBytes: number };
    if (pruneScope === 'managed' && target !== 'containers') {
      result = await dockerController.pruneManagedOnly(
        target as 'images' | 'volumes' | 'networks',
        knownStacks,
        isImageHeld,
      );
    } else if (pruneScope === 'managed' && target === 'containers') {
      // Managed containers must never fall through to system prune. Build and
      // execute an itemized plan for this single target instead.
      const plan = await dockerController.buildPrunePlan(['containers'], 'managed', knownStacks, req.nodeId, isImageHeld);
      result = await dockerController.executePrunePlan(plan, knownStacks, isImageHeld);
    } else {
      result = await dockerController.pruneSystem(target, undefined, isImageHeld);
    }

    console.log(`[Resources] System prune completed: ${sanitizeForLog(target)}, reclaimed ${result.reclaimedBytes} bytes`);
    if (isDebugEnabled()) {
      console.debug('[Resources:debug] System prune', {
        target, scope: pruneScope, ms: Date.now() - pruneStartedAt, reclaimedBytes: result.reclaimedBytes,
      });
    }
    if (target === 'containers') {
      invalidateNodeCaches(req.nodeId);
    }
    res.json({ message: 'Prune completed', ...result });
  } catch (error: unknown) {
    if (error instanceof TimeoutError) {
      console.warn('System prune: docker disk usage timed out');
      return respondDfSlow(res);
    }
    if (error instanceof PrunePlanStaleError) {
      return res.status(409).json({ error: error.message, code: error.code });
    }
    console.error('System prune error:', error);
    res.status(500).json({ error: 'System prune failed' });
  } finally {
    if (pruneLockHeld) activeBulkActions.delete(`bulk-prune:${req.nodeId}`);
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
    // Skip the filesystem walk for all scope: estimateSystemReclaim uses
    // only docker system df and ignores knownStackNames. Mirroring the
    // fleet route's conditional at fleet.ts:2367.
    const knownStacks = pruneScope === 'managed'
      ? await FileSystemService.getInstance(req.nodeId).getStacks()
      : [];

    // Both estimate paths run under the same 12 s budget (F-6). The all-scope
    // fast path uses only `docker system df` via getDiskUsage(); the managed
    // path enumerates stacks but stays within the same bound.
    const estimate = pruneScope === 'managed' && target !== 'containers'
      ? dockerController.estimateManagedReclaim(
          target as 'images' | 'volumes' | 'networks',
          knownStacks,
        )
      : dockerController.estimateSystemReclaim(
          target as 'containers' | 'images' | 'networks' | 'volumes',
          knownStacks,
        );
    const result = await withTimeout(estimate, PRUNE_ESTIMATE_TIMEOUT_MS, 'docker disk usage');
    res.json({ reclaimableBytes: result.reclaimableBytes });
  } catch (error: unknown) {
    if (error instanceof TimeoutError) {
      console.warn('Prune estimate: docker disk usage timed out');
      return respondDfSlow(res);
    }
    console.error('Prune estimate error:', error);
    res.status(500).json({ error: 'Failed to estimate reclaimable bytes' });
  }
});

systemMaintenanceRouter.get('/docker-df', async (req: Request, res: Response) => {
  if (!requirePermission(req, res, 'stack:read')) return;
  try {
    const knownStacks = await FileSystemService.getInstance(req.nodeId).getStacks();
    const df = await DockerController.getInstance(req.nodeId).getDiskUsageClassified(knownStacks);
    res.json(df);
  } catch (error) {
    console.error('Failed to fetch docker disk usage:', error);
    res.status(500).json({ error: 'Failed to fetch docker disk usage' });
  }
});

// Node-wide Docker/Compose label inventory for fleet fan-out and local audit.
systemMaintenanceRouter.get('/container-labels', async (req: Request, res: Response) => {
  if (!requirePermission(req, res, 'node:read')) return;
  if (!requireRevealAdmin(req, res)) return;
  try {
    const inventory = await buildNodeLabelInventory(req.nodeId, labelInventoryOptionsFromRequest(req));
    res.json(inventory);
  } catch (error) {
    console.error('Failed to build container label inventory:', error);
    res.status(500).json({ error: 'Failed to build container label inventory' });
  }
});

systemMaintenanceRouter.get('/resources', async (req: Request, res: Response) => {
  if (!requirePermission(req, res, 'stack:read')) return;
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
  if (!requirePermission(req, res, 'stack:read')) return;
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
  if (!requirePermission(req, res, 'stack:read')) return;
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
  if (!requirePermission(req, res, 'stack:read')) return;
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
  if (!requirePermission(req, res, 'stack:read')) return;
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
    if (typeof id !== 'string') {
      return res.status(400).json({ error: 'Invalid image ID format' });
    }
    // Docker image IDs round-trip as `sha256:<hex>` through /system/images,
    // so the UI and any client that forwards the same value sees the prefixed
    // form. Strip before validation, mirroring the inspect route above.
    const hexId = id.startsWith('sha256:') ? id.slice('sha256:'.length) : id;
    if (!isValidDockerResourceId(hexId)) {
      return res.status(400).json({ error: 'Invalid image ID format' });
    }
    if (rejectIfSelf('image', id, res)) return;
    const dockerController = DockerController.getInstance(req.nodeId);
    // Resolve to the canonical full image ID before the held-image check: the
    // submitted id can be a short/truncated form (isValidDockerResourceId
    // accepts 12-64 hex chars), which a full-64-char held-set lookup would miss.
    const canonicalId = await dockerController.resolveImageId(id);
    if (!canonicalId) {
      return res.status(404).json({ error: 'Image not found' });
    }
    const isImageHeld = buildUnifiedHeldImagePredicate(req.nodeId);
    if (isImageHeld(canonicalId)) {
      return res.status(409).json({
        error: 'Image is held for a pending update rollback and cannot be deleted manually. It is removed automatically once the rollback window expires, or can be released from Resources → Rollback.',
        code: 'IMAGE_HELD_FOR_ROLLBACK',
      });
    }
    console.log(`[Resources] Delete image: ${hexId.substring(0, 12)}`);
    await dockerController.removeImage(canonicalId);
    invalidateNodeCaches(req.nodeId);
    res.json({ success: true, message: 'Image deleted' });
  } catch (error: unknown) {
    console.error('Failed to delete image:', error);
    res.status(500).json({ error: 'Failed to delete image' });
  }
});

// Full-stack rollback generations (the sencho-rb/<id>/<service>:hold images).
// Global read under stack:read, matching the rest of the Docker resource
// inventory on this page (/system/resources, /system/images); release is
// requireAdmin, matching every other host-destructive Docker action here.
systemMaintenanceRouter.get('/rollback/generations', async (req: Request, res: Response) => {
  if (!requirePermission(req, res, 'stack:read')) return;
  try {
    const service = StackUpdateRecoveryService.getInstance();
    const rows = DatabaseService.getInstance()
      .listStackUpdateRecoveryGenerationsForNode(req.nodeId)
      .filter((row) => row.artifacts_retired === 0
        && (row.status === 'active' || row.status === 'restored_current'
          || row.status === 'superseded' || row.status === 'recovery_required'));
    res.json(rows.map((row) => ({
      id: row.id,
      shortId: shortGenerationId(row.id),
      stackName: row.stack_name,
      status: row.status,
      isCurrent: row.is_current === 1,
      phase: row.phase,
      createdAt: row.created_at,
      artifactExpiresAt: row.artifact_expires_at,
      createdBy: row.created_by,
      operationKind: row.operation_kind,
      releasable: service.isReleaseEligible(row),
    })));
  } catch (error) {
    console.error('Failed to fetch rollback generations:', error);
    res.status(500).json({ error: 'Failed to fetch rollback generations' });
  }
});

systemMaintenanceRouter.post('/rollback/generations/:id/release', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const id = req.params.id as string;
    const service = StackUpdateRecoveryService.getInstance();
    const row = service.get(id);
    if (!row || row.node_id !== req.nodeId) {
      return res.status(404).json({ error: 'Rollback generation not found' });
    }
    const result = await service.releaseGeneration(id, req.user?.username ?? null);
    if (!result.ok) {
      switch (result.reason) {
        case 'not_found':
          return res.status(404).json({ error: 'Rollback generation not found' });
        case 'already_released':
          return res.status(409).json({
            error: 'Rollback protection was already released for this generation.',
            code: 'ALREADY_RELEASED',
          });
        case 'not_eligible':
          return res.status(409).json({
            error: 'This rollback generation cannot be released right now (it may be observing a health gate, mid-recovery, or already in progress).',
            code: 'NOT_ELIGIBLE',
          });
        default: {
          const _exhaustive: never = result.reason;
          throw new Error(`Unhandled release reason: ${_exhaustive}`);
        }
      }
    }
    console.log(`[Resources] Released rollback generation ${sanitizeForLog(shortGenerationId(id))} for ${sanitizeForLog(result.row.stack_name)}`);
    invalidateNodeCaches(req.nodeId);
    res.json({
      success: true,
      message: result.artifactsCleaned ? 'Rollback protection released' : 'Rollback protection released; cleanup will finish shortly',
      artifactsCleaned: result.artifactsCleaned,
    });
  } catch (error) {
    console.error('Failed to release rollback generation:', error);
    res.status(500).json({ error: 'Failed to release rollback generation' });
  }
});

systemMaintenanceRouter.post('/volumes/delete', async (req: Request, res: Response) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { id } = req.body;
    if (!id || typeof id !== 'string') return res.status(400).json({ error: 'Volume name is required' });
    if (rejectIfSelf('volume', id, res)) return;
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
    if (rejectIfSelf('network', id, res)) return;

    const { stacks, snapshot } = await loadNetworkingSnapshot(req.nodeId);
    if (!snapshot) {
      return res.status(503).json({ error: 'Docker networking runtime is unavailable' });
    }
    const stackFacts = await Promise.all(
      stacks.map(stack => buildStackNetworkFacts(req.nodeId, stack, snapshot)),
    );
    const baseRow = DockerController.classifySnapshotNetworks(snapshot, stacks)
      .find(n => n.id === id);
    const guard = evaluateNetworkDeleteGuard(id, snapshot, stackFacts, baseRow);
    if (guard.blocked) {
      return res.status(409).json({ error: guard.error, code: guard.code });
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
  if (!requirePermission(req, res, 'node:read')) return;
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
  if (!requirePermission(req, res, 'node:read')) return;
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
    if (isDebugEnabled()) {
      console.debug('[Resources:debug] Network create', {
        driver: options.Driver ?? 'bridge',
        internal: !!options.Internal,
        attachable: !!options.Attachable,
        hasSubnet: !!subnet,
        hasGateway: !!gateway,
      });
    }
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
