/**
 * Preference documents: the server-side shape of the two preference domains.
 *
 * The sync layer serializes local state into these documents for migration and
 * writes, and hydrates server rows back into the local hooks. Sanitization is
 * per-field against the live registries (the hooks' own guards), so a future
 * enum removal degrades to the default value instead of corrupting state.
 */

import {
  CALM_PRESET,
  CONTRAST, BORDER_BOOST, GLOW, TYPE_SCALE,
  currentThemeState, applyThemeState,
  isMode, isAccent, isUiFont, isMonoFont,
  isVisualStyle, isHeadingStyle, isChartStyle, isBool,
  type ThemeState,
} from '@/hooks/use-theme';
import { currentDensityValue, applyDensityValue, isDensity, type Density } from '@/hooks/use-density';
import {
  TOP_NAV_MODE_KEY, parseTopNavMode, currentTopNavMode, applyTopNavMode, type TopNavMode,
} from '@/hooks/use-top-nav-mode';
import {
  TOP_NAV_QUICK_LINKS_KEY, sanitizeQuickLinkIds,
  currentQuickLinks, applyQuickLinks, currentQuickLinksProvenance,
} from '@/hooks/use-top-nav-quick-links';
import { TOP_NAV_LABELS_KEY, currentTopNavLabels, applyTopNavLabels } from '@/hooks/use-top-nav-labels';
import { TOP_NAV_ALIGN_KEY, currentTopNavAlign, applyTopNavAlign, isTopNavAlignExport, type TopNavAlign } from '@/hooks/use-top-nav-align';
import { currentLogChipColorMode, applyLogChipColorMode, isLogChipColorModeExport, type LogChipColorMode } from '@/hooks/use-log-chip-color-mode';
import {
  SIDEBAR_MODE_KEY, SIDEBAR_WIDTH_KEY, SIDEBAR_WIDTH_DEFAULT,
  currentSidebarMode, currentSidebarWidth,
  applySidebarModeValue, applySidebarWidthValue,
  isSidebarMode, sanitizeSidebarWidth,
  type SidebarMode,
} from '@/hooks/use-sidebar-layout';
import { recommendedQuickLinkIds } from '@/lib/navigation/appNavRegistry';

export interface AppearanceDocument {
  theme: ThemeState['theme'];
  accent: ThemeState['accent'];
  uiFont: ThemeState['uiFont'];
  monoFont: ThemeState['monoFont'];
  visualStyle: ThemeState['visualStyle'];
  headingStyle: ThemeState['headingStyle'];
  chartStyle: ThemeState['chartStyle'];
  density: Density;
  logChipColorMode: LogChipColorMode;
  borderBoost: number;
  glow: number;
  contrast: number;
  typeScale: number;
  reducedEffects: boolean;
  reducedMotion: boolean;
  readability: boolean;
  sidebarMode: SidebarMode;
  sidebarWidth: number;
}

/** What the raw theme cache key holds: everything except the fields
 *  (`density`, `logChipColorMode`, `sidebarMode`, `sidebarWidth`) stored under
 *  their own keys. */
export type ThemeCacheDocument = Omit<AppearanceDocument, 'density' | 'logChipColorMode' | 'sidebarMode' | 'sidebarWidth'>;

/** Navigation document with unset provenance for the pin list. `unset` means
 *  the hook has never persisted a list (never-seeded or eligibility still
 *  settling); `valid` includes a deliberately empty list ([]). */
export type NavigationDocument =
  | { status: 'unset' }
  | {
      status: 'valid';
      mode: TopNavMode;
      quickLinks: string[];
      labels: boolean;
      align: TopNavAlign;
    };

function clampNumber(value: unknown, bounds: { min: number; max: number; default: number }): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return bounds.default;
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

/** Serialize the live appearance state (theme + density + log chips) into the
 *  server document shape. */
export function buildAppearanceDocument(): AppearanceDocument {
  const t = currentThemeState();
  return {
    theme: t.theme,
    accent: t.accent,
    uiFont: t.uiFont,
    monoFont: t.monoFont,
    visualStyle: t.visualStyle,
    headingStyle: t.headingStyle,
    chartStyle: t.chartStyle,
    density: currentDensityValue(),
    logChipColorMode: currentLogChipColorMode(),
    borderBoost: t.borderBoost,
    glow: t.glow,
    contrast: t.contrast,
    typeScale: t.typeScale,
    reducedEffects: t.reducedEffects,
    reducedMotion: t.reducedMotion,
    readability: t.readability,
    sidebarMode: currentSidebarMode(),
    sidebarWidth: currentSidebarWidth(),
  };
}

/**
 * Serialize the live navigation state. Carries unset provenance: a hook that
 * has never persisted a list produces `{ status: 'unset' }` and the sync layer
 * defers migration until eligibility has settled (never saves a derived `[]`).
 * Legacy 'classic' is normalized to Compact here by parseTopNavMode before any
 * write, so the server never receives the retired value.
 */
export function buildNavigationDocument(): NavigationDocument {
  const provenance = currentQuickLinksProvenance();
  if (provenance.status === 'unset') return { status: 'unset' };
  return {
    status: 'valid',
    mode: currentTopNavMode(),
    quickLinks: currentQuickLinks(),
    labels: currentTopNavLabels(),
    align: currentTopNavAlign(),
  };
}

// ── hydration (server document → local hooks + cache) ──────────────────────

/** Per-field sanitize of an untrusted appearance document and apply through
 *  the hooks' internal write path (DOM + localStorage + subscribers). Invalid
 *  scalars keep the current local value; out-of-range numerics fall back to
 *  their registry default; a document missing the visual-style axes (older
 *  writer) fills them from Signature exactly like the local storage read does. */
export function hydrateAppearanceDocument(raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const p = raw as Record<string, unknown>;
  const current = currentThemeState();
  // Visual-style axes: a document missing them (older writer) is a returning
  // user, so fill from Signature exactly like the local storage read does.
  const visualFallback = {
    visualStyle: isVisualStyle(p.visualStyle) ? p.visualStyle : 'signature' as const,
    headingStyle: isHeadingStyle(p.headingStyle) ? p.headingStyle : 'signature' as const,
    chartStyle: isChartStyle(p.chartStyle) ? p.chartStyle : 'signature' as const,
    reducedEffects: isBool(p.reducedEffects) ? p.reducedEffects : true,
    reducedMotion: isBool(p.reducedMotion) ? p.reducedMotion : true,
    readability: isBool(p.readability) ? p.readability : false,
  };
  applyThemeState({
    theme: isMode(p.theme) ? p.theme : current.theme,
    accent: isAccent(p.accent) ? p.accent : current.accent,
    uiFont: isUiFont(p.uiFont) ? p.uiFont : current.uiFont,
    monoFont: isMonoFont(p.monoFont) ? p.monoFont : current.monoFont,
    borderBoost: clampNumber(p.borderBoost, BORDER_BOOST),
    glow: clampNumber(p.glow, GLOW),
    contrast: clampNumber(p.contrast, CONTRAST),
    typeScale: clampNumber(p.typeScale, TYPE_SCALE),
    ...visualFallback,
  });
  applyDensityValue(isDensity(p.density) ? p.density : 'comfortable');
  applyLogChipColorMode(isLogChipColorModeExport(p.logChipColorMode) ? p.logChipColorMode : 'unified');
  // A document missing the sidebar fields (older writer) degrades to the
  // defaults instead of leaving stale browser-local values behind.
  applySidebarModeValue(isSidebarMode(p.sidebarMode) ? p.sidebarMode : 'fixed');
  applySidebarWidthValue(sanitizeSidebarWidth(p.sidebarWidth));
}

/** The documented calm-default appearance document, used for tombstone
 *  hydration (the server says "reset", so defaults come from the registry,
 *  not from whatever this browser happens to have cached). */
export function defaultAppearanceDocument(): AppearanceDocument {
  const d = CALM_PRESET;
  return {
    theme: 'dim',
    accent: 'cyan',
    uiFont: 'Geist',
    monoFont: 'Geist Mono',
    visualStyle: d.visualStyle,
    headingStyle: d.headingStyle,
    chartStyle: d.chartStyle,
    density: 'comfortable',
    logChipColorMode: 'unified',
    borderBoost: BORDER_BOOST.default,
    glow: GLOW.default,
    contrast: CONTRAST.default,
    typeScale: TYPE_SCALE.default,
    reducedEffects: d.reducedEffects,
    reducedMotion: d.reducedMotion,
    readability: d.readability,
    sidebarMode: 'fixed',
    sidebarWidth: SIDEBAR_WIDTH_DEFAULT,
  };
}

/**
 * Per-field sanitize of an untrusted navigation document and apply through the
 * hooks' internal write path. Legacy `mode: 'classic'` normalizes to Compact
 * (parseTopNavMode). Quick links are sanitized against the eligible registry,
 * deduped, and capped at MAX_QUICK_LINKS; a valid empty list stays empty.
 */
export function hydrateNavigationDocument(raw: unknown): void {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
  const p = raw as Record<string, unknown>;
  const rawMode = typeof p.mode === 'string' ? p.mode : null;
  // parseTopNavMode maps legacy 'classic' (and anything unknown) to Compact.
  const mode: TopNavMode = rawMode === 'smart' ? 'smart' : parseTopNavMode(rawMode);
  const labels = isBool(p.labels) ? p.labels : true;
  const align: TopNavAlign = isTopNavAlignExport(p.align) ? p.align : 'left';
  const quickLinks = sanitizeQuickLinkIds(p.quickLinks);
  applyTopNavMode(mode);
  applyTopNavLabels(labels);
  applyTopNavAlign(align);
  applyQuickLinks(quickLinks);
}

/**
 * Hydrate a navigation tombstone (or corrupt row): the domain was reset, so
 * apply the scalar defaults and seed the recommended quick-link set
 * unconditionally, before settled eligibility is known. Seeding persists a
 * valid pin list, so the hook's eligibility seed effect later becomes a
 * no-op. Reachability filtering happens at display time, not here.
 */
export function hydrateNavigationDefaults(): void {
  applyTopNavMode(parseTopNavMode(null));
  applyTopNavLabels(true);
  applyTopNavAlign('left');
  applyQuickLinks(recommendedQuickLinkIds.filter((id) => sanitizeQuickLinkIds([id]).length > 0));
}

// ── cache keys ─────────────────────────────────────────────────────────────
/** Every localStorage key the preference domains own. Cleared on identity
 *  switch and when no user is signed in (another account must never see this
 *  browser's cached values); tombstone and corrupt hydration instead rewrite
 *  each key to its default through the apply paths. theme-init.js re-reads the
 *  theme key at next paint, so a cleared key paints defaults. */
export const PREFERENCE_CACHE_KEYS = [
  'sencho.appearance.theme',
  'sencho-theme', // legacy theme key
  'sencho.appearance.density',
  'sencho.log-chip-color-mode',
  SIDEBAR_MODE_KEY,
  SIDEBAR_WIDTH_KEY,
  TOP_NAV_MODE_KEY,
  TOP_NAV_QUICK_LINKS_KEY,
  TOP_NAV_LABELS_KEY,
  TOP_NAV_ALIGN_KEY,
] as const;

export const PREFERENCES_OWNER_KEY = 'sencho.preferences.owner';

export function clearPreferenceCache(): void {
  if (typeof window === 'undefined') return;
  try {
    for (const key of PREFERENCE_CACHE_KEYS) window.localStorage.removeItem(key);
    window.localStorage.removeItem(PREFERENCES_OWNER_KEY);
  } catch {
    // localStorage may be unavailable; nothing to clear then
  }
}

export function writePreferenceCacheFromDocuments(): void {
  if (typeof window === 'undefined') return;
  // The apply* functions already persist through the hooks' own write paths;
  // this rewrites the theme document (the only key holding multiple fields)
  // after a reset so the pre-paint cache mirrors the reset values even if a
  // queued DELETE has not settled yet.
  const appearance = buildAppearanceDocument();
  try {
    window.localStorage.setItem('sencho.appearance.theme', JSON.stringify({
      ...appearance,
      density: undefined,
      logChipColorMode: undefined,
      sidebarMode: undefined,
      sidebarWidth: undefined,
    }));
  } catch {
    // ignore; private mode / quota
  }
}
