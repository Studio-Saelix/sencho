#!/usr/bin/env node
/**
 * Enum parity check for the per-user preference documents.
 *
 * The backend Zod schemas (backend/src/routes/userPreferences.ts) and the
 * frontend registries (frontend/src/hooks/use-theme.ts,
 * frontend/src/hooks/use-density.ts, frontend/src/hooks/use-top-nav-mode.ts,
 * frontend/src/hooks/use-top-nav-align.ts,
 * frontend/src/hooks/use-log-chip-color-mode.ts,
 * frontend/src/lib/navigation/appNavRegistry.ts) must accept the same value
 * sets. The backend cannot import frontend sources (tsconfig rootDir is
 * ./src and backend tests participate in production compilation), so this
 * script parses the literal declarations from source text instead.
 *
 * Exits non-zero on any value-set drift. Wired as the `pretest` script of
 * both backend and frontend package.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const routeSrc = read('backend/src/routes/userPreferences.ts');
const themeSrc = read('frontend/src/hooks/use-theme.ts');
const navModeSrc = read('frontend/src/hooks/use-top-nav-mode.ts');
const navAlignSrc = read('frontend/src/hooks/use-top-nav-align.ts');
const densitySrc = read('frontend/src/hooks/use-density.ts');
const logChipSrc = read('frontend/src/hooks/use-log-chip-color-mode.ts');
const navRegistrySrc = read('frontend/src/lib/navigation/appNavRegistry.ts');

let failed = false;
const fail = (msg) => { console.error(`[preference-parity] FAIL: ${msg}`); failed = true; };
const ok = (msg) => console.log(`[preference-parity] ok: ${msg}`);

/** Extract the quoted members of a `const NAME = [...]` string-array literal. */
function extractArrayLiteral(src, name) {
  const re = new RegExp(`\\bconst ${name}\\b[^=]*=\\s*\\[([^\\]]*)\\]`, 's');
  const m = src.match(re);
  if (!m) return null;
  const values = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  return values.length > 0 ? values : null;
}

/** Extract the quoted members of a `Set(['a','b'])` literal. */
function extractSetLiteral(src, name) {
  const re = new RegExp(`${name}\\s*=\\s*new Set\\(\\[([^\\]]*)\\]\\)`, 's');
  const m = src.match(re);
  if (!m) return null;
  const values = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  return values.length > 0 ? values : null;
}

/** Extract the quoted members of a union type `type NAME = 'a' | 'b';`. */
function extractUnionType(src, name) {
  const re = new RegExp(`(?:export )?type ${name}\\s*=[^;]*;`, 's');
  const m = src.match(re);
  if (!m) return null;
  const values = [...m[0].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  return values.length > 0 ? values : null;
}

/** Extract the ids of registry items carrying `quickLinkEligible: true`.
 *  Pairs each quoted `value:` in the registry array with the
 *  `quickLinkEligible:` flag in the same item and counts the pairs; the
 *  caller fails the comparison when the pair count disagrees with the number
 *  of `quickLinkEligible:` flags in the source, so a refactor that renames
 *  either property (breaking the pairing) cannot pass vacuously. */
function extractEligibleIds(src) {
  const items = [...src.matchAll(/value:\s*'([^']+)'[\s\S]*?quickLinkEligible:\s*(true|false)/g)];
  const eligible = [];
  for (const [, value, flag] of items) {
    if (flag === 'true') eligible.push(value);
  }
  return { eligible: eligible.length > 0 ? eligible : null, paired: items.length };
}

function compare(label, backend, frontend) {
  if (!backend || !frontend) {
    fail(`${label}: could not extract declaration (backend=${JSON.stringify(backend)}, frontend=${JSON.stringify(frontend)})`);
    return;
  }
  const b = [...backend].sort().join(',');
  const f = [...frontend].sort().join(',');
  if (b !== f) {
    fail(`${label}: backend [${b}] != frontend [${f}]`);
    return;
  }
  ok(`${label}: ${backend.length} values match`);
}

function compareCount(label, expected, actual) {
  if (expected !== actual) {
    fail(`${label}: expected ${expected} paired declarations, found ${actual} (extractor out of date?)`);
    return;
  }
  ok(`${label}: ${actual} paired declarations extracted`);
}

// Backend declarations (string-array tables).
const bThemes = extractArrayLiteral(routeSrc, 'THEME_MODES');
const bAccents = extractArrayLiteral(routeSrc, 'ACCENT_IDS');
const bUiFonts = extractArrayLiteral(routeSrc, 'UI_FONT_IDS');
const bMonoFonts = extractArrayLiteral(routeSrc, 'MONO_FONT_IDS');
const bVisual = extractArrayLiteral(routeSrc, 'VISUAL_STYLES');
const bHeading = extractArrayLiteral(routeSrc, 'HEADING_STYLES');
const bChart = extractArrayLiteral(routeSrc, 'CHART_STYLES');
const bDensities = extractArrayLiteral(routeSrc, 'DENSITIES');
const bLogChip = extractArrayLiteral(routeSrc, 'LOG_CHIP_COLOR_MODES');
const bNavModes = extractArrayLiteral(routeSrc, 'NAV_MODES');
const bAligns = extractArrayLiteral(routeSrc, 'NAV_ALIGNS');
const bQuickLinks = extractArrayLiteral(routeSrc, 'QUICK_LINK_IDS');

// Frontend declarations (union types and Set literals).
const fThemes = extractUnionType(themeSrc, 'ThemeMode');
const fAccents = extractUnionType(themeSrc, 'AccentId');
const fUiFonts = extractUnionType(themeSrc, 'UiFont');
const fMonoFonts = extractUnionType(themeSrc, 'MonoFont');
const fVisual = extractArrayLiteral(themeSrc, 'VISUAL_STYLES');
const fHeading = extractArrayLiteral(themeSrc, 'HEADING_STYLES');
const fChart = extractArrayLiteral(themeSrc, 'CHART_STYLES');
const fDensity = extractUnionType(densitySrc, 'Density');
const fLogChip = extractUnionType(logChipSrc, 'LogChipColorMode');
const fNavModes = extractSetLiteral(navModeSrc, 'VALID') ?? extractUnionType(navModeSrc, 'TopNavMode');
const fAligns = extractUnionType(navAlignSrc, 'TopNavAlign');
const fEligible = extractEligibleIds(navRegistrySrc);
compare('theme modes', bThemes, fThemes);
compare('accents', bAccents, fAccents);
compare('ui fonts', bUiFonts, fUiFonts);
compare('mono fonts', bMonoFonts, fMonoFonts);
compare('visual styles', bVisual, fVisual);
compare('heading styles', bHeading, fHeading);
compare('chart styles', bChart, fChart);
compare('densities', bDensities, fDensity);
compare('log chip color modes', bLogChip, fLogChip);
compare('nav modes', bNavModes, fNavModes);
compare('nav aligns', bAligns, fAligns);

// Quick links: the backend list must be a superset of the frontend's
// eligible ids (the backend rejects unknown ids; headroom allows the
// frontend cap to grow without a 400 on previously saved documents). The
// paired-declaration guard additionally proves the registry extractor still
// matches every `quickLinkEligible:` flag in the source, so a refactor that
// renames the property cannot make the check pass vacuously.
if (!bQuickLinks || !fEligible) {
  fail(`quick links: could not extract declaration (backend=${bQuickLinks?.length} frontend=${fEligible?.eligible?.length})`);
} else {
  compareCount('quick links pairing', (navRegistrySrc.match(/    quickLinkEligible:/g) ?? []).length, fEligible.paired);
  const missing = fEligible.eligible.filter((id) => !bQuickLinks.includes(id));
  if (missing.length > 0) {
    fail(`quick links: frontend eligible ids missing from backend enum: ${missing.join(', ')}`);
  } else {
    ok(`quick links: all ${fEligible.eligible.length} frontend eligible ids present in backend enum (${bQuickLinks.length} entries)`);
  }
}

if (failed) {
  console.error('[preference-parity] value-set drift detected; update both sides in the same change.');
  process.exit(1);
}
console.log('[preference-parity] all value sets match.');
