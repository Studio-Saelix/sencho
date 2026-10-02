import type { ReactNode } from 'react';

import { GitOpsDigestDetail } from '@/components/gitops/GitOpsDigestDetail';
import { ShortId } from '@/components/gitops/GitOpsShortId';
import {
  HEALTH_ROLLOUT_POLICY_STATE,
  HEALTH_STOP_REASON_STATE,
  RUNTIME_STATE_LOOKUP,
  stateOrUnrecognized,
} from '@/lib/gitopsState';
import { STATUS_DOT_CLASS } from '@/lib/statusTone';
import { cn } from '@/lib/utils';
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
 * One target's observed state, shared by the GitOps application view, the
 * rollout preview, and the status Proof so every surface reports a target the
 * same way. Presentation only: every value comes from the projection the caller
 * was handed.
 *
 * Quiet by design: a target is evidence behind the application's Answer, not a
 * second Answer, so it carries a tone dot rather than a tinted card.
 */
export function GitOpsTargetCard({ target, nodeName, extra }: {
  target: GitOpsTargetProjection;
  nodeName: string;
  /** Surface-specific lines, such as how fresh this node's observation is. */
  extra?: ReactNode;
}) {
  const state = stateOrUnrecognized(RUNTIME_STATE_LOOKUP[target.runtime.status], target.runtime.status);
  const Icon = state.icon;
  return (
    <div
      data-testid="gitops-target"
      data-state={target.runtime.status}
      className="rounded-md border border-card-border bg-card/40 px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT_CLASS[state.tone])} />
        <Icon className="h-3.5 w-3.5 shrink-0 text-stat-subtitle" strokeWidth={1.5} aria-hidden />
        <span className="font-mono text-[11px] uppercase tracking-wide">{state.label}</span>
      </div>
      <div className="mt-1 font-mono text-[11px] leading-relaxed text-foreground/80">{state.line}</div>
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
      {extra}
      <GitOpsDigestDetail target={target} />
    </div>
  );
}
