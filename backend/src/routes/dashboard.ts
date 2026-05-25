import { Router, type Request, type Response } from 'express';
import { DatabaseService, type StackRestartSummary } from '../services/DatabaseService';
import { CloudBackupService } from '../services/CloudBackupService';
import { effectiveTier, effectiveVariant } from '../middleware/tierGates';
import { isDebugEnabled } from '../utils/debug';
import type { LicenseTier, LicenseVariant } from '../services/license-types';

export const dashboardRouter = Router();

interface AgentStatus {
  configured: boolean;
  enabled: boolean;
}

export interface ConfigurationStatus {
  tier: LicenseTier;
  variant: LicenseVariant;
  notifications: {
    agents: { discord: AgentStatus; slack: AgentStatus; webhook: AgentStatus };
    alertRules: number;
    routingRules: { count: number; enabledCount: number; locked: boolean; requiredTier: 'skipper' };
  };
  automation: {
    autoHeal: { total: number; enabled: number };
    autoUpdate: { enabled: number; total: number };
    scheduledTasks: { total: number; enabled: number; locked: boolean; requiredTier: 'admiral' };
    webhooks: { total: number; enabled: number; locked: boolean; requiredTier: 'skipper' };
  };
  security: {
    mfaEnabled: boolean | null;
    ssoEnabled: boolean;
    ssoProvider: string | null;
    scanPolicies: { total: number; enabled: number; locked: boolean; requiredTier: 'skipper' };
  };
  thresholds: {
    cpuLimit: number;
    ramLimit: number;
    diskLimit: number;
    dockerJanitorGb: number;
    globalCrash: boolean;
  };
  backup: {
    provider: 'disabled' | 'sencho' | 'custom';
    autoUpload: boolean;
    locked: boolean;
    requiredTier: 'admiral';
  };
}

export function buildLocalConfigurationStatus(
  nodeId: number,
  userId: number,
  tier: LicenseTier,
  variant: LicenseVariant,
): ConfigurationStatus {
  const db = DatabaseService.getInstance();
  const isPaid = tier === 'paid';
  const isAdmiral = isPaid && variant === 'admiral';

  const agents = db.getAgents(nodeId);
  const agentByType = (type: 'discord' | 'slack' | 'webhook'): AgentStatus => {
    const a = agents.find(ag => ag.type === type);
    return { configured: !!a?.url, enabled: a?.enabled ?? false };
  };

  const alertRules = db.getStackAlerts().length;
  const notifRoutes = db.getNotificationRoutes();

  const healPolicies = db.getAutoHealPolicies(undefined, nodeId);
  const autoUpdateMap = db.getStackAutoUpdateSettingsForNode(nodeId);
  const autoUpdateEnabled = Object.values(autoUpdateMap).filter(Boolean).length;
  const autoUpdateTotal = Object.keys(autoUpdateMap).length;
  const scheduledTasks = db.getScheduledTasks();
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

  const cloudSvc = CloudBackupService.getInstance();
  const cloudProvider = cloudSvc.getProvider();
  const cloudAutoUpload = cloudSvc.isAutoUploadOn();

  return {
    tier,
    variant,
    notifications: {
      agents: {
        discord: agentByType('discord'),
        slack: agentByType('slack'),
        webhook: agentByType('webhook'),
      },
      alertRules,
      routingRules: {
        count: notifRoutes.length,
        enabledCount: notifRoutes.filter(r => r.enabled).length,
        locked: !isPaid,
        requiredTier: 'skipper',
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
      scheduledTasks: {
        total: scheduledTasks.length,
        enabled: scheduledTasks.filter(t => t.enabled === 1).length,
        locked: !isAdmiral,
        requiredTier: 'admiral',
      },
      webhooks: {
        total: webhooks.length,
        enabled: webhooks.filter(w => w.enabled).length,
        locked: !isPaid,
        requiredTier: 'skipper',
      },
    },
    security: {
      mfaEnabled: mfaRow ? mfaRow.enabled === 1 : null,
      ssoEnabled: !!enabledSso,
      ssoProvider: enabledSso?.provider ?? null,
      scanPolicies: {
        total: scanPolicies.length,
        enabled: scanPolicies.filter(p => p.enabled === 1).length,
        locked: !isPaid,
        requiredTier: 'skipper',
      },
    },
    thresholds: {
      cpuLimit,
      ramLimit,
      diskLimit,
      dockerJanitorGb,
      globalCrash,
    },
    backup: {
      provider: cloudProvider,
      autoUpload: cloudAutoUpload,
      locked: false,
      requiredTier: 'admiral',
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
    const variant = effectiveVariant(req);

    const payload = buildLocalConfigurationStatus(nodeId, userId, tier, variant);
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
