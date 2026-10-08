import type { DismissPolicy, FindingDismissal } from '@/types/findingDismissal';

/** What a dismissal is compared against: the finding as the server publishes it now. */
export interface DismissableFinding {
  id: string;
  fingerprint: string;
  severity: string;
  count: number;
  /** Absent means the surface has no policy; present, it can end a dismissal made under a looser one. */
  dismissPolicy?: DismissPolicy;
}

/**
 * A surface's severity vocabulary, most severe first, and the words that mean
 * "not verified" rather than "fine". Moving from a verified word into one of
 * those is a regression to unknown, so it lifts a dismissal the same way
 * becoming more severe does.
 */
export interface SeverityScale {
  order: readonly string[];
  unverified: readonly string[];
}

export const READINESS_SEVERITY_SCALE: SeverityScale = {
  order: ['attention', 'degraded', 'unavailable', 'unknown'],
  unverified: ['unavailable', 'unknown'],
};

/** Networking severities, most severe first. `info` is the floor, so nothing there is "unverified". */
export const NETWORKING_SEVERITY_SCALE: SeverityScale = {
  order: ['critical', 'high', 'medium', 'info'],
  unverified: [],
};

function becameWorse(stored: string, current: string, scale: SeverityScale): boolean {
  if (stored === current) return false;
  const storedRank = scale.order.indexOf(stored);
  const currentRank = scale.order.indexOf(current);
  // A word this build does not know is not provably the same, so it lifts.
  if (storedRank < 0 || currentRank < 0) return true;
  if (currentRank < storedRank) return true;
  return scale.unverified.includes(current) && !scale.unverified.includes(stored);
}

/**
 * Whether a dismissal still covers a finding.
 *
 * It lifts when the finding got worse (became more severe, fell into unknown, or
 * its count grew), whatever the mode. It also lifts when the finding's policy no
 * longer allows the mode it was dismissed under, so a code later reclassified
 * cannot stay hidden. Past that, `until_change` lifts when the fingerprint moves
 * and `days` lifts when its time is up. `forever` holds until restored or worsened.
 * The hub applies the same rule (`dismissalCovers`) when it retires rows.
 */
export function isDismissalActive(
  finding: DismissableFinding,
  dismissal: FindingDismissal,
  now: number,
  scale: SeverityScale,
): boolean {
  if (finding.dismissPolicy === 'none') return false;
  if (finding.dismissPolicy === 'timed' && dismissal.mode !== 'days') return false;
  if (becameWorse(dismissal.severity, finding.severity, scale)) return false;
  if (finding.count > dismissal.count) return false;
  switch (dismissal.mode) {
    case 'until_change':
      return finding.fingerprint === dismissal.fingerprint;
    case 'days':
      return dismissal.expiresAt !== null && dismissal.expiresAt > now;
    case 'forever':
      return true;
    default:
      // A mode this build does not know holds nothing: an unreadable decision
      // must never hide a finding.
      return false;
  }
}

export interface DismissedFinding<T> {
  finding: T;
  dismissal: FindingDismissal;
}

export interface FindingPartition<T> {
  active: T[];
  dismissed: DismissedFinding<T>[];
}

/**
 * Split findings into the ones to show and the ones a team dismissal still
 * covers. Pure: nothing is dropped, so the caller keeps counting the dismissed.
 */
export function partitionFindings<T extends DismissableFinding>(
  findings: readonly T[],
  dismissals: readonly FindingDismissal[],
  now: number,
  scale: SeverityScale,
): FindingPartition<T> {
  const byKey = new Map(dismissals.map(dismissal => [dismissal.findingKey, dismissal]));
  const active: T[] = [];
  const dismissed: DismissedFinding<T>[] = [];
  for (const finding of findings) {
    const dismissal = byKey.get(finding.id);
    if (dismissal !== undefined && isDismissalActive(finding, dismissal, now, scale)) {
      dismissed.push({ finding, dismissal });
    } else {
      active.push(finding);
    }
  }
  return { active, dismissed };
}
