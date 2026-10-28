import { formatRelativeTime } from '@/lib/utils';
import {
  AUTHORITY_POLICY_DOMAINS,
  POLICY_DOMAIN_LABEL,
  policyDecisionLabel,
  policyLineVisible,
  policyReadFor,
  policyValueLabel,
  placementReasonText,
} from '@/lib/gitopsAuthorityPolicy';
import type { AuthorityPolicyRead } from '@/types/gitops';

/**
 * The one block a stage carries for its own policy.
 *
 * Two facts, plus a date for a recorded reason and the frozen value when it differs: who is configured to decide this stage, and what
 * that policy actually did to the work in flight. The second is a separate fact
 * from the first, because a policy edited after a rollout opened does not
 * retroactively claim it, and a line that showed only the configured value would
 * read as though it had.
 *
 * A stage with no recorded decision and no reason renders nothing, so the line is
 * never a restatement of the stage's own state. That is the common case and the
 * reason the row does not appear on every application.
 *
 * A recorded reason is dated. A refusal is written once, when the policy runs,
 * and is cleared only when an operator approves the placement, edits the policy,
 * or a later change re-decides. So a reason recorded because an operation was in
 * flight is still the recorded reason after that operation finishes, and reading
 * it in the present tense told an operator the system was withholding a
 * placement over a conflict that was over. The timestamp the decision already
 * carries says when that claim was true, which is what lets one line serve a
 * reason that has since gone stale.
 */
function PolicyLine({ read }: { read: AuthorityPolicyRead | null }) {
  if (!read || !policyLineVisible(read)) return null;
  const reason = read.reason ? placementReasonText(read.reason) : null;
  // The date needs both halves of the claim. A reason carries no timestamp of
  // its own, so printing one beside a reason would place it in time by
  // association rather than by record, and a missing timestamp therefore
  // suppresses the date line rather than the reason. The reason still prints,
  // because it is the fact and the date is only the correction of its tense.
  const recordedAt = reason && read.decidedAt !== null ? read.decidedAt : null;
  return (
    <div data-testid="gitops-policy-line" className="space-y-0.5">
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
        {POLICY_DOMAIN_LABEL[read.domain]} policy
      </div>
      <div className="font-mono text-[11px] leading-relaxed text-foreground/80">
        {policyValueLabel(read.domain, read.configured)}
      </div>
      <div className="font-mono text-[11px] leading-relaxed text-stat-subtitle">
        {policyDecisionLabel(read)}
        {reason ? ` ${reason}` : ''}
      </div>
      {recordedAt !== null && (
        <div
          data-testid="gitops-policy-recorded"
          className="font-mono text-[11px] leading-relaxed text-stat-subtitle"
        >
          Recorded {formatRelativeTime(Math.floor(recordedAt / 1000))}.
        </div>
      )}
      {read.effectiveFrozen && read.effectiveFrozen !== read.configured && (
        <div
          data-testid="gitops-policy-frozen"
          className="font-mono text-[11px] leading-relaxed text-stat-subtitle"
        >
          In flight under {policyValueLabel(read.domain, read.effectiveFrozen).toLowerCase()}.
        </div>
      )}
    </div>
  );
}

/**
 * The three decision policies for an application, in reading order: source,
 * placement, rollout authorization. Each prints only when it recorded a decision
 * or a reason, so an application with nothing to say renders nothing. Lives in
 * the status Proof, beside the evidence it governs.
 */
export function GitOpsPolicyLines({ authorityPolicies }: { authorityPolicies?: readonly AuthorityPolicyRead[] }) {
  return (
    <>
      {AUTHORITY_POLICY_DOMAINS.map(domain => (
        <PolicyLine key={domain} read={policyReadFor(authorityPolicies, domain)} />
      ))}
    </>
  );
}
