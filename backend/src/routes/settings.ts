import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { DatabaseService } from '../services/DatabaseService';
import { authMiddleware } from '../middleware/auth';
import { requirePaid } from '../middleware/tierGates';
import { requirePermission, checkPermission, type PermissionAction } from '../middleware/permissions';
import { parseNotificationDispatchRetries } from '../helpers/notificationDispatchRetries';

// Allowlist of keys readable/writable via the generic settings API, each
// mapped to the permission required to write it. Reads project only these
// keys so secrets written to global_settings by other subsystems (cloud
// backup credentials, auth_* login secrets) are never returned; writes
// outside the map are rejected.
export const SETTING_WRITE_PERMISSIONS: Record<string, PermissionAction> = {
  host_cpu_limit: 'node:manage',
  host_ram_limit: 'node:manage',
  host_disk_limit: 'node:manage',
  host_alerts_enabled: 'node:manage',
  host_alert_suppression_mins: 'node:manage',
  docker_janitor_gb: 'node:manage',
  global_crash: 'node:manage',
  template_registry_url: 'node:manage',
  prune_on_update: 'node:manage',
  reclaim_hero: 'node:manage',
  health_gate_enabled: 'node:manage',
  health_gate_window_seconds: 'node:manage',
  env_block_deploy_on_missing_required: 'node:manage',
  auto_create_missing_external_networks: 'node:manage',
  notification_dispatch_retries: 'node:manage',
  recovery_retention_days: 'node:manage',
  recovery_max_generations: 'node:manage',
  developer_mode: 'system:settings',
  metrics_retention_hours: 'system:settings',
  log_retention_days: 'system:settings',
  audit_retention_days: 'system:settings',
  mesh_auto_recreate: 'system:settings',
  scan_history_per_image_limit: 'system:settings',
  prune_orphaned_scans: 'system:settings',
  snapshot_documentation: 'system:settings',
  image_update_sidebar_indicators: 'system:settings',
  session_sliding_refresh: 'system:settings',
};

const ALLOWED_SETTING_KEYS = new Set(Object.keys(SETTING_WRITE_PERMISSIONS));

/** Resolve node:manage against the active node so scoped Node Admin grants apply. */
function checkNodeManage(req: Request): boolean {
  const nodeId = req.nodeId;
  if (typeof nodeId === 'number') {
    return checkPermission(req, 'node:manage', 'node', String(nodeId));
  }
  return checkPermission(req, 'node:manage');
}

function requireNodeManage(req: Request, res: Response): boolean {
  const nodeId = req.nodeId;
  if (typeof nodeId === 'number') {
    return requirePermission(req, res, 'node:manage', 'node', String(nodeId));
  }
  return requirePermission(req, res, 'node:manage');
}

/** Fail closed if any key lacks its required permission. */
function requireSettingsWritePermission(req: Request, res: Response, keys: string[]): boolean {
  // Empty no-op still requires write capability (prior requireAdmin behavior).
  if (keys.length === 0) {
    if (checkNodeManage(req) || checkPermission(req, 'system:settings')) return true;
    res.status(403).json({ error: 'Permission denied.', code: 'PERMISSION_DENIED' });
    return false;
  }
  const needed = new Set<PermissionAction>();
  for (const key of keys) {
    const action = SETTING_WRITE_PERMISSIONS[key];
    if (!action) {
      res.status(400).json({ error: `Invalid or disallowed setting key: ${key}` });
      return false;
    }
    needed.add(action);
  }
  for (const action of needed) {
    const ok = action === 'node:manage'
      ? requireNodeManage(req, res)
      : requirePermission(req, res, action);
    if (!ok) return false;
  }
  return true;
}

// Keys whose write requires a paid license, not just a permission.
// audit_retention_days configures the paid audit log, so a Community admin
// must not be able to set it. Checked after the permission bucket.
const PAID_ONLY_SETTING_KEYS = new Set(['audit_retention_days']);

// Bulk PATCH schema. All keys optional; present keys are fully validated.
const SettingsPatchSchema = z.object({
  host_cpu_limit: z.coerce.number().int().min(1).max(100).transform(String),
  host_ram_limit: z.coerce.number().int().min(1).max(100).transform(String),
  host_disk_limit: z.coerce.number().int().min(1).max(100).transform(String),
  host_alerts_enabled: z.enum(['0', '1']),
  host_alert_suppression_mins: z.coerce.number().int().min(1).max(1440).transform(String),
  docker_janitor_gb: z.coerce.number().min(0).transform(String),
  global_crash: z.enum(['0', '1']),
  developer_mode: z.enum(['0', '1']),
  template_registry_url: z.string().max(2048).refine(v => v === '' || /^https?:\/\/.+/.test(v), { message: 'Must be a valid URL or empty' }),
  metrics_retention_hours: z.coerce.number().int().min(1).max(8760).transform(String),
  log_retention_days: z.coerce.number().int().min(1).max(365).transform(String),
  audit_retention_days: z.coerce.number().int().min(1).max(365).transform(String),
  mesh_auto_recreate: z.enum(['0', '1']),
  scan_history_per_image_limit: z.coerce.number().int().min(5).max(1000).transform(String),
  prune_orphaned_scans: z.enum(['0', '1']),
  prune_on_update: z.enum(['0', '1']),
  reclaim_hero: z.enum(['0', '1']),
  snapshot_documentation: z.enum(['0', '1']),
  health_gate_enabled: z.enum(['0', '1']),
  health_gate_window_seconds: z.coerce.number().int().min(15).max(600).transform(String),
  env_block_deploy_on_missing_required: z.enum(['0', '1']),
  auto_create_missing_external_networks: z.enum(['0', '1']),
  image_update_sidebar_indicators: z.enum(['0', '1']),
  recovery_retention_days: z.coerce.number().int().min(1).max(90).transform(String),
  recovery_max_generations: z.coerce.number().int().min(0).max(50).transform(String),
  // Strict: do not use bare z.coerce.number() (null/false/'' become 0; true becomes 1).
  notification_dispatch_retries: z.unknown().superRefine((v, ctx) => {
    if (parseNotificationDispatchRetries(v) === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Must be an integer from 0 to 3',
      });
    }
  }).transform((v) => String(parseNotificationDispatchRetries(v)!)),
  session_sliding_refresh: z.enum(['0', '1']),
}).partial();

export const settingsRouter = Router();

settingsRouter.get('/', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
  try {
    const all = DatabaseService.getInstance().getGlobalSettings();
    // Project only allowlisted operational keys. A denylist would leak every
    // future sensitive key written to global_settings by default (e.g. the
    // cloud_backup_* credentials the cloud-backup route stores here); the
    // allowlist fails closed.
    const settings: Record<string, string> = {};
    for (const [key, value] of Object.entries(all)) {
      if (ALLOWED_SETTING_KEYS.has(key)) settings[key] = value;
    }
    res.json(settings);
  } catch (error) {
    console.error('Failed to fetch settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

settingsRouter.post('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    const { key, value } = req.body;
    if (!key || typeof key !== 'string' || !ALLOWED_SETTING_KEYS.has(key)) {
      res.status(400).json({ error: `Invalid or disallowed setting key: ${key}` });
      return;
    }
    if (!requireSettingsWritePermission(req, res, [key])) return;
    if (PAID_ONLY_SETTING_KEYS.has(key) && !requirePaid(req, res)) return;
    if (value === undefined || value === null) {
      res.status(400).json({ error: 'Setting value is required' });
      return;
    }
    // Route the single-key write through the same per-key schema used by
    // the bulk PATCH so allowlisted-but-malformed values (e.g. `true`,
    // `banana`, out-of-range integers) cannot bypass validation just
    // because they came in via the single-key path. The schema coerces
    // numeric settings to strings and rejects enum-shaped settings that
    // are not one of the allowed literals.
    const parsed = SettingsPatchSchema.safeParse({ [key]: value });
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.flatten().fieldErrors,
      });
      return;
    }
    const validated = (parsed.data as Record<string, string>)[key];
    if (validated === undefined) {
      // Defensive: the schema is `.partial()`, so an unknown key would
      // pass through silently. We already gated on ALLOWED_SETTING_KEYS,
      // but reject explicitly if the key is somehow missing from the
      // schema's shape (drift between the allowlist and the schema).
      res.status(400).json({ error: `Setting key has no validator: ${key}` });
      return;
    }
    DatabaseService.getInstance().updateGlobalSetting(key, validated);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to update setting:', error);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

settingsRouter.patch('/', authMiddleware, async (req: Request, res: Response): Promise<void> => {
  try {
    // Reject unknown/disallowed keys outright rather than letting Zod silently
    // strip them. This keeps the bulk path fail-closed and consistent with the
    // single-key POST, so a client sending a stale or disallowed key (e.g. an
    // auth_* secret) gets a 400, not a misleading 200.
    const body = req.body;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const unknownKeys = Object.keys(body).filter(k => !ALLOWED_SETTING_KEYS.has(k));
      if (unknownKeys.length > 0) {
        res.status(400).json({ error: `Invalid or disallowed setting key(s): ${unknownKeys.join(', ')}` });
        return;
      }
    }
    const parsed = SettingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      return;
    }
    const keys = Object.keys(parsed.data);
    if (!requireSettingsWritePermission(req, res, keys)) return;
    if (keys.some(k => PAID_ONLY_SETTING_KEYS.has(k)) && !requirePaid(req, res)) return;
    const db = DatabaseService.getInstance();
    const updateMany = db.getDb().transaction((entries: [string, string][]) => {
      for (const [k, v] of entries) {
        db.updateGlobalSetting(k, v);
      }
    });
    updateMany(Object.entries(parsed.data) as [string, string][]);
    res.json({ success: true });
  } catch (error) {
    console.error('Failed to bulk update settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});
