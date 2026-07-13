import type { NetworkingFinding, NetworkingFindingSeverity } from '@/types/networking';

export const NETWORKING_SEVERITY_RANK: Record<NetworkingFindingSeverity, number> = {
  info: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** Text color per severity, shared by the Overview attention list and the Findings tab. */
export const SEVERITY_TEXT_CLASS: Record<NetworkingFindingSeverity, string> = {
  info: 'text-stat-subtitle',
  medium: 'text-warning',
  high: 'text-destructive',
  critical: 'text-destructive',
};

/** Severity descending; at equal severity a live-sourced finding ranks ahead of a
 *  Doctor-only finding, mirroring the backend ranking helper. */
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

export const FINDING_GROUP_LABELS: Record<NetworkingFindingGroup, string> = {
  'needs-action': 'Needs action',
  'review-recommended': 'Review recommended',
  informational: 'Informational',
};

export function groupForSeverity(severity: NetworkingFindingSeverity): NetworkingFindingGroup {
  if (severity === 'critical' || severity === 'high') return 'needs-action';
  if (severity === 'medium') return 'review-recommended';
  return 'informational';
}

export function groupFindings(findings: NetworkingFinding[]): Record<NetworkingFindingGroup, NetworkingFinding[]> {
  const ranked = rankFindings(findings);
  const groups: Record<NetworkingFindingGroup, NetworkingFinding[]> = {
    'needs-action': [],
    'review-recommended': [],
    informational: [],
  };
  for (const f of ranked) groups[groupForSeverity(f.severity)].push(f);
  return groups;
}

/** Label for a finding's source provenance, so cached Doctor findings never read as current runtime facts. */
export function findingSourceLabel(finding: Pick<NetworkingFinding, 'sources' | 'doctorFindings'>): string | null {
  const isLive = finding.sources.includes('live');
  const isDoctor = finding.sources.includes('doctor');
  if (isLive && isDoctor) return 'Live · also found by Doctor';
  if (isDoctor && !isLive) {
    const ranAt = finding.doctorFindings[0]?.ranAt;
    return ranAt ? `Last Doctor run · ${new Date(ranAt).toLocaleString()}` : 'Last Doctor run';
  }
  return null;
}
