import { Router, type Request, type Response } from 'express';
import { DatabaseService, type StackRestartSummary } from '../services/DatabaseService';
import { CloudBackupService } from '../services/CloudBackupService';
import { effectiveTier } from '../middleware/tierGates';
import { isDebugEnabled } from '../utils/debug';
import type { LicenseTier } from '../services/license-types';

export const dashboardRouter = Router();

interface AgentStatus {
  configured: boolean;
  enabled: boolean;
}

export interface ConfigurationStatus {
  tier: LicenseTier;
  notifications: {
    agents: { discord: AgentStatus; slack: AgentStatus; webhook: AgentStatus };
    alertRules: number;
    routingRules: { count: number; enabledCount: number; locked: boolean };
  };
  automation: {
    autoHeal: { total: number; enabled: number };
    autoUpdate: { enabled: number; total: number };
    scheduledTasks: { total: number; enabled: number; locked: boolean };
    webhooks: { total: number; enabled: number; locked: boolean };
  };
  security: {
    mfaEnabled: boolean | null;
    ssoEnabled: boolean;
    ssoProvider: string | null;
    scanPolicies: { total: number; enabled: number; locked: boolean };
  };
  thresholds: {
    cpuLimit: number;
    ramLimit: number;
    diskLimit: number;
    dockerJanitorGb: number;
    globalCrash: boolean;
    hostAlertsEnabled: boolean;
  };
  backup: {
    provider: 'disabled' | 'sencho' | 'custom';
    autoUpload: boolean;
    locked: boolean;
  };
}

export function buildLocalConfigurationStatus(
  nodeId: number,
  userId: number,
  tier: LicenseTier,
): ConfigurationStatus {
  const db = DatabaseService.getInstance();

  const agents = db.getAgents(nodeId);
  const agentByType = (type: 'discord' | 'slack' | 'webhook'): AgentStatus => {
    const a = agents.find(ag => ag.type === type);
    return { configured: !!a?.url, enabled: a?.enabled ?? false };
  };

  const alertRules = db.getStackAlerts().length;
  const notifRoutes = db.getNotificationRoutes();

  const healPolicies = db.getAutoHealPolicies(undefined, nodeId);
  const scheduledTasks = db.getScheduledTasks();
  const nodeUpdateTasks = scheduledTasks.filter(t => t.action === 'update' && t.node_id === nodeId);
  const autoUpdateTotal = nodeUpdateTasks.length;
  const autoUpdateEnabled = nodeUpdateTasks.filter(t => t.enabled === 1).length;
  const webhooks = db.getWebhooks();

  const mfaRow = userId ? db.getUserMfa(userId) : undefined;
  const ssoConfigs = db.getSSOConfigs();
  const enabledSso = ssoConfigs.find(c => c.enabled === 1);
  const scanPolicies = db.getScanPolicies();

  const settings = db.getGlobalSettings();
  const cpuLimit = parseInt(settings['host_cpu_limit'] ?? '90', 10);
  const ramLimit = parseInt(settings['host_ram_limit'] ?? '90', 10);
  const diskLimit = parseInt(settings['host_disk_limit'] ?? '90', 10);
  const dockerJanitorGb = parseFloat(settings['docker_janitor_gb'] ?? '5');
  const globalCrash = settings['global_crash'] === '1';
  const hostAlertsEnabled = settings['host_alerts_enabled'] !== '0';

  const cloudSvc = CloudBackupService.getInstance();
  const cloudProvider = cloudSvc.getProvider();
  const cloudAutoUpload = cloudSvc.isAutoUploadOn();

  return {
    tier,
    notifications: {
      agents: {
        discord: agentByType('discord'),
        slack: agentByType('slack'),
        webhook: agentByType('webhook'),
      },
      alertRules,
      // Notification routing is available on every tier.
      routingRules: {
        count: notifRoutes.length,
        enabledCount: notifRoutes.filter(r => r.enabled).length,
        locked: false,
      },
    },
    automation: {
      autoHeal: {
        total: healPolicies.length,
        enabled: healPolicies.filter(p => p.enabled === 1).length,
      },
      autoUpdate: {
        enabled: autoUpdateEnabled,
        total: autoUpdateTotal,
      },
      // Scheduled operations are available on every tier.
      scheduledTasks: {
        total: scheduledTasks.length,
        enabled: scheduledTasks.filter(t => t.enabled === 1).length,
        locked: false,
      },
      // Webhooks are available on every tier.
      webhooks: {
        total: webhooks.length,
        enabled: webhooks.filter(w => w.enabled).length,
        locked: false,
      },
    },
    security: {
      mfaEnabled: mfaRow ? mfaRow.enabled === 1 : null,
      ssoEnabled: !!enabledSso,
      ssoProvider: enabledSso?.provider ?? null,
      // Scan policies are available on every tier.
      scanPolicies: {
        total: scanPolicies.length,
        enabled: scanPolicies.filter(p => p.enabled === 1).length,
        locked: false,
      },
    },
    thresholds: {
      cpuLimit,
      ramLimit,
      diskLimit,
      dockerJanitorGb,
      globalCrash,
      hostAlertsEnabled,
    },
    backup: {
      // Cloud Backup has a per-provider tier: Custom S3 is open to every
      // tier; Sencho Cloud Backup requires a paid license. The row is rendered
      // for every tier because Custom S3 is universally configurable, so no
      // dashboard-level lock is meaningful.
      provider: cloudProvider,
      autoUpload: cloudAutoUpload,
      locked: false,
    },
  };
}

// All routes below are protected by the global authGate mounted at app.use('/api', authGate)
dashboardRouter.get('/configuration', (req: Request, res: Response): void => {
  try {
    const debug = isDebugEnabled();
    const startedAt = debug ? Date.now() : 0;
    const nodeId = req.nodeId ?? 0;
    const userId = req.user?.userId ?? 0;
    const tier = effectiveTier(req);

    const payload = buildLocalConfigurationStatus(nodeId, userId, tier);
    if (debug) {
      console.debug(
        `[Dashboard:debug] /configuration built in ${Date.now() - startedAt} ms (nodeId=${nodeId})`,
      );
    }
    res.json(payload);
  } catch (error) {
    console.error('[Dashboard] Failed to build configuration status:', error);
    res.status(500).json({ error: 'Failed to fetch configuration status' });
  }
});

dashboardRouter.get('/stack-restarts', (req: Request, res: Response): void => {
  try {
    const debug = isDebugEnabled();
    const startedAt = debug ? Date.now() : 0;
    const db = DatabaseService.getInstance();
    const nodeId = req.nodeId ?? 0;
    const rawDays = parseInt(String(req.query['days'] ?? '7'), 10);
    const days = isNaN(rawDays) || rawDays < 1 ? 7 : Math.min(rawDays, 30);

    const result: StackRestartSummary[] = db.getStackRestartSummary(nodeId, days);
    if (debug) {
      console.debug(
        `[Dashboard:debug] /stack-restarts returned ${result.length} rows for nodeId=${nodeId} over ${days}d in ${Date.now() - startedAt} ms`,
      );
    }
    res.json(result);
  } catch (error) {
    console.error('[Dashboard] Failed to fetch stack restarts:', error);
    res.status(500).json({ error: 'Failed to fetch stack restarts' });
  }
});
