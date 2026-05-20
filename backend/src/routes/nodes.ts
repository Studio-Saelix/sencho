import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { authMiddleware } from '../middleware/auth';
import { requirePermission } from '../middleware/permissions';
import { rejectApiTokenScope } from '../middleware/apiTokenScope';
import { requireAdmin, requireAdmiral, requirePaid } from '../middleware/tierGates';
import { enrollmentLimiter } from '../middleware/rateLimiters';
import { DatabaseService } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';
import { CacheService } from '../services/CacheService';
import { REMOTE_META_NAMESPACE } from '../helpers/cacheInvalidation';
import { CAPABILITIES, getSenchoVersion, type RemoteMeta } from '../services/CapabilityRegistry';
import { PilotTunnelManager } from '../services/PilotTunnelManager';
import { PilotCloseCode } from '../pilot/protocol';
import { MeshProxyTunnelDialer } from '../services/MeshProxyTunnelDialer';
import { FleetUpdateTrackerService } from '../services/FleetUpdateTrackerService';
import { FleetSyncService } from '../services/FleetSyncService';
import { isValidRemoteUrl } from '../utils/validation';
import { getErrorMessage } from '../utils/errors';

const NODE_SCOPE_MESSAGE = 'API tokens cannot manage nodes.';
const REMOTE_META_CACHE_TTL = 3 * 60 * 1000;

/**
 * Pick the URL the pilot agent should dial. SENCHO_PUBLIC_URL wins when set
 * and well-formed, because the request Host header is only reachable from
 * the network the operator opened the dialog from. Pilots on a public cloud
 * cannot dial a LAN or loopback address, so an explicit public URL is the
 * only thing that lets the enrolled YAML work unmodified.
 */
function resolvePrimaryUrl(req: Request): string {
  const override = process.env.SENCHO_PUBLIC_URL?.trim();
  if (override) {
    const check = isValidRemoteUrl(override);
    if (check.valid) return override.replace(/\/$/, '');
    console.warn(`[Enrollment] SENCHO_PUBLIC_URL is set but invalid (${check.reason}); falling back to request host.`);
  }
  const forwardedProto = req.headers['x-forwarded-proto'];
  const protoHeader = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const protocol = protoHeader || req.protocol || 'http';
  const host = req.get('host') || 'localhost:1852';
  return `${protocol}://${host}`;
}

function mintPilotEnrollment(nodeId: number, req: Request): { token: string; expiresAt: number; composeYaml: string } {
  const db = DatabaseService.getInstance();
  const jwtSecret = db.getGlobalSettings().auth_jwt_secret;
  if (!jwtSecret) throw new Error('JWT secret not configured');

  const ttlSeconds = 15 * 60;
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const enrollNonce = crypto.randomUUID();
  const token = jwt.sign(
    { scope: 'pilot_enroll', nodeId, enrollNonce },
    jwtSecret,
    { expiresIn: ttlSeconds },
  );
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  db.createPilotEnrollment(nodeId, tokenHash, expiresAt);

  const primaryUrl = resolvePrimaryUrl(req);

  // Top-level `name` plus `container_name` make the agent container's HOSTNAME
  // equal to `sencho-agent`, which is how SelfUpdateService locates its own
  // compose context to enable remote self-update.
  const composeYaml = [
    `name: sencho-agent`,
    `services:`,
    `  agent:`,
    `    image: saelix/sencho:latest`,
    `    container_name: sencho-agent`,
    `    restart: unless-stopped`,
    `    volumes:`,
    `      - /var/run/docker.sock:/var/run/docker.sock`,
    `      - sencho-agent-data:/app/data`,
    `      - /opt/docker/sencho:/app/compose`,
    `    environment:`,
    `      SENCHO_MODE: pilot`,
    `      SENCHO_PRIMARY_URL: ${primaryUrl}`,
    `      SENCHO_ENROLL_TOKEN: ${token}`,
    ``,
    `volumes:`,
    `  sencho-agent-data:`,
    ``,
  ].join('\n');

  return { token, expiresAt, composeYaml };
}

export const nodesRouter = Router();

nodesRouter.get('/', async (req: Request, res: Response) => {
  try {
    const nodes = DatabaseService.getInstance().getNodes();
    res.json(nodes);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch nodes' });
  }
});

nodesRouter.get('/scheduling-summary', authMiddleware, (_req: Request, res: Response) => {
  try {
    const db = DatabaseService.getInstance();
    const scheduleSummary = db.getNodeSchedulingSummary();
    const updateSummary = db.getNodeUpdateSummary();

    const result: Record<number, {
      active_tasks: number;
      auto_update_enabled: boolean;
      next_run_at: number | null;
      stacks_with_updates: number;
    }> = {};

    for (const s of scheduleSummary) {
      result[s.node_id] = {
        active_tasks: s.active_tasks,
        auto_update_enabled: s.auto_update_enabled === 1,
        next_run_at: s.next_run_at,
        stacks_with_updates: 0,
      };
    }
    for (const u of updateSummary) {
      if (result[u.node_id]) {
        result[u.node_id].stacks_with_updates = u.stacks_with_updates;
      } else {
        result[u.node_id] = {
          active_tasks: 0,
          auto_update_enabled: false,
          next_run_at: null,
          stacks_with_updates: u.stacks_with_updates,
        };
      }
    }

    res.json(result);
  } catch (error) {
    console.error('Failed to fetch node scheduling summary:', error);
    res.status(500).json({ error: 'Failed to fetch node scheduling summary' });
  }
});

nodesRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    const node = DatabaseService.getInstance().getNode(id);
    if (!node) {
      return res.status(404).json({ error: 'Node not found' });
    }
    res.json(node);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch node' });
  }
});

nodesRouter.post('/', enrollmentLimiter, async (req: Request, res: Response) => {
  if (rejectApiTokenScope(req, res, NODE_SCOPE_MESSAGE)) return;
  if (!requirePermission(req, res, 'node:manage')) return;
  try {
    const { name, type, compose_dir, is_default, api_url, api_token, mode } = req.body;

    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Node name is required' });
    }
    if (!type || !['local', 'remote'].includes(type)) {
      return res.status(400).json({ error: 'Node type must be "local" or "remote"' });
    }

    const resolvedMode: 'proxy' | 'pilot_agent' = type === 'remote' && mode === 'pilot_agent' ? 'pilot_agent' : 'proxy';

    if (type === 'remote' && resolvedMode === 'proxy') {
      if (!api_url || typeof api_url !== 'string') {
        return res.status(400).json({ error: 'API URL is required for proxy-mode remote nodes' });
      }
      const urlCheck = isValidRemoteUrl(api_url);
      if (!urlCheck.valid) {
        return res.status(400).json({ error: urlCheck.reason });
      }
    }

    const id = DatabaseService.getInstance().addNode({
      name,
      type,
      compose_dir: compose_dir || '/app/compose',
      is_default: is_default || false,
      api_url: resolvedMode === 'pilot_agent' ? '' : (api_url || ''),
      api_token: resolvedMode === 'pilot_agent' ? '' : (api_token || ''),
      mode: resolvedMode,
    });

    NodeRegistry.getInstance().notifyNodeAdded(id);

    // Backfill replicated security state on the new remote so an operator who
    // adds a node mid-life does not have to wait for the next policy edit
    // before scan_policies and cve_suppressions land. No-op for local nodes
    // and pilot-agent nodes (FleetSyncService.pushResource filters them out).
    if (type === 'remote' && resolvedMode === 'proxy') {
      FleetSyncService.getInstance().pushResourceAsync('scan_policies');
      FleetSyncService.getInstance().pushResourceAsync('cve_suppressions');
    }

    let enrollment: ReturnType<typeof mintPilotEnrollment> | null = null;
    if (resolvedMode === 'pilot_agent') {
      enrollment = mintPilotEnrollment(id, req);
    }

    const isPlainHttp = resolvedMode === 'proxy' && type === 'remote' && api_url && api_url.startsWith('http://');
    res.json({
      success: true,
      id,
      ...(enrollment && { enrollment }),
      ...(isPlainHttp && {
        warning: 'This node uses plain HTTP. Use HTTPS or a VPN for connections over the public internet.'
      })
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('UNIQUE constraint')) {
      return res.status(409).json({ error: 'A node with that name already exists' });
    }
    console.error('Failed to create node:', error);
    res.status(500).json({ error: message || 'Failed to create node' });
  }
});

nodesRouter.post('/:id/pilot/enroll', enrollmentLimiter, async (req: Request, res: Response) => {
  if (rejectApiTokenScope(req, res, NODE_SCOPE_MESSAGE)) return;
  const nodeIdStr = req.params.id as string;
  if (!requirePermission(req, res, 'node:manage', 'node', nodeIdStr)) return;
  try {
    const nodeId = parseInt(nodeIdStr, 10);
    if (!Number.isFinite(nodeId)) {
      return res.status(400).json({ error: 'Invalid node id' });
    }
    const node = DatabaseService.getInstance().getNode(nodeId);
    if (!node) return res.status(404).json({ error: 'Node not found' });
    if (node.type !== 'remote' || node.mode !== 'pilot_agent') {
      return res.status(400).json({ error: 'Enrollment only applies to pilot-agent nodes' });
    }
    PilotTunnelManager.getInstance().closeTunnel(nodeId, PilotCloseCode.EnrollmentRegenerated, 'enrollment regenerated');
    const enrollment = mintPilotEnrollment(nodeId, req);
    res.json({ success: true, enrollment });
  } catch (error: unknown) {
    console.error('Failed to regenerate pilot enrollment:', error);
    const message = error instanceof Error ? error.message : 'Failed to regenerate enrollment';
    res.status(500).json({ error: message });
  }
});

nodesRouter.put('/:id', async (req: Request, res: Response) => {
  if (rejectApiTokenScope(req, res, NODE_SCOPE_MESSAGE)) return;
  const nodeId = req.params.id as string;
  if (!requirePermission(req, res, 'node:manage', 'node', nodeId)) return;
  try {
    const id = parseInt(nodeId);
    const updates = req.body;

    const existingNode = DatabaseService.getInstance().getNode(id);
    if (!existingNode) {
      return res.status(404).json({ error: 'Node not found' });
    }

    if (updates.api_url !== undefined && updates.api_url !== '') {
      const urlCheck = isValidRemoteUrl(updates.api_url);
      if (!urlCheck.valid) {
        return res.status(400).json({ error: urlCheck.reason });
      }
    }

    DatabaseService.getInstance().updateNode(id, updates);

    NodeRegistry.getInstance().evictConnection(id);
    NodeRegistry.getInstance().notifyNodeUpdated(id);

    // Trigger 2: if the api_token was rotated on a mesh-enabled proxy-mode
    // remote, close the existing callback bridge and re-dial. The next
    // ensureBridge mints a JWT with the fresh token fingerprint so the
    // remote's tunnel auth gate accepts the upgrade. Gate on actual value
    // change so a Save that only edits name / compose_dir does not cycle
    // the bridge (the frontend sends the full formData on every Save).
    const tokenChanged =
      typeof updates.api_token === 'string' &&
      updates.api_token !== existingNode.api_token;
    if (tokenChanged) {
      const meshEnabled = DatabaseService.getInstance().getNodeMeshEnabled(id);
      if (existingNode.type === 'remote' && existingNode.mode === 'proxy' && meshEnabled) {
        MeshProxyTunnelDialer.getInstance().closeBridge(id, 'peer token rotated');
        void MeshProxyTunnelDialer.getInstance().ensureBridge(id).catch((err) => {
          console.warn(`[Mesh] proactive re-bootstrap on token rotation failed for node ${id}: ${(err as Error).message}`);
        });
      }
    }

    const isPlainHttp = updates.api_url && updates.api_url.startsWith('http://');
    res.json({
      success: true,
      ...(isPlainHttp && {
        warning: 'This node uses plain HTTP. Use HTTPS or a VPN for connections over the public internet.'
      })
    });
  } catch (error: unknown) {
    console.error('Failed to update node:', error);
    const message = error instanceof Error ? error.message : 'Failed to update node';
    res.status(500).json({ error: message });
  }
});

nodesRouter.delete('/:id', async (req: Request, res: Response) => {
  if (rejectApiTokenScope(req, res, NODE_SCOPE_MESSAGE)) return;
  const nodeIdParam = req.params.id as string;
  if (!requirePermission(req, res, 'node:manage', 'node', nodeIdParam)) return;
  try {
    const id = parseInt(nodeIdParam);
    DatabaseService.getInstance().deleteNode(id);
    NodeRegistry.getInstance().evictConnection(id);
    NodeRegistry.getInstance().notifyNodeRemoved(id);
    CacheService.getInstance().invalidate(`${REMOTE_META_NAMESPACE}:${id}`);
    FleetUpdateTrackerService.getInstance().delete(id);
    res.json({ success: true });
  } catch (error: unknown) {
    console.error('Failed to delete node:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to delete node' });
  }
});

nodesRouter.post('/:id/cordon', (req: Request, res: Response) => {
  if (rejectApiTokenScope(req, res, NODE_SCOPE_MESSAGE)) return;
  const nodeIdParam = req.params.id as string;
  if (!requirePermission(req, res, 'node:manage', 'node', nodeIdParam)) return;
  if (!requireAdmiral(req, res)) return;
  const id = parseInt(nodeIdParam, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid node id' });
    return;
  }
  const rawReason = (req.body && typeof req.body === 'object') ? (req.body as { reason?: unknown }).reason : undefined;
  let reason: string | null = null;
  if (rawReason !== undefined && rawReason !== null) {
    if (typeof rawReason !== 'string') {
      res.status(400).json({ error: 'reason must be a string' });
      return;
    }
    const trimmed = rawReason.trim();
    if (trimmed.length > 256) {
      res.status(400).json({ error: 'reason must be 256 characters or fewer' });
      return;
    }
    reason = trimmed.length > 0 ? trimmed : null;
  }
  try {
    const existing = DatabaseService.getInstance().getNode(id);
    if (!existing) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }
    const updated = DatabaseService.getInstance().setNodeCordoned(id, true, reason);
    res.set('cache-control', 'no-store').json(updated);
  } catch (error: unknown) {
    console.error('Failed to cordon node:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to cordon node' });
  }
});

nodesRouter.post('/:id/uncordon', (req: Request, res: Response) => {
  if (rejectApiTokenScope(req, res, NODE_SCOPE_MESSAGE)) return;
  const nodeIdParam = req.params.id as string;
  if (!requirePermission(req, res, 'node:manage', 'node', nodeIdParam)) return;
  if (!requireAdmiral(req, res)) return;
  const id = parseInt(nodeIdParam, 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid node id' });
    return;
  }
  try {
    const existing = DatabaseService.getInstance().getNode(id);
    if (!existing) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }
    const updated = DatabaseService.getInstance().setNodeCordoned(id, false, null);
    res.set('cache-control', 'no-store').json(updated);
  } catch (error: unknown) {
    console.error('Failed to uncordon node:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to uncordon node' });
  }
});

/**
 * Reset the FleetSync control anchor on a remote peer.
 *
 * Proxies POST /api/fleet/role/reanchor to the peer using its stored
 * Bearer token. A successful reanchor clears every sticky-error row for
 * this node so the next push (event-driven or via the 5-minute retry
 * service) re-attempts cleanly and the peer accepts the central's
 * fingerprint as the new anchor.
 *
 * Surfaces UI affordance for the F-16 audit (mesh-e2e-2026-05-17.md):
 * when a peer was previously enrolled by a different central, FleetSync
 * keeps 409'ing every reconcile tick; the sticky flag halts retries and
 * this endpoint is the single one-click recovery for the operator.
 */
nodesRouter.post('/:id/fleet-sync/reset-anchor', async (req: Request, res: Response) => {
  if (rejectApiTokenScope(req, res, NODE_SCOPE_MESSAGE)) return;
  const nodeIdParam = req.params.id as string;
  if (!requirePermission(req, res, 'node:manage', 'node', nodeIdParam)) return;
  if (!requirePaid(req, res)) return;
  // Reset-anchor is symmetric with `/api/fleet/sync-status` (admin-only).
  // Keeping read and write gated at the same role avoids a banner-invisible-to-the-actor
  // gap where a node-admin could call reset without ever seeing why.
  if (!requireAdmin(req, res)) return;
  try {
    const id = parseInt(nodeIdParam, 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid node id' });
      return;
    }
    const node = DatabaseService.getInstance().getNode(id);
    if (!node) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }
    if (node.type !== 'remote' || node.mode !== 'proxy') {
      res.status(400).json({ error: 'Reset anchor only applies to proxy-mode remote nodes' });
      return;
    }
    if (!node.api_url || !node.api_token) {
      res.status(400).json({ error: 'Node is missing api_url or api_token' });
      return;
    }

    const baseUrl = node.api_url.replace(/\/$/, '');
    let peerResponse: globalThis.Response;
    try {
      peerResponse = await fetch(`${baseUrl}/api/fleet/role/reanchor`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${node.api_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ override: true }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (networkErr) {
      const message = getErrorMessage(networkErr, 'Failed to reach peer');
      console.warn(`[Nodes] Reset anchor unreachable for node ${id}: ${message}`);
      res.status(504).json({ error: `Peer unreachable: ${message}` });
      return;
    }

    if (!peerResponse.ok) {
      const status = peerResponse.status;
      const body = await peerResponse.json().catch(() => ({}));
      const peerError = (body as { error?: string })?.error
        ?? `Peer returned HTTP ${status}`;
      if (status === 401 || status === 403) {
        console.warn(`[Nodes] Reset anchor rejected by peer ${id}: ${peerError}`);
        res.status(502).json({
          error: `Peer rejected the reanchor request: ${peerError}. The node's API token may need to be regenerated.`,
        });
        return;
      }
      res.status(502).json({ error: peerError });
      return;
    }

    DatabaseService.getInstance().clearFleetSyncStickyForNode(id);
    console.log(`[Nodes] Fleet-sync anchor reset on node ${id} ("${node.name}")`);
    res.json({ success: true });
  } catch (error: unknown) {
    console.error('Failed to reset fleet-sync anchor:', error);
    res.status(500).json({ error: getErrorMessage(error, 'Failed to reset fleet-sync anchor') });
  }
});

nodesRouter.post('/:id/test', async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    const result = await NodeRegistry.getInstance().testConnection(id);
    res.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Connection test failed';
    res.status(500).json({ success: false, error: message });
  }
});

nodesRouter.get('/:id/meta', authMiddleware, async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id as string);
    const node = DatabaseService.getInstance().getNode(id);
    if (!node) {
      res.status(404).json({ error: 'Node not found' });
      return;
    }

    if (node.type === 'local') {
      res.json({ version: getSenchoVersion(), capabilities: CAPABILITIES });
      return;
    }

    const cacheKey = `${REMOTE_META_NAMESPACE}:${id}`;
    const meta = await CacheService.getInstance().getOrFetch<RemoteMeta>(
      cacheKey,
      REMOTE_META_CACHE_TTL,
      async () => {
        const fetched = await NodeRegistry.getInstance().fetchMetaForNode(id);
        if (fetched.version === null) {
          throw new Error('Remote meta fetch returned null version');
        }
        return fetched;
      },
    );

    res.json(meta);
  } catch (error: unknown) {
    console.error('Failed to fetch node meta:', error);
    const message = getErrorMessage(error, 'Failed to fetch node metadata');
    res.status(500).json({ error: message });
  }
});
