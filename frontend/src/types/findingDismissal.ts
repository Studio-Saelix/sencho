/** How long a dismissal holds. Mirrors the backend `DismissalMode`. */
export type DismissalMode = 'until_change' | 'days' | 'forever';

/**
 * Which modes a finding allows, decided by the server where the code is known:
 * `none` is resolved on another page, `timed` is evidence we could not read (only
 * a dismissal for a set time), `any` allows every mode.
 */
export type DismissPolicy = 'none' | 'timed' | 'any';

/**
 * The surfaces that keep dismissals. The hub store (the backend `DismissalSurface`)
 * holds the first three; `drift` dismissals live on the node's stack ledger and
 * are never sent to `/fleet/dismissals`.
 */
export type DismissalSurface = 'readiness' | 'networking' | 'security' | 'drift';

/** The surfaces whose dismissals the hub store keeps. */
export type HubDismissalSurface = Exclude<DismissalSurface, 'drift'>;

/** One team dismissal as the server publishes it. */
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
