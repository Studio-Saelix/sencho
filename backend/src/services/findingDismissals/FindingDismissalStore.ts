import { DatabaseService } from '../DatabaseService';
import type { DismissalMode, DismissalSurface, FindingDismissalRow } from './types';

/** What a dismissal records about the finding it hides, read from the server's own evaluation. */
export interface DismissedFindingFacts {
  nodeId: number;
  surface: DismissalSurface;
  findingKey: string;
  stackName: string | null;
  fingerprint: string;
  severity: string;
  count: number;
}

export interface DismissalRequest {
  mode: DismissalMode;
  expiresAt: number | null;
  createdBy: string;
  now: number;
}

export interface DismissalWriteResult {
  row: FindingDismissalRow;
  /** True when a stronger dismissal already covered the finding and was kept as is. */
  kept: boolean;
}

/**
 * How long a dismissal holds relative to another, by mode tier only:
 * `forever` over an unexpired `days` over `until_change`. A `days` row that has
 * already expired holds nothing. Expiry dates are not compared, so a later
 * "7 days" replaces an earlier "30 days".
 */
function holdRank(mode: DismissalMode, expiresAt: number | null, now: number): number {
  if (mode === 'forever') return 3;
  if (mode === 'days') return expiresAt !== null && expiresAt > now ? 2 : 0;
  return 1;
}

/**
 * The hub's finding dismissals. The SQL lives here; the table is created in
 * `initSchema` and cleared on node delete, both in DatabaseService.
 */
export class FindingDismissalStore {
  private static instance: FindingDismissalStore | null = null;

  static getInstance(): FindingDismissalStore {
    if (!FindingDismissalStore.instance) FindingDismissalStore.instance = new FindingDismissalStore();
    return FindingDismissalStore.instance;
  }

  private get db() {
    return DatabaseService.getInstance().getDb();
  }

  list(surface: DismissalSurface): FindingDismissalRow[] {
    return this.db.prepare(
      'SELECT * FROM finding_dismissals WHERE surface = ? ORDER BY created_at DESC, id DESC',
    ).all(surface) as FindingDismissalRow[];
  }

  get(id: number): FindingDismissalRow | null {
    return (this.db.prepare('SELECT * FROM finding_dismissals WHERE id = ?').get(id) as FindingDismissalRow | undefined) ?? null;
  }

  private getByKey(nodeId: number, surface: DismissalSurface, findingKey: string): FindingDismissalRow | null {
    return (this.db.prepare(
      'SELECT * FROM finding_dismissals WHERE node_id = ? AND surface = ? AND finding_key = ?',
    ).get(nodeId, surface, findingKey) as FindingDismissalRow | undefined) ?? null;
  }

  /**
   * Dismiss a finding. A second dismissal never weakens one that still covers
   * the finding as it reads now and holds longer: a `forever` stays `forever`
   * when someone else dismisses "until it changes", and the caller learns it
   * from `kept`. A row that no longer covers the finding (it got worse, or its
   * count grew) is replaced, otherwise the finding would stay listed with no
   * way to dismiss it again.
   */
  dismiss(facts: DismissedFindingFacts, request: DismissalRequest): DismissalWriteResult {
    if ((request.mode === 'days') !== (request.expiresAt !== null)) {
      throw new Error('A timed dismissal needs an expiry, and any other mode must not have one');
    }
    return this.db.transaction((): DismissalWriteResult => {
      const existing = this.getByKey(facts.nodeId, facts.surface, facts.findingKey);
      if (
        existing
        && existing.fingerprint === facts.fingerprint
        && existing.severity === facts.severity
        && existing.count_at >= facts.count
        && holdRank(existing.mode, existing.expires_at, request.now) > holdRank(request.mode, request.expiresAt, request.now)
      ) {
        return { row: existing, kept: true };
      }
      if (existing) this.db.prepare('DELETE FROM finding_dismissals WHERE id = ?').run(existing.id);
      const result = this.db.prepare(
        `INSERT INTO finding_dismissals
           (node_id, surface, finding_key, stack_name, fingerprint, severity, count_at,
            mode, expires_at, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        facts.nodeId, facts.surface, facts.findingKey, facts.stackName, facts.fingerprint,
        facts.severity, facts.count, request.mode, request.expiresAt, request.createdBy, request.now,
      );
      const row = this.get(Number(result.lastInsertRowid));
      if (!row) throw new Error('A dismissal was inserted but could not be read back');
      return { row, kept: false };
    })();
  }

  delete(id: number): boolean {
    return this.db.prepare('DELETE FROM finding_dismissals WHERE id = ?').run(id).changes > 0;
  }

  deleteMany(ids: readonly number[]): number {
    if (ids.length === 0) return 0;
    const statement = this.db.prepare('DELETE FROM finding_dismissals WHERE id = ?');
    return this.db.transaction(() => ids.reduce((sum, id) => sum + statement.run(id).changes, 0))();
  }
}
