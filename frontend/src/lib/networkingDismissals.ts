import type { FindingDismissal } from '@/types/findingDismissal';
import type { NetworkingFinding } from '@/types/networking';
import { NETWORKING_SEVERITY_SCALE, partitionFindings } from '@/lib/findingDismissals';

/** The store's key for a finding on one node. The aggregate is per node, so the node is part of what a dismissal names. */
export function networkingDismissalKey(nodeId: number, findingId: string): string {
  return `networking:${nodeId}:${findingId}`;
}

/** A finding set aside, and what set it aside: a team dismissal, or (null) an acknowledgement in Compose Doctor. */
export interface DismissedNetworkingFinding {
  finding: NetworkingFinding;
  dismissal: FindingDismissal | null;
}

export interface NetworkingPartition {
  active: NetworkingFinding[];
  dismissed: DismissedNetworkingFinding[];
}

/**
 * Splits a node's findings into the ones to show and the ones set aside.
 *
 * Pure, and nothing is dropped: the caller keeps counting every finding for the
 * posture word and the masthead. A finding from a node that sends no
 * fingerprint carries `dismissPolicy: 'none'` and so is always active.
 */
export function partitionNetworkingFindings(
  findings: readonly NetworkingFinding[],
  dismissals: readonly FindingDismissal[],
  nodeId: number,
  now: number,
): NetworkingPartition {
  const keyed = findings
    .filter(finding => finding.acknowledged !== true)
    .map(finding => ({ ...finding, id: networkingDismissalKey(nodeId, finding.id), original: finding }));
  const { active, dismissed } = partitionFindings(keyed, dismissals, now, NETWORKING_SEVERITY_SCALE);
  return {
    active: active.map(item => item.original),
    dismissed: [
      ...dismissed.map(item => ({ finding: item.finding.original, dismissal: item.dismissal })),
      ...findings.filter(finding => finding.acknowledged === true).map(finding => ({ finding, dismissal: null })),
    ],
  };
}

/** The findings that still count toward the posture word: every one except those acknowledged in Doctor, as before dismissals existed. */
export function countedFindings(findings: readonly NetworkingFinding[]): NetworkingFinding[] {
  return findings.filter(finding => finding.acknowledged !== true);
}
