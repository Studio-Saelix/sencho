/**
 * Shared severity ranking, reused by the Overview top-N attention list and the
 * Findings tab grouping, so the two views can never disagree on ordering.
 */
import type { NetworkingFinding, NetworkingFindingSeverity } from './networkingTypes';

export const NETWORKING_SEVERITY_RANK: Record<NetworkingFindingSeverity, number> = {
  info: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** Severity descending; at equal severity, a live-sourced finding ranks ahead of a
 *  Doctor-only finding (cached data should not outrank current runtime truth). */
export function compareFindingsForRanking(a: NetworkingFinding, b: NetworkingFinding): number {
  const rankDiff = NETWORKING_SEVERITY_RANK[b.severity] - NETWORKING_SEVERITY_RANK[a.severity];
  if (rankDiff !== 0) return rankDiff;
  const aIsLive = a.sources.includes('live');
  const bIsLive = b.sources.includes('live');
  if (aIsLive !== bIsLive) return aIsLive ? -1 : 1;
  return 0;
}

export function rankFindings(findings: NetworkingFinding[]): NetworkingFinding[] {
  return [...findings].sort(compareFindingsForRanking);
}

export type NetworkingFindingGroup = 'needs-action' | 'review-recommended' | 'informational';

export function groupForSeverity(severity: NetworkingFindingSeverity): NetworkingFindingGroup {
  if (severity === 'critical' || severity === 'high') return 'needs-action';
  if (severity === 'medium') return 'review-recommended';
  return 'informational';
}
