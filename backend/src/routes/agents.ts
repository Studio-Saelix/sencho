import { Router, type Request, type Response } from 'express';
import { DatabaseService } from '../services/DatabaseService';
import { authMiddleware } from '../middleware/auth';
import { requirePermission } from '../middleware/permissions';
import { isDebugEnabled } from '../utils/debug';
import { sanitizeForLog } from '../utils/safeLog';
import {
  NOTIFICATION_CHANNEL_TYPES,
  normalizeAppriseStoredJson,
  redactedChannelWriteError,
  resolvePreservedAppriseConfig,
  serializePublicAgent,
  validateNotificationChannel,
} from '../helpers/notificationChannels';

export const agentsRouter = Router();

agentsRouter.get('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const nodeId = req.nodeId ?? 0;
    const agents = DatabaseService.getInstance().getAgents(nodeId);
    res.json(agents.map(serializePublicAgent));
  } catch (error) {
    console.error('Failed to fetch agents:', error);
    res.status(500).json({ error: 'Failed to fetch agents' });
  }
});

agentsRouter.post('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  const nodeId = req.nodeId ?? 0;
  if (!requirePermission(req, res, 'node:manage', 'node', String(nodeId))) return;
  try {
    const { type, url, enabled, config } = req.body;
    if (!type || !(NOTIFICATION_CHANNEL_TYPES as readonly string[]).includes(type)) {
      res.status(400).json({ error: `type must be ${NOTIFICATION_CHANNEL_TYPES.join(', ')}` });
      return;
    }
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled must be a boolean' });
      return;
    }
    const existing = DatabaseService.getInstance().getAgents(nodeId).find(agent => agent.type === type);
    const effectiveUrl = url === undefined ? existing?.url : url;

    let effectiveConfig: unknown = config ?? null;
    if (type === 'apprise' && config === undefined && existing) {
      const resolved = resolvePreservedAppriseConfig(typeof effectiveUrl === 'string' ? effectiveUrl : existing.url, existing.config);
      if (!resolved.ok) { res.status(400).json({ error: resolved.error }); return; }
      effectiveConfig = resolved.config;
    }

    const redactedErr = redactedChannelWriteError(type, effectiveUrl, effectiveConfig, config);
    if (redactedErr) { res.status(400).json({ error: redactedErr }); return; }
    const channelErr = validateNotificationChannel(type, effectiveUrl, effectiveConfig);
    if (channelErr) { res.status(400).json({ error: `url ${channelErr}` }); return; }
    DatabaseService.getInstance().upsertAgent(nodeId, {
      type,
      url: effectiveUrl.trim(),
      enabled,
      config: type === 'apprise' ? normalizeAppriseStoredJson(effectiveUrl.trim(), effectiveConfig) : null,
    });
    console.log('[Agents] Agent %s updated', sanitizeForLog(type));
    if (isDebugEnabled()) console.log('[Agents:diag] Agent %s upsert: enabled=%s', sanitizeForLog(type), sanitizeForLog(enabled));
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to update agent:', error);
    res.status(500).json({ error: 'Failed to update agent' });
  }
});
