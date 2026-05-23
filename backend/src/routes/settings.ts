import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { DatabaseService } from '../services/DatabaseService';
import { authMiddleware } from '../middleware/auth';
import { requireAdmin } from '../middleware/tierGates';

// Keys that contain auth credentials; never exposed to the frontend or
// writable via the settings API.
const PRIVATE_SETTINGS_KEYS = new Set(['auth_username', 'auth_password_hash', 'auth_jwt_secret']);

// Strict allowlist of keys writable via the settings API. Prevents
// overwriting auth credentials through a misconfigured key.
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
]);

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
}).partial();

export const settingsRouter = Router();

settingsRouter.get('/', authMiddleware, async (_req: Request, res: Response): Promise<void> => {
  try {
    const settings = { ...DatabaseService.getInstance().getGlobalSettings() };
    for (const key of PRIVATE_SETTINGS_KEYS) {
      delete settings[key];
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
    const parsed = SettingsPatchSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
      return;
    }
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
