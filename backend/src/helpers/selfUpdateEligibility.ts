/**
 * Bounded vocabulary for "why can this node not recreate its own Compose
 * configuration". Shared by the node (SelfUpdateService, /api/meta), the hub
 * (/api/fleet/update-status) and the frontend copy map, so every surface names
 * the same reason. Deliberately a closed enum: no hosts, paths, container names
 * or error text can leak through the public meta endpoint.
 */
export const SELF_UPDATE_UNAVAILABLE_CODES = [
  'not_in_container',
  'container_unidentified',
  'docker_unreachable',
  'not_compose_managed',
  'compose_cli_unavailable',
  'image_unknown',
  'detecting',
] as const;

export type SelfUpdateUnavailableCode = (typeof SELF_UPDATE_UNAVAILABLE_CODES)[number];

/**
 * Hub-side reason for a Fleet row. Adds the two cases only the hub can see: a
 * node whose /api/meta did not answer, and a node too old to report a code.
 */
export type ReapplyUnavailableReason = SelfUpdateUnavailableCode | 'node_unreachable' | 'node_outdated';

/**
 * Error `code` of a reapply refused because the node cannot recreate itself. The
 * body also carries the bounded `reason`, so a client names the node and the
 * cause instead of showing the transport's generic failure.
 */
// The frontend matches this string literally (useComposeReapplyAction.ts).
export const REAPPLY_UNAVAILABLE_CODE = 'REAPPLY_UNAVAILABLE';

/**
 * Codes worth retrying: Docker was not answering yet, the identity probe could
 * not settle, or the Compose CLI check failed. Every other code is a property
 * of the install that a retry cannot change.
 */
export const TRANSIENT_SELF_UPDATE_UNAVAILABLE_CODES: ReadonlySet<SelfUpdateUnavailableCode> = new Set([
  'container_unidentified',
  'docker_unreachable',
  'compose_cli_unavailable',
]);

const KNOWN_CODES: ReadonlySet<string> = new Set(SELF_UPDATE_UNAVAILABLE_CODES);

/** Narrow an arbitrary value from a remote meta body to the bounded enum. */
export function parseSelfUpdateUnavailableCode(value: unknown): SelfUpdateUnavailableCode | null {
  return typeof value === 'string' && KNOWN_CODES.has(value)
    ? (value as SelfUpdateUnavailableCode)
    : null;
}

export const SELF_UPDATE_RETRY_INITIAL_MS = 5_000;
export const SELF_UPDATE_RETRY_MAX_MS = 60_000;

/** Next backoff step: double the current delay, capped at one minute. */
export function nextSelfUpdateRetryDelay(currentMs: number): number {
  return Math.min(Math.max(currentMs, 1) * 2, SELF_UPDATE_RETRY_MAX_MS);
}
