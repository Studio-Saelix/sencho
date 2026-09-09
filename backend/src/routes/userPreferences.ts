import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { DatabaseService } from '../services/DatabaseService';
import { authMiddleware } from '../middleware/auth';
import { rejectApiTokenScope } from '../middleware/apiTokenScope';
import { isDebugEnabled } from '../utils/debug';

// Server-side validation mirror of the frontend registries. The two files are
// kept in sync by hand AND by scripts/check-preference-parity.mjs (wired as a
// `pretest` step in backend and frontend), which parses both literal tables
// from source text and fails on value-set drift. Keep these declarations in
// the same shape the script expects.
const THEME_MODES = ['dim', 'oled', 'light', 'auto'] as const;
const ACCENT_IDS = ['orange', 'amber', 'lime', 'cyan', 'blue', 'violet', 'magenta', 'steel'] as const;
const UI_FONT_IDS = ['Geist', 'IBM Plex Sans', 'Hanken Grotesk'] as const;
const MONO_FONT_IDS = ['Geist Mono', 'IBM Plex Mono', 'Fira Code'] as const;
const VISUAL_STYLES = ['calm', 'signature'] as const;
const HEADING_STYLES = ['clean', 'signature'] as const;
const CHART_STYLES = ['muted', 'heat', 'signature'] as const;
const DENSITIES = ['comfortable', 'compact'] as const;
const LOG_CHIP_COLOR_MODES = ['unified', 'per-service'] as const;
// Legacy 'classic' is retired in the frontend navigation registry and is
// normalized client-side during migration/hydrate BEFORE any write, so it is
// never an accepted write value.
const NAV_MODES = ['smart', 'compact'] as const;
const NAV_ALIGNS = ['left', 'center'] as const;
const SIDEBAR_MODES = ['fixed', 'resizable'] as const;
const ANATOMY_MODES = ['fixed', 'resizable'] as const;

// Desktop pane width bounds, in px. Defaults fill missing fields so
// an older writer's 16-field document still parses (it is then stored
// normalized with these values, never rejected).
const SIDEBAR_WIDTH = { min: 248, max: 440 } as const;
const ANATOMY_WIDTH = { min: 320, max: 960 } as const;

// Quick-link ids must be members of the frontend's eligible-view registry
// (frontend/src/lib/navigation/appNavRegistry.ts, items with
// quickLinkEligible: true). Cross-reference comment: the parity script
// verifies this list against the frontend's eligible registry entries.
const QUICK_LINK_IDS = [
  'dashboard', 'fleet', 'resources', 'networking', 'security', 'templates',
  'global-observability', 'auto-updates', 'scheduled-ops', 'host-console', 'audit-log',
] as const;

// Headroom over the frontend's MAX_QUICK_LINKS (8) so a frontend cap increase
// never turns a previously saved document into a 400 on write. Duplicates are
// rejected here; the frontend sanitize dedupes.
const QUICK_LINKS_MAX = 16;

const CONTRAST = { min: -0.6, max: 1.2 } as const;
const BORDER_BOOST = { min: -0.06, max: 0.12 } as const;
const GLOW = { min: 0, max: 0.4 } as const;
const TYPE_SCALE = { min: 0.88, max: 1.2 } as const;

const appearanceSchema = z.object({
  theme: z.enum(THEME_MODES),
  accent: z.enum(ACCENT_IDS),
  uiFont: z.enum(UI_FONT_IDS),
  monoFont: z.enum(MONO_FONT_IDS),
  visualStyle: z.enum(VISUAL_STYLES),
  headingStyle: z.enum(HEADING_STYLES),
  chartStyle: z.enum(CHART_STYLES),
  density: z.enum(DENSITIES),
  logChipColorMode: z.enum(LOG_CHIP_COLOR_MODES),
  borderBoost: z.number().min(BORDER_BOOST.min).max(BORDER_BOOST.max),
  glow: z.number().min(GLOW.min).max(GLOW.max),
  contrast: z.number().min(CONTRAST.min).max(CONTRAST.max),
  typeScale: z.number().min(TYPE_SCALE.min).max(TYPE_SCALE.max),
  reducedEffects: z.boolean(),
  reducedMotion: z.boolean(),
  readability: z.boolean(),
  sidebarMode: z.enum(SIDEBAR_MODES).default('fixed'),
  sidebarWidth: z.number().int().min(SIDEBAR_WIDTH.min).max(SIDEBAR_WIDTH.max).default(256),
  anatomyMode: z.enum(ANATOMY_MODES).default('fixed'),
  anatomyWidth: z.number().int().min(ANATOMY_WIDTH.min).max(ANATOMY_WIDTH.max).default(640),
}).strict();

const navigationSchema = z.object({
  mode: z.enum(NAV_MODES),
  quickLinks: z.array(z.enum(QUICK_LINK_IDS)).max(QUICK_LINKS_MAX)
    .refine((ids) => new Set(ids).size === ids.length, { message: 'Duplicate quick-link ids' }),
  labels: z.boolean(),
  align: z.enum(NAV_ALIGNS),
}).strict();

const DOMAIN_SCHEMAS: Record<string, z.ZodTypeAny> = {
  appearance: appearanceSchema,
  navigation: navigationSchema,
};

// Per-user preference domains. Derived from the schema table above (kept a
// Set, so a hypothetical key like 'constructor' can never hit
// Object.prototype via `in` or destructuring).
const PREF_DOMAINS = new Set(Object.keys(DOMAIN_SCHEMAS));

// Machine identities (node_proxy / pilot_tunnel) authenticate with a synthetic
// userId 0; preference rows are per-human-account state, so they are rejected
// before any persistence access.
const MACHINE_SCOPES = new Set(['node_proxy', 'pilot_tunnel']);

/**
 * Expected-identity guard. The client echoes the authenticated user id it
 * captured when it enqueued the operation; the server compares it against the
 * session's actual user BEFORE any persistence access. It is an assertion to
 * verify, never an instruction: the server never selects records with it.
 *
 * Rejection matrix by credential:
 * - machine scope (node_proxy / pilot_tunnel): 403 SCOPE_DENIED
 * - API token: 403 SCOPE_DENIED
 * - unauthenticated: 401
 * - authenticated human with a missing or mismatching header: 409
 *   IDENTITY_CHANGED with no preference payload, so an identity error can
 *   never leak another account's data. Distinct from the revision conflict's
 *   409 CONFLICT, which carries `current`.
 *
 * Returns the authenticated userId, or null after writing the error response.
 */
function resolvePrefUser(req: Request, res: Response): number | null {
  if (req.machineAuthScope && MACHINE_SCOPES.has(req.machineAuthScope)) {
    res.status(403).json({ error: 'Interface preferences are per-account state and cannot be managed by machine credentials.', code: 'SCOPE_DENIED' });
    return null;
  }
  if (rejectApiTokenScope(req, res, 'Interface preferences cannot be managed by API tokens.')) return null;
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  const expectedRaw = req.headers['x-sencho-pref-user'];
  const expected = typeof expectedRaw === 'string' ? Number(expectedRaw) : NaN;
  if (!Number.isInteger(expected) || expected !== req.user.userId) {
    res.status(409).json({ error: 'IDENTITY_CHANGED' });
    return null;
  }
  return req.user.userId;
}

/**
 * Validate a domain document; writes a 400 and returns null on failure.
 * The document must carry no unknown key and every field must be a member of
 * the domain's enum/bounds tables. Legacy navigation values never reach the
 * server (the client normalizes before writing).
 */
function validateDocument(req: Request, res: Response, domain: PreferenceDomainName): string | null {
  const schema = DOMAIN_SCHEMAS[domain];
  // The request envelope carries the precondition at the top level (never
  // inside the document), so strip it before schema validation. Express 5
  // leaves `req.body` undefined for a bodyless request.
  const { expectedRevision: _r, absent: _a, ...document } = (req.body ?? {}) as Record<string, unknown>;
  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid preference document', detail: parsed.error.issues[0]?.message });
    return null;
  }
  return JSON.stringify(parsed.data);
}

/** Resolve the `:domain` path parameter against the known domains; writes a 404 and returns null on failure. */
function resolveDomain(req: Request, res: Response): PreferenceDomainName | null {
  const domain = req.params.domain;
  // PREF_DOMAINS (kept a Set, so a hypothetical key like 'constructor' can
  // never hit Object.prototype) guards the raw string; the successful branch
  // then narrows it to the schema-table key type.
  if (typeof domain !== 'string' || !PREF_DOMAINS.has(domain)) {
    res.status(404).json({ error: 'Unknown preference domain' });
    return null;
  }
  return domain as PreferenceDomainName;
}

/** A validated preference domain: the key set of the schema table. */
export type PreferenceDomainName = keyof typeof DOMAIN_SCHEMAS;

/** Parse a strict precondition envelope; writes a 400 and returns null on failure. */
function parsePrecondition(req: Request, res: Response): { expectedRevision: number | null; absentOnly: boolean } | null {
  const body = (req.body ?? {}) as { expectedRevision?: unknown; absent?: unknown };
  const absentOnly = body?.absent === true;
  if (absentOnly) {
    if (body.expectedRevision !== undefined) {
      res.status(400).json({ error: 'expectedRevision and absent are mutually exclusive' });
      return null;
    }
    return { expectedRevision: null, absentOnly: true };
  }
  const rev = body?.expectedRevision;
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 1) {
    res.status(400).json({ error: 'A precondition is required: expectedRevision (integer) or absent: true' });
    return null;
  }
  return { expectedRevision: rev, absentOnly: false };
}

export const userPreferencesRouter = Router();

userPreferencesRouter.use(authMiddleware);

userPreferencesRouter.get('/', (req: Request, res: Response): void => {
  const userId = resolvePrefUser(req, res);
  if (userId === null) return;
  try {
    const db = DatabaseService.getInstance();
    const preferences: Record<string, unknown> = {};
    for (const domain of PREF_DOMAINS) {
      preferences[domain] = db.getUserPreferenceDomain(userId, domain);
    }
    res.json({ preferences });
  } catch (err) {
    console.error('[UserPreferences] GET failed:', err);
    res.status(500).json({ error: 'Failed to read interface preferences' });
  }
});

userPreferencesRouter.post('/:domain/migrate', (req: Request, res: Response): void => {
  const userId = resolvePrefUser(req, res);
  if (userId === null) return;
  const domain = resolveDomain(req, res);
  if (domain === null) return;
  const document = validateDocument(req, res, domain);
  if (document === null) return;
  try {
    // Migration is atomic create-if-absent: the loser of a concurrent
    // first-run race hydrates the winner's document instead of overwriting it.
    const result = DatabaseService.getInstance().mutateUserPreferenceDomain(
      userId, domain, null, true, () => document,
    );
    if (!result.ok) {
      res.status(200).json({ migrated: false, row: result.current });
      return;
    }
    if (isDebugEnabled()) console.log(`[UserPreferences] migrated ${domain} for user ${userId}`);
    res.status(201).json({ migrated: true, row: result.row });
  } catch (err) {
    console.error('[UserPreferences] migrate failed:', err);
    res.status(500).json({ error: 'Failed to migrate interface preferences' });
  }
});

userPreferencesRouter.put('/:domain', (req: Request, res: Response): void => {
  const userId = resolvePrefUser(req, res);
  if (userId === null) return;
  const domain = resolveDomain(req, res);
  if (domain === null) return;
  const precondition = parsePrecondition(req, res);
  if (precondition === null) return;
  const document = validateDocument(req, res, domain);
  if (document === null) return;
  try {
    const result = DatabaseService.getInstance().mutateUserPreferenceDomain(
      userId, domain, precondition.expectedRevision, precondition.absentOnly, () => document,
    );
    if (!result.ok) {
      res.status(409).json({ error: 'CONFLICT', current: result.current });
      return;
    }
    res.json({ domain, data: JSON.parse(result.row.data) as Record<string, unknown>, revision: result.row.revision, updatedAt: result.row.updatedAt });
  } catch (err) {
    console.error('[UserPreferences] PUT failed:', err);
    res.status(500).json({ error: 'Failed to save interface preferences' });
  }
});

userPreferencesRouter.delete('/:domain', (req: Request, res: Response): void => {
  const userId = resolvePrefUser(req, res);
  if (userId === null) return;
  const domain = resolveDomain(req, res);
  if (domain === null) return;
  const precondition = parsePrecondition(req, res);
  if (precondition === null) return;
  try {
    const result = DatabaseService.getInstance().resetUserPreferenceDomain(
      userId, domain, precondition.expectedRevision, precondition.absentOnly,
    );
    if (!result.ok) {
      res.status(409).json({ error: 'CONFLICT', current: result.current });
      return;
    }
    res.json({ domain, schemaVersion: result.row.schemaVersion, revision: result.row.revision, updatedAt: result.row.updatedAt });
  } catch (err) {
    console.error('[UserPreferences] DELETE failed:', err);
    res.status(500).json({ error: 'Failed to reset interface preferences' });
  }
});
