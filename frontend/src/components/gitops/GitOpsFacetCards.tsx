import GitOpsStateCard from '@/components/gitops/GitOpsStateCard';
import {
  ARTIFACT_STATE_LOOKUP,
  ROLLOUT_STATE_LOOKUP,
  SOURCE_STATE_LOOKUP,
  placementStateMeta,
  stateOrUnrecognized,
} from '@/lib/gitopsState';
import type { ArtifactFacet, PlacementFacet, RolloutFacet, SourceFacet } from '@/types/gitops';

/**
 * The four application facet cards in reading order: source, executable
 * artifact, placement, rollout. Shared by the application view and the rollout
 * preview so the same evidence cannot read two different ways. Callers pass the
 * live facets they resolved; a facet that does not apply renders nothing.
 */
export function GitOpsFacetCards({ source, artifact, placement, rollout }: {
  source: SourceFacet | null;
  artifact: ArtifactFacet | null;
  placement: PlacementFacet | null;
  rollout: RolloutFacet | null;
}) {
  return (
    <>
      {source && (
        <GitOpsStateCard
          data-testid="gitops-source"
          stateKey={source.status}
          state={stateOrUnrecognized(SOURCE_STATE_LOOKUP[source.status], source.status)}
        />
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
        />
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
        </GitOpsStateCard>
      )}
    </>
  );
}
