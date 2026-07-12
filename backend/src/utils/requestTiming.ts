import { isDebugEnabled } from './debug';
import { sanitizeForLog } from './safeLog';

/**
 * Developer-mode hydration timing helpers.
 *
 * These emit one structured line per instrumented request via console.debug,
 * gated on the same `developer_mode` flag as every other diagnostic log. The
 * lines carry durations, counts, and outcomes only. Callers must never place
 * a raw URL, query string, or token into `fields`; use templatizeHydrationPath
 * for paths so a real stack name can never reach the log.
 */

/** Render one field value: numbers/booleans verbatim, everything else sanitized. */
function formatFieldValue(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return String(value);
  return sanitizeForLog(value);
}

/**
 * Emit a `<prefix> key=value ...` timing line, but only when developer_mode is
 * enabled. String values are control-char stripped to prevent log injection.
 */
export function logDebugTiming(prefix: string, fields: Record<string, unknown>): void {
  if (!isDebugEnabled()) return;
  const rendered = Object.entries(fields)
    .map(([key, value]) => `${key}=${formatFieldValue(value)}`)
    .join(' ');
  console.debug(`${prefix} ${rendered}`);
}

/**
 * Critical hydration GET route templates, ordered most-specific-first so the
 * bare `/api/stacks` collection never shadows a nested match. The templates
 * are static strings, so a real stack name is never substituted back in.
 */
const HYDRATION_PATH_TEMPLATES: ReadonlyArray<{ pattern: RegExp; template: string }> = [
  { pattern: /^\/api\/stacks\/statuses$/, template: '/api/stacks/statuses' },
  { pattern: /^\/api\/stacks\/[^/]+\/containers$/, template: '/api/stacks/:stack/containers' },
  { pattern: /^\/api\/stacks$/, template: '/api/stacks' },
  { pattern: /^\/api\/image-updates\/status$/, template: '/api/image-updates/status' },
  { pattern: /^\/api\/image-updates\/detail$/, template: '/api/image-updates/detail' },
  { pattern: /^\/api\/notifications$/, template: '/api/notifications' },
];

/**
 * Map a request path to a stable route template for logging. The query string
 * is stripped before matching, and only the critical hydration GETs resolve;
 * any other path returns null so callers skip logging. The returned value is
 * always a fixed template (e.g. `/api/stacks/:stack/containers`), never a path
 * segment taken from the request.
 */
export function templatizeHydrationPath(rawPath: string): string | null {
  const pathname = rawPath.split('?')[0];
  for (const { pattern, template } of HYDRATION_PATH_TEMPLATES) {
    if (pattern.test(pathname)) return template;
  }
  return null;
}
