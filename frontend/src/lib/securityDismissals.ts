import type { FindingDismissal } from '@/types/findingDismissal';
import type { PostureReason } from '@/types/security';
import { SECURITY_SEVERITY_SCALE, partitionFindings } from '@/lib/findingDismissals';

/** The store's key for a reason on one node. The overview is per node, so the node is part of what a dismissal names. */
export function securityDismissalKey(nodeId: number, reasonKey: string): string {
  return `security:${nodeId}:${reasonKey}`;
}

/** A reason set aside, and the team dismissal that set it aside. */
export interface DismissedReason {
  reason: PostureReason;
  dismissal: FindingDismissal;
}

export interface ReasonPartition {
  active: PostureReason[];
  dismissed: DismissedReason[];
}

/**
 * Splits a node's posture reasons into the ones to list and the ones set aside.
 *
 * Pure, and the posture word never reads it: the masthead is derived from every
 * reason. A reason from a remote that sends no key, fingerprint, or policy is
 * always active, so an older remote simply gets no Dismiss.
 */
export function partitionPostureReasons(
  reasons: readonly PostureReason[],
  dismissals: readonly FindingDismissal[],
  nodeId: number,
  now: number,
): ReasonPartition {
  const keyed = reasons.map((reason, index) => ({
    id: reason.key !== undefined ? securityDismissalKey(nodeId, reason.key) : `unkeyed:${index}`,
    fingerprint: reason.fingerprint ?? '',
    severity: reason.severity,
    count: reason.count,
    dismissPolicy: reason.key !== undefined && reason.fingerprint !== undefined ? reason.dismissPolicy ?? 'none' : 'none' as const,
    original: reason,
  }));
  const { active, dismissed } = partitionFindings(keyed, dismissals, now, SECURITY_SEVERITY_SCALE);
  return {
    active: active.map(item => item.original),
    dismissed: dismissed.map(item => ({ reason: item.finding.original, dismissal: item.dismissal })),
  };
}

/** Whether a reason can be dismissed at all: the remote sent the facts, the policy allows it, and it is not a blocker. */
export function isReasonDismissable(reason: PostureReason): boolean {
  return reason.key !== undefined
    && reason.fingerprint !== undefined
    && reason.severity !== 'blocker'
    && reason.dismissPolicy !== undefined
    && reason.dismissPolicy !== 'none';
}
