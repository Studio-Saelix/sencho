import GitOpsStateCard from '@/components/gitops/GitOpsStateCard';
import { GitOpsDigestDetail } from '@/components/gitops/GitOpsDigestDetail';
import { ShortId } from '@/components/gitops/GitOpsShortId';
import { RUNTIME_STATE_LOOKUP, stateOrUnrecognized } from '@/lib/gitopsState';
import type { GitOpsTargetProjection, ObservedArtifactIdentity } from '@/types/gitops';

function observedArtifactLine(observed: ObservedArtifactIdentity): string {
  switch (observed.kind) {
    case 'unknown':
      return 'observed artifact unknown';
    case 'missing':
      return 'no running artifact observed';
    case 'unavailable':
      return 'observed artifact unavailable';
    case 'exact':
      return `observed ${observed.identity}`;
    case 'qualified':
      return `observed ${observed.identity} (qualified)`;
    case 'stale':
      return `observed ${observed.identity} (stale)`;
    case 'local_build_unverified':
      return `observed ${observed.identity} (local build, unverified)`;
    default: {
      // A kind from a newer build: say so rather than end the line blank.
      const kind: string = (observed as { kind: string }).kind;
      return `observed artifact of unrecognized kind "${kind}"`;
    }
  }
}

/**
 * One target's observed state, shared by the GitOps application view and the
 * rollout preview so both report a target the same way. Presentation only:
 * every value comes from the projection the caller was handed.
 */
export function GitOpsTargetCard({ target, nodeName }: { target: GitOpsTargetProjection; nodeName: string }) {
  return (
    <GitOpsStateCard
      data-testid="gitops-target"
      stateKey={target.runtime.status}
      state={stateOrUnrecognized(RUNTIME_STATE_LOOKUP[target.runtime.status], target.runtime.status)}
    >
      <div className="mt-1 space-y-0.5 font-mono text-[10px] text-stat-subtitle">
        <div>{nodeName}{target.stackName ? ` · ${target.stackName}` : ''}</div>
        <div>
          health {target.health.status} · {target.connectivity} · last known good {target.lkg.status}
          {target.tombstoned ? ' · retired' : ''}
        </div>
        <div className="truncate">
          deployed <ShortId value={target.deployedGenerationId} /> · {observedArtifactLine(target.observedArtifactIdentity)}
        </div>
      </div>
      <GitOpsDigestDetail target={target} />
    </GitOpsStateCard>
  );
}
