/**
 * A team decision to stop surfacing one finding until it changes.
 *
 * Dismissals cover attention items that have no domain engine of their own
 * (Compose Doctor acknowledgements, CVE triage, and misconfiguration
 * acknowledgements keep theirs). They never feed a verdict, a gate, or a stored
 * count: they only move a row from the active list to the dismissed list.
 * See docs/internal/adrs/2026-10-08-finding-dismissals.md.
 */

/** The surfaces that keep dismissals in this store. Validated in code, not by a CHECK, so adding one needs no table rebuild. */
export const DISMISSAL_SURFACES = ['readiness'] as const;
export type DismissalSurface = (typeof DISMISSAL_SURFACES)[number];

/**
 * How long a dismissal holds.
 *
 * - `until_change`: until the finding's fingerprint changes, or it gets worse
 *   (its severity rises or falls into unknown, or its count grows).
 * - `days`: until `expires_at`, or until the finding gets worse.
 * - `forever`: until someone restores it, or until the finding gets worse.
 */
export const DISMISSAL_MODES = ['until_change', 'days', 'forever'] as const;
export type DismissalMode = (typeof DISMISSAL_MODES)[number];

export interface FindingDismissalRow {
  id: number;
  node_id: number;
  surface: DismissalSurface;
  finding_key: string;
  stack_name: string | null;
  /** The finding's fingerprint when it was dismissed. */
  fingerprint: string;
  /** The finding's severity word when it was dismissed, in the surface's own vocabulary. */
  severity: string;
  count_at: number;
  mode: DismissalMode;
  expires_at: number | null;
  created_by: string;
  created_at: number;
}

/** The wire shape the frontend partitions findings against. */
export interface FindingDismissal {
  id: number;
  nodeId: number;
  surface: DismissalSurface;
  findingKey: string;
  fingerprint: string;
  severity: string;
  count: number;
  mode: DismissalMode;
  expiresAt: number | null;
  createdBy: string;
  createdAt: number;
}

export function toFindingDismissal(row: FindingDismissalRow): FindingDismissal {
  return {
    id: row.id,
    nodeId: row.node_id,
    surface: row.surface,
    findingKey: row.finding_key,
    fingerprint: row.fingerprint,
    severity: row.severity,
    count: row.count_at,
    mode: row.mode,
    expiresAt: row.expires_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}
