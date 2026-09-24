import { cn } from '@/lib/utils';
import { formatTimeAgo } from '@/lib/relativeTime';
import type { GitOpsTargetProjection } from '@/types/gitops';

type TargetDigestVerdict = 'matches' | 'diverged' | 'unverified';

interface TargetDigestView {
  verdict: TargetDigestVerdict;
  expected: string | null;
  observed: string | null;
  observedAt: number | null;
  /** Why the verdict is unverified; null for a proven verdict. */
  note: string | null;
}

const OBSERVATION_NOTE: Record<string, string> = {
  unknown: 'no runtime observation recorded yet',
  missing: 'no running workload to observe',
  unavailable: 'runtime identity could not be collected',
  stale: 'the last observation is stale',
  local_build_unverified: 'locally built image, digest cannot be proven',
};

/**
 * Per-target digest comparison. A target is `diverged` when the runtime facet
 * reports artifact drift or when an exact or qualified observation names an
 * identity other than the approved one, and `matches` only when an approved
 * identity exists and exact or qualified evidence shows that same identity.
 * Everything else is `unverified`, so a missing or weak observation never
 * reads as convergence.
 * Returns null when artifact identity does not apply to the target.
 */
function targetDigestView(target: GitOpsTargetProjection): TargetDigestView | null {
  const artifact = target.artifact;
  if (artifact.status === 'not_applicable') return null;
  const expected = artifact.expected?.identity ?? null;
  const obs = target.observedArtifactIdentity;
  const observed = 'identity' in obs ? obs.identity : null;
  const observedAt = 'observedAt' in obs ? obs.observedAt : null;
  const status = target.runtime.status;
  const comparable = obs.kind === 'exact' || obs.kind === 'qualified';

  if (status === 'runtime_artifact_drift' || status === 'rollout_artifact_drift') {
    return { verdict: 'diverged', expected, observed, observedAt, note: null };
  }
  if (expected === null) {
    return { verdict: 'unverified', expected, observed, observedAt, note: 'no approved digest to compare against' };
  }
  if (!comparable) {
    return { verdict: 'unverified', expected, observed, observedAt, note: OBSERVATION_NOTE[obs.kind] ?? obs.kind };
  }
  if (observed !== expected) {
    return { verdict: 'diverged', expected, observed, observedAt, note: null };
  }
  return { verdict: 'matches', expected, observed, observedAt, note: null };
}

const VERDICT_TONE: Record<TargetDigestVerdict, string> = {
  matches: 'text-success',
  diverged: 'text-warning',
  unverified: 'text-stat-subtitle',
};

export default function GitOpsTargetDigest({ target }: { target: GitOpsTargetProjection }) {
  const view = targetDigestView(target);
  if (!view) return null;
  return (
    <div data-testid="gitops-target-digest" data-verdict={view.verdict} className="mt-1.5 flex flex-col gap-0.5 font-mono text-[10px]">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="uppercase tracking-wide text-stat-subtitle">digest</span>
        <span className={cn('uppercase tracking-wide', VERDICT_TONE[view.verdict])}>{view.verdict}</span>
        {view.note && <span className="text-stat-subtitle">· {view.note}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 break-all">
        <span className="text-stat-subtitle">expected</span>
        <span className="text-foreground/90">{view.expected ?? 'none'}</span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 break-all">
        <span className="text-stat-subtitle">observed</span>
        <span className="font-semibold text-foreground">{view.observed ?? 'unverified'}</span>
        {view.observedAt != null && <span className="text-stat-subtitle">· {formatTimeAgo(view.observedAt)}</span>}
      </div>
    </div>
  );
}
