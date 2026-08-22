import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import DockerController from '../services/DockerController';
import { DatabaseService } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';
import { CacheService } from '../services/CacheService';
import {
  createAutoUpdateDigestGateState,
  messageWhenDigestApplyBlockedByCheckErrors,
  messageWhenNoDigestUpdate,
  recordAutoUpdateImageCheck,
} from '../helpers/autoUpdateDigestGate';
import { ImageUpdateService, UPDATE_VERIFICATION_INCOMPLETE_WARNING } from '../services/ImageUpdateService';
import { FileSystemService } from '../services/FileSystemService';
import { StackUpdateOrchestrator } from '../services/StackUpdateOrchestrator';
import { StackOpLockService, stackOpSkipMessage } from '../services/StackOpLockService';
import { NotificationService } from '../services/NotificationService';
import { enforcePolicyPreDeploy } from '../services/PolicyEnforcement';
import { HealthGateService } from '../services/HealthGateService';
import { authMiddleware } from '../middleware/auth';
import { checkPermission, requirePermission, type PermissionAction } from '../middleware/permissions';
import { buildPolicyGateOptions } from '../helpers/policyGate';
import { FLEET_UPDATE_CACHE_KEY, invalidateFleetUpdateCache } from '../helpers/fleetUpdateCache';
import { invalidateNodeCaches } from '../helpers/cacheInvalidation';
import { summarizeBlockReasons } from '../utils/policy-risk';
import { isValidStackName } from '../utils/validation';
import { sanitizeForLog } from '../utils/safeLog';
import { logDebugTiming } from '../utils/requestTiming';
import { getErrorMessage } from '../utils/errors';

// Fleet aggregation cache: 2-minute TTL, shared across dashboard tabs.
const FLEET_CACHE_TTL = 120_000;
const REMOTE_NODE_FETCH_TIMEOUT_MS = 5000;

export const imageUpdatesRouter = Router();

imageUpdatesRouter.get('/', authMiddleware, (req: Request, res: Response): void => {
  try {
    // Confirmed-only: partial/failed retained has_update rows stay out of the
    // boolean map so Fleet and node cards do not treat uncertainty as pending.
    const updates = DatabaseService.getInstance().getConfirmedStackUpdateStatus(req.nodeId);
    res.json(updates);
  } catch (error) {
    console.error('Failed to fetch image update status:', error);
    res.status(500).json({ error: 'Failed to fetch image update status' });
  }
});

// Rich per-stack status (hasUpdate + check outcome + reason) for the sidebar and
// readiness view. Auth-only, matching GET /; the boolean GET / is left intact so
// the cross-version fleet aggregation contract is unaffected.
imageUpdatesRouter.get('/detail', authMiddleware, (req: Request, res: Response): void => {
  const startedAt = Date.now();
  let outcome: 'ok' | 'error' = 'ok';
  let count = 0;
  try {
    const nodeId = req.nodeId ?? NodeRegistry.getInstance().getDefaultNodeId();
    const detail = DatabaseService.getInstance().getStackUpdateDetail(nodeId);
    count = Object.keys(detail).length;
    res.json(detail);
  } catch (error) {
    outcome = 'error';
    console.error('Failed to fetch image update detail:', error);
    res.status(500).json({ error: 'Failed to fetch image update detail' });
  } finally {
    logDebugTiming('[ImageUpdates:debug]', {
      route: 'GET /detail',
      nodeId: req.nodeId,
      count,
      elapsedMs: Date.now() - startedAt,
      outcome,
    });
  }
});

imageUpdatesRouter.post('/refresh', authMiddleware, (req: Request, res: Response): void => {
  if (!requirePermission(req, res, 'node:manage', 'node', String(req.nodeId ?? 0))) return;
  try {
    if (!ImageUpdateService.isChecksEnabled()) {
      res.status(409).json({
        enabled: false,
        error: 'Image update detection is disabled for this node.',
      });
      return;
    }
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

// Per-stack manual recheck, distinct from the node-wide /refresh above. Reuses
// the same registry probe ImageUpdateService runs after an applied update.
imageUpdatesRouter.post('/refresh/:stackName', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const stackName = req.params.stackName as string;
  if (!isValidStackName(stackName)) {
    res.status(400).json({ error: 'Invalid stack name' });
    return;
  }
  if (!requirePermission(req, res, 'stack:deploy', 'stack', stackName)) return;
  try {
    if (!ImageUpdateService.isChecksEnabled()) {
      res.status(409).json({
        enabled: false,
        error: 'Image update detection is disabled for this node.',
      });
      return;
    }
    const iu = ImageUpdateService.getInstance();
    if (!iu.tryMarkStackRecheck(req.nodeId, stackName)) {
      const remainingMs = iu.getStackRecheckCooldownRemainingMs(req.nodeId, stackName);
      const remainingSec = Math.ceil(remainingMs / 1000);
      res.status(429).json({
        error: `Per-stack check was started too recently. Please wait ${remainingSec} second${remainingSec !== 1 ? 's' : ''}.`,
      });
      return;
    }
    const result = await iu.recheckStack(req.nodeId, stackName);
    res.json(result);
  } catch (error) {
    console.error('Failed to recheck stack for image updates:', error);
    res.status(500).json({ error: 'Failed to recheck stack for image updates' });
  }
});

imageUpdatesRouter.get('/status', authMiddleware, (req: Request, res: Response): void => {
  const startedAt = Date.now();
  let outcome: 'ok' | 'error' = 'ok';
  try {
    res.json(ImageUpdateService.getInstance().getStatus());
  } catch (error) {
    outcome = 'error';
    console.error('Failed to fetch image update status:', error);
    res.status(500).json({ error: 'Failed to fetch image update status' });
  } finally {
    logDebugTiming('[ImageUpdates:debug]', {
      route: 'GET /status',
      nodeId: req.nodeId,
      elapsedMs: Date.now() - startedAt,
      outcome,
    });
  }
});

/**
 * Validate a cron expression using the same contract as Scheduled Operations:
 * non-empty, reject 6+ fields, parse with CronExpressionParser, and prove
 * .next() can produce a future fire time. Nicknames like @daily are accepted.
 */
function validateImageCheckCron(cron: unknown): string | null {
  if (typeof cron !== 'string' || !cron.trim()) {
    return 'Cron expression is required.';
  }
  if (cron.trim().split(/\s+/).length >= 6) {
    return 'Cron expression must use 5 fields (minute hour day month weekday). The seconds field is not supported.';
  }
  try {
    const expr = CronExpressionParser.parse(cron);
    expr.next(); // prove the expression can produce a next fire time
  } catch {
    return 'Invalid cron expression.';
  }
  return null;
}

// Min/max mirror ImageUpdateService's clamp; the service is the authority and
// re-clamps on read, so this is the user-facing validation boundary.
const IntervalPatchSchema = z.object({
  minutes: z.coerce.number().int().min(15).max(1440),
  mode: z.enum(['interval', 'cron']).optional(),
  cron: z.string().optional(),
});

imageUpdatesRouter.put('/interval', authMiddleware, (req: Request, res: Response): void => {
  if (!requirePermission(req, res, 'system:settings')) return;
  const parsed = IntervalPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'minutes must be an integer between 15 and 1440' });
    return;
  }

  // Validate cron expression when mode is 'cron'.
  if (parsed.data.mode === 'cron') {
    const cronError = validateImageCheckCron(parsed.data.cron);
    if (cronError) {
      res.status(400).json({ error: cronError });
      return;
    }
  }

  try {
    const db = DatabaseService.getInstance();
    const writeSettings = db.getDb().transaction((entries: [string, string][]) => {
      for (const [k, v] of entries) db.updateGlobalSetting(k, v);
    });
    const entries: [string, string][] = [
      ['image_update_check_interval_minutes', String(parsed.data.minutes)],
    ];
    if (parsed.data.mode !== undefined) {
      entries.push(['image_update_check_mode', parsed.data.mode]);
    }
    if (parsed.data.mode === 'cron' && parsed.data.cron !== undefined) {
      entries.push(['image_update_check_cron', parsed.data.cron]);
    } else if (parsed.data.mode === 'interval') {
      entries.push(['image_update_check_cron', '']); // clear stale cron
    }
    writeSettings(entries);
    // Reschedule the live timer so the new cadence takes effect without a restart.
    ImageUpdateService.getInstance().restartPolling();
    res.json(ImageUpdateService.getInstance().getStatus());
  } catch (error) {
    console.error('Failed to update image-update interval:', error);
    res.status(500).json({ error: 'Failed to update interval' });
  }
});

const EnabledPatchSchema = z.object({
  enabled: z.boolean(),
});

imageUpdatesRouter.put('/enabled', authMiddleware, (req: Request, res: Response): void => {
  if (!requirePermission(req, res, 'system:settings')) return;
  const parsed = EnabledPatchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'enabled must be a boolean' });
    return;
  }
  try {
    const status = ImageUpdateService.getInstance().applyChecksEnabled(parsed.data.enabled);
    res.json(status);
  } catch (error) {
    console.error('Failed to update image-update checks enabled:', error);
    res.status(500).json({ error: 'Failed to update image update checks setting' });
  }
});

imageUpdatesRouter.get('/fleet', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await CacheService.getInstance().getOrFetch<Record<number, Record<string, boolean>>>(
      FLEET_UPDATE_CACHE_KEY,
      FLEET_CACHE_TTL,
      async () => {
        const db = DatabaseService.getInstance();
        const nodes = db.getNodes();
        const nr = NodeRegistry.getInstance();
        const data: Record<number, Record<string, boolean>> = {};

        // Local nodes: synchronous DB reads (confirmed-only projection).
        for (const node of nodes) {
          if (node.type === 'local') {
            data[node.id] = db.getConfirmedStackUpdateStatus(node.id);
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
  if (!requirePermission(_req, res, 'node:manage')) return;

  const db = DatabaseService.getInstance();
  const nodes = db.getNodes();
  const nr = NodeRegistry.getInstance();
  const triggered: number[] = [];
  const rateLimited: number[] = [];
  const failed: number[] = [];
  const disabled: number[] = [];

  // ImageUpdateService is a per-instance singleton, so the local node's manual
  // refresh fires at most once per request regardless of how many local rows
  // exist in the schema.
  const localNode = nodes.find(n => n.type === 'local');
  if (localNode) {
    try {
      if (!ImageUpdateService.isChecksEnabled()) {
        disabled.push(localNode.id);
      } else if (ImageUpdateService.getInstance().triggerManualRefresh()) {
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
    } else if (status === 409) {
      disabled.push(nodeId);
    } else if (status === 429) {
      rateLimited.push(nodeId);
    } else {
      failed.push(nodeId);
    }
  }

  invalidateFleetUpdateCache();
  res.json({ triggered, rateLimited, failed, disabled });
});

/**
 * Execute auto-update for a single stack (or for every stack on the local
 * node when target="*"). This runs on whichever Sencho instance receives
 * the request; the gateway scheduler proxies to remote nodes via HTTP.
 */
export const autoUpdateRouter = Router();

/**
 * Deny the whole request on the first stack that fails `action`, writing the
 * 403 itself. Used to pre-check every resolved target before any auto-update
 * work starts, so a denied stack in a bulk request never leaves partial work
 * behind.
 */
function requireExactStacks(
  req: Request,
  res: Response,
  action: PermissionAction,
  stackNames: Iterable<string>,
  nodeId: number,
): boolean {
  for (const stackName of stackNames) {
    if (!checkPermission(req, action, 'stack', stackName, nodeId)) {
      res.status(403).json({ error: 'Permission denied.', code: 'PERMISSION_DENIED' });
      return false;
    }
  }
  return true;
}

autoUpdateRouter.post('/execute', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { target, targets } = req.body as { target?: string; targets?: unknown };

    let stackNames: string[];
    if (Array.isArray(targets)) {
      if (targets.length === 0) {
        res.status(400).json({ error: '"targets" must be a non-empty array of stack names' });
        return;
      }
      if (targets.length > 500) {
        res.status(400).json({ error: '"targets" accepts at most 500 stack names' });
        return;
      }
      if (!targets.every((t): t is string => typeof t === 'string' && isValidStackName(t))) {
        res.status(400).json({ error: 'Invalid stack name in targets' });
        return;
      }
      // Deduplicate while preserving order.
      const seen = new Set<string>();
      stackNames = [];
      for (const name of targets) {
        if (seen.has(name)) continue;
        seen.add(name);
        stackNames.push(name);
      }
      console.log(`[AutoUpdate] Execute requested: targets=${stackNames.length}`);
    } else if (typeof target === 'string' && target.length > 0) {
      console.log(`[AutoUpdate] Execute requested: target="${sanitizeForLog(target)}"`);
      if (target === '*') {
        // The wildcard expands to every stack on the node, including a set
        // this handler cannot enumerate permission against ahead of time
        // when it turns out to be empty. Require global stack:deploy rather
        // than a scoped grant, so an unauthorized caller cannot reach the
        // "no stacks found" no-op without ever being permission-checked.
        if (!requirePermission(req, res, 'stack:deploy')) return;
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
    } else {
      res.status(400).json({ error: 'Missing "target" (stack name or "*") or "targets" (stack name array)' });
      return;
    }

    // Pre-check every resolved target before any work starts: a denied stack
    // anywhere in the set (including a "*" expansion) fails the whole request
    // rather than running some stacks and skipping others. Permission is
    // evaluated unconditionally, before the node's checks-enabled setting is
    // even consulted, so a disabled node never gives an unauthorized caller
    // a free pass.
    if (!requireExactStacks(req, res, 'stack:deploy', stackNames, req.nodeId)) return;

    // Honor the node-scoped image-update detection opt-out, now that every
    // resolved target has cleared the permission gate above.
    if (!ImageUpdateService.isChecksEnabled()) {
      res.json({ result: 'Image update detection is disabled for this node; skipped.' });
      return;
    }

    const docker = DockerController.getInstance(req.nodeId);
    const imageUpdateService = ImageUpdateService.getInstance();
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

        const gate = createAutoUpdateDigestGateState();
        for (const imageRef of imageRefs) {
          try {
            const result = await imageUpdateService.checkImage(docker, imageRef);
            recordAutoUpdateImageCheck(gate, imageRef, result);
          } catch (e) {
            const errMsg = getErrorMessage(e, String(e));
            gate.checkErrors.push(errMsg);
            console.warn('[AutoUpdate] Failed to check image %s:', sanitizeForLog(imageRef), sanitizeForLog((e as Error)?.message ?? String(e)));
          }
        }

        if (!gate.hasDigestUpdate) {
          results.push(messageWhenNoDigestUpdate(stackName, gate, imageRefs.length));
          continue;
        }
        const checkErrorBlock = messageWhenDigestApplyBlockedByCheckErrors(stackName, gate);
        if (checkErrorBlock) {
          results.push(checkErrorBlock);
          continue;
        }

        const { updatedImages } = gate;

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
          const blockedMsg = `Policy "${autoUpdateGate.policy?.name}" blocked auto-update: ${autoUpdateGate.violations.length} image(s) matched ${summarizeBlockReasons(autoUpdateGate.violations)}${blockedImages ? ` (${blockedImages})` : ''}`;
          NotificationService.getInstance().dispatchAlert('warning', 'scan_finding', blockedMsg, { stackName, actor: 'system:image-update' });
          results.push(`Stack "${stackName}": ${blockedMsg}`);
          continue;
        }

        const lock = await StackOpLockService.getInstance().runExclusive(
          req.nodeId, stackName, 'update', 'system',
          () => StackUpdateOrchestrator.getInstance().execute(
            { nodeId: req.nodeId, stackName, target: { scope: 'stack' }, trigger: 'automatic', actor: `auto-update:${req.user?.username ?? 'scheduler'}` },
            { atomic, terminalWs: null },
          ),
        );
        if (!lock.ran) {
          results.push(stackOpSkipMessage(stackName, lock.existing.action));
          continue;
        }

        // Health observation starts immediately after Compose; registry recheck is
        // isolated so a verification failure cannot turn Compose success into a failure.
        const orchResult = lock.result;
        const healthGateId = HealthGateService.getInstance().beginStack(req.nodeId, stackName, 'update', `auto-update:${req.user?.username ?? 'scheduler'}`, { deployedGenerationId: orchResult && orchResult.kind === 'stack_compose_done' ? orchResult.deployedGenerationId : null });
        const recoveryId = orchResult && orchResult.kind === 'stack_compose_done' ? orchResult.recoveryId : null;
        if (recoveryId) {
          const { StackUpdateRecoveryService } = await import('../services/StackUpdateRecoveryService');
          StackUpdateRecoveryService.getInstance().linkGateOrRetain(recoveryId, healthGateId);
        }

        // Recheck persists digest-cleared / tag-advisory state. Do not blind-clear.
        let recheckWarning: string | undefined;
        try {
          const recheck = await imageUpdateService.recheckStack(req.nodeId, stackName);
          if (recheck.warning) recheckWarning = recheck.warning;
        } catch (recheckErr) {
          console.warn(
            '[AutoUpdate] Post-update recheck failed for %s: %s',
            sanitizeForLog(stackName),
            sanitizeForLog(getErrorMessage(recheckErr, 'unknown')),
          );
          recheckWarning = UPDATE_VERIFICATION_INCOMPLETE_WARNING;
        }

        invalidateNodeCaches(req.nodeId);
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

        const base = `Stack "${stackName}": updated (${updatedImages.join(', ')}).`;
        results.push(recheckWarning ? `${base} ${recheckWarning}` : base);
      } catch (e) {
        const msg = getErrorMessage(e, String(e));
        results.push(`Stack "${stackName}" failed: ${msg}`);
        console.error(
          '[AutoUpdate] Failed for stack %s: %s',
          sanitizeForLog(stackName),
          sanitizeForLog(msg),
        );
      }
    }

    invalidateFleetUpdateCache();
    res.json({ result: results.join('\n') });
  } catch (error) {
    const msg = getErrorMessage(error, 'Auto-update execution failed');
    console.error('[AutoUpdate] Execute error:', msg);
    res.status(500).json({ error: msg });
  }
});
