import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { DatabaseService } from '../services/DatabaseService';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin, requirePaid } from '../middleware/tierGates';

// Strict allowlist of keys readable and writable via the generic settings
// API. This is the single source of truth for what the endpoint exposes:
// reads project only these keys, so secrets written to global_settings by
// other subsystems (the cloud_backup_* credentials stored by the cloud-backup
// route, the auth_* login secrets) are never returned here; writes are
// rejected for anything outside the list.
const ALLOWED_SETTING_KEYS = new Set([
  'host_cpu_limit',
  'host_ram_limit',
  'host_disk_limit',
  'host_alert_suppression_mins',
  'docker_janitor_gb',
  'global_crash',
  'developer_mode',
  'template_registry_url',
  'metrics_retention_hours',
  'log_retention_days',
  'audit_retention_days',
  'mesh_auto_recreate',
  'scan_history_per_image_limit',
  'prune_on_update',
]);

// Keys whose write requires a paid license, not just an admin role.
// audit_retention_days configures the paid audit log, so a Community admin
// must not be able to set it.
const PAID_ONLY_SETTING_KEYS = new Set(['audit_retention_days']);

// Bulk PATCH schema. All keys optional; present keys are fully validated.
const SettingsPatchSchema = z.object({
  host_cpu_limit: z.coerce.number().int().min(1).max(100).transform(String),
  host_ram_limit: z.coerce.number().int().min(1).max(100).transform(String),
  host_disk_limit: z.coerce.number().int().min(1).max(100).transform(String),
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
  prune_on_update: z.enum(['0', '1']),
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
  if (!requireAdmin(req, res)) return;
  try {
    const { key, value } = req.body;
    if (!key || typeof key !== 'string' || !ALLOWED_SETTING_KEYS.has(key)) {
      res.status(400).json({ error: `Invalid or disallowed setting key: ${key}` });
      return;
    }
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
  if (!requireAdmin(req, res)) return;
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
    if (Object.keys(parsed.data).some(k => PAID_ONLY_SETTING_KEYS.has(k)) && !requirePaid(req, res)) return;
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
