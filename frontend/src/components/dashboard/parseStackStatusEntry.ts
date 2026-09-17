import type { StackStatusEntry } from './types';

const VALID_STACK_STATUS_VALUES = new Set(['running', 'exited', 'unknown', 'partial']);

/** Accept only non-empty strings; dedupe and sort. Malformed values become omitted. */
export function sanitizeNetworks(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = new Set<string>();
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) names.add(item);
  }
  if (names.size === 0) return undefined;
  return [...names].sort((a, b) => a.localeCompare(b));
}

/**
 * Parse a bulk-status map entry. Canonical status is required. Optional
 * networks are sanitized independently so a bad array cannot drop a valid row.
 */
export function parseStackStatusEntry(value: unknown): StackStatusEntry | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as {
    status?: unknown;
    mainPort?: unknown;
    runningSince?: unknown;
    source?: unknown;
    networks?: unknown;
  };
  if (typeof raw.status !== 'string' || !VALID_STACK_STATUS_VALUES.has(raw.status)) {
    return null;
  }
  const entry: StackStatusEntry = {
    status: raw.status as StackStatusEntry['status'],
  };
  if (typeof raw.mainPort === 'number') entry.mainPort = raw.mainPort;
  if (typeof raw.runningSince === 'number') entry.runningSince = raw.runningSince;
  if (raw.source === 'local' || raw.source === 'git') entry.source = raw.source;
  const networks = sanitizeNetworks(raw.networks);
  if (networks) entry.networks = networks;
  return entry;
}

export type ParsedStatusesMap =
  | { kind: 'ok'; entries: Record<string, StackStatusEntry> }
  | { kind: 'invalid' };

/**
 * Parse a bulk `/stacks/statuses` body. A non-empty map whose every entry
 * fails validation is invalid, not confirmed-empty.
 */
export function parseStackStatusesMap(body: unknown): ParsedStatusesMap {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'invalid' };
  }
  const rawEntries = Object.entries(body as Record<string, unknown>);
  const entries: Record<string, StackStatusEntry> = {};
  for (const [file, entry] of rawEntries) {
    const parsed = parseStackStatusEntry(entry);
    if (parsed) {
      entries[file] = parsed;
    } else {
      console.error('[Dashboard] Dropped malformed stack status entry:', file, entry);
    }
  }
  if (rawEntries.length > 0 && Object.keys(entries).length === 0) {
    return { kind: 'invalid' };
  }
  return { kind: 'ok', entries };
}
