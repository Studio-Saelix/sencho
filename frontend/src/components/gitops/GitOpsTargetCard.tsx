import GitOpsStateCard from '@/components/gitops/GitOpsStateCard';
import { GitOpsDigestDetail } from '@/components/gitops/GitOpsDigestDetail';
import { ShortId } from '@/components/gitops/GitOpsShortId';
import {
  HEALTH_ROLLOUT_POLICY_STATE,
  HEALTH_STOP_REASON_STATE,
  RUNTIME_STATE_LOOKUP,
  stateOrUnrecognized,
} from '@/lib/gitopsState';
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
 * What the health-gated rollout is doing with this target.
 *
 * Reads only the projection, so the card and the rollout controls cannot
 * disagree about why a rollout stopped. Nothing is rendered for a target under
 * no health policy, because a target that was never gated has no story to tell
 * and an empty row would imply one.
 */
function healthGateLine(target: GitOpsTargetProjection) {
  // Optional, because a remote running an older version can answer a schema
  // version 1 projection with no health gate in it at all. Absent is the same
  // answer as never gated, which is what such a target is, so it renders nothing
  // rather than reading undefined.
  const gate = target.healthGate;
  if (!gate) return null;
  const { policy, stopReason, attempts, awaitingRunId, recoveryAvailable } = gate;
  if (policy === null && stopReason === null && awaitingRunId === null) return null;
  const policyMeta = policy === null
    ? null
    : stateOrUnrecognized(HEALTH_ROLLOUT_POLICY_STATE[policy], policy);
  const reasonMeta = stopReason === null
    ? null
    : stateOrUnrecognized(HEALTH_STOP_REASON_STATE[stopReason], stopReason);
  const parts: string[] = [];
  if (policyMeta) parts.push(`health policy ${policyMeta.label}`);
  if (awaitingRunId) parts.push('awaiting its verdict');
  if (attempts > 0) parts.push(`${attempts} ${attempts === 1 ? 'retry' : 'retries'}`);
  if (reasonMeta) parts.push(reasonMeta.label);
  if (!recoveryAvailable && policy === 'rollback') parts.push('no pre-rollout generation captured');
  return (
    <div className="truncate" title={reasonMeta?.line ?? policyMeta?.line}>
      {parts.join(' · ')}
    </div>
  );
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
        {healthGateLine(target)}
      </div>
      <GitOpsDigestDetail target={target} />
    </GitOpsStateCard>
  );
}
