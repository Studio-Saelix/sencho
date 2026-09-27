import GitOpsStateCard from '@/components/gitops/GitOpsStateCard';
import {
  ARTIFACT_STATE_LOOKUP,
  ROLLOUT_STATE_LOOKUP,
  SOURCE_STATE_LOOKUP,
  placementStateMeta,
  stateOrUnrecognized,
} from '@/lib/gitopsState';
import {
  POLICY_DOMAIN_LABEL,
  policyDecisionLabel,
  policyReadFor,
  policyValueLabel,
  placementReasonText,
} from '@/lib/gitopsAuthorityPolicy';
import type {
  ArtifactFacet,
  AuthorityPolicyRead,
  PlacementFacet,
  RolloutFacet,
  SourceFacet,
} from '@/types/gitops';

/**
 * The one line a facet card carries for its own policy.
 *
 * Two facts and nothing else: who is configured to decide this stage, and what
 * that policy actually did to the work in flight. The second is a separate fact
 * from the first, because a policy edited after a rollout opened does not
 * retroactively claim it, and a card that showed only the configured value would
 * read as though it had.
 *
 * A card with no recorded decision and no reason renders nothing, so the line is
 * never a restatement of the card's own state. That is the common case and the
 * reason the row does not appear on every application.
 */
function PolicyLine({ read }: { read: AuthorityPolicyRead | null }) {
  if (!read) return null;
  const reason = read.reason ? placementReasonText(read.reason) : null;
  const decided = read.decision !== 'awaiting_operator' || reason;
  if (!reason && !decided) return null;
  return (
    <div data-testid="gitops-policy-line" className="mt-1.5 space-y-0.5">
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
 * The four application facet cards in reading order: source, executable
 * artifact, placement, rollout. Shared by the application view and the rollout
 * preview so the same evidence cannot read two different ways. Callers pass the
 * live facets they resolved; a facet that does not apply renders nothing.
 *
 * Each card that governs a decision carries that decision's policy line. Source,
 * placement and rollout each govern one, so the same evidence reads the same way
 * on both surfaces, and the artifact card carries none because it governs no
 * decision: it reports what was built, not who may act.
 */
export function GitOpsFacetCards({ source, artifact, placement, rollout, authorityPolicies }: {
  source: SourceFacet | null;
  artifact: ArtifactFacet | null;
  placement: PlacementFacet | null;
  rollout: RolloutFacet | null;
  /**
   * The three policy reads. Optional so a caller that has not resolved them
   * renders the cards unchanged rather than crashing, and so a surface can never
   * be built that shows a card without its policy by omission.
   */
  authorityPolicies?: readonly AuthorityPolicyRead[];
}) {
  return (
    <>
      {source && (
        <GitOpsStateCard
          data-testid="gitops-source"
          stateKey={source.status}
          state={stateOrUnrecognized(SOURCE_STATE_LOOKUP[source.status], source.status)}
        >
          <PolicyLine read={policyReadFor(authorityPolicies, 'source')} />
        </GitOpsStateCard>
      )}
      {artifact && (
        <GitOpsStateCard
          data-testid="gitops-artifact"
          stateKey={artifact.status}
          state={stateOrUnrecognized(ARTIFACT_STATE_LOOKUP[artifact.status], artifact.status)}
        />
      )}
      {placement && (
        <GitOpsStateCard
          data-testid="gitops-placement"
          stateKey={placement.status}
          state={stateOrUnrecognized(placementStateMeta(placement), placement.status)}
        >
          <PolicyLine read={policyReadFor(authorityPolicies, 'placement')} />
        </GitOpsStateCard>
      )}
      {rollout && (
        <GitOpsStateCard
          data-testid="gitops-rollout"
          stateKey={rollout.status}
          state={stateOrUnrecognized(ROLLOUT_STATE_LOOKUP[rollout.status], rollout.status)}
        >
          {rollout.status === 'rollout_paused' && rollout.pauseReason && (
            <div className="mt-1 font-mono text-[11px] text-stat-subtitle">{rollout.pauseReason}</div>
          )}
          <PolicyLine read={policyReadFor(authorityPolicies, 'rollout_authorization')} />
        </GitOpsStateCard>
      )}
    </>
  );
}
