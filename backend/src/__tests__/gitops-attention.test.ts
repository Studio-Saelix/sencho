/**
 * Unit coverage for the GitOps attention classifier (services/gitops/attention.ts).
 *
 * The classifier is the one place facets become "this needs an operator".
 * These tests pin the mapping in both directions: every attention-bearing
 * state produces its reason, and the states that must NOT produce attention
 * (a healthy poll, an in-flight apply, a converged rollout) stay quiet so the
 * queue cannot drown operators in normal work.
 */
import { describe, expect, it } from 'vitest';
import { attentionReasons, ATTENTION_TONE, hasFailureReason } from '../services/gitops/attention';
import type {
  ArtifactFacet,
  GitOpsRevisionProjection,
  GitOpsTargetProjection,
  HealthFacet,
  LkgFacet,
  RuntimeFacet,
  SourceFacet,
} from '../services/gitops/types';

/** The identity fields every live source status carries. */
const SOURCE_IDENTITY = {
  configuredRepoUrl: 'https://github.com/example/repo.git',
  repoIdentity: { host: 'github.com', pathname: '/example/repo.git' },
  configuredRef: 'main',
  desiredCommitSha: null,
  fetchedCommitSha: null,
  candidateGenerationId: null,
  acceptedGenerationId: 'gen-1',
} as const;

const RESTING_SOURCE: SourceFacet = {
  status: 'source_poll_scheduled',
  nextPollAt: 2000,
  ...SOURCE_IDENTITY,
};

function artifactAt(status: ArtifactFacet['status']): ArtifactFacet {
  if (status === 'not_applicable') return { status };
  return {
    status,
    artifactSetId: 'art-1',
    generationId: 'gen-1',
    evidenceVersion: 1,
    qualification: 'exact',
    freshnessAt: 1000,
    expected: null,
    latestEvidence: { artifactSetId: 'art-1', evidenceVersion: 1, qualification: 'exact', identity: null },
  };
}

function target(overrides: Partial<GitOpsTargetProjection>): GitOpsTargetProjection {
  return {
    nodeId: 1,
    stackName: 'web',
    desiredGenerationId: 'gen-1',
    candidateGenerationId: null,
    appliedGenerationId: 'gen-1',
    deployedGenerationId: 'gen-1',
    healthyGenerationId: 'gen-1',
    lkgGenerationId: null,
    lkgArtifactSetId: null,
    lkgUnavailableAt: null,
    lkgUnavailableReason: null,
    expectedArtifactSetId: null,
    latestArtifactSetId: null,
    intentRevisionId: null,
    rolloutCandidateId: null,
    rolloutGenerationId: null,
    approvals: {
      sourceAcceptanceRef: null,
      placementApprovalRef: null,
      rolloutAuthorizationRef: null,
      legacyCombinedApprovalRef: null,
    },
    legacyAppliedRevision: null,
    connectivity: 'reachable',
    tombstoned: false,
    runtime: { status: 'synced_and_healthy' },
    health: { status: 'passed', runId: 'run-1', deployedGenerationId: 'gen-1' },
    lkg: { status: 'none' },
    artifact: { status: 'not_applicable' },
    observedArtifactIdentity: { kind: 'unknown' },
    ...overrides,
  };
}

function runtimeAt(status: RuntimeFacet['status']): RuntimeFacet {
  return { status } as RuntimeFacet;
}

function healthAt(status: HealthFacet['status']): HealthFacet {
  return { status } as HealthFacet;
}

/** The live arm of the projection union: the only one with facets and targets. */
type LiveFacets = Extract<GitOpsRevisionProjection, { applicationId: string }>['facets'];

/**
 * A clean, fully-at-rest live projection. `attentionReasons` must return no
 * reasons for it; the per-state tests mutate exactly one thing.
 */
function liveProjection(overrides?: {
  source?: SourceFacet;
  artifact?: ArtifactFacet;
  placement?: LiveFacets['placement'];
  rollout?: LiveFacets['rollout'];
  targets?: GitOpsTargetProjection[];
  drift?: Extract<GitOpsRevisionProjection, { applicationId: string }>['drift'];
}): GitOpsRevisionProjection {
  return {
    schemaVersion: 1,
    targetMode: 'direct',
    applicationId: 'app-1',
    lifecycleStatus: 'active',
    stackName: 'web',
    blueprintId: null,
    rolloutGenerationId: null,
    approvals: {
      sourceAcceptanceRef: null,
      placementApprovalRef: null,
      rolloutAuthorizationRef: null,
      legacyCombinedApprovalRef: null,
    },
    facets: {
      source: overrides?.source ?? RESTING_SOURCE,
      artifact: overrides?.artifact ?? artifactAt('artifact_exact'),
      placement: overrides?.placement ?? { status: 'unbound_direct' },
      rollout: overrides?.rollout ?? { status: 'not_applicable' },
    },
    targets: overrides?.targets ?? [target({
      runtime: runtimeAt('synced_and_healthy'),
      health: healthAt('passed'),
      lkg: { status: 'none' } as LkgFacet,
    })],
    drift: overrides?.drift ?? [],
    limitations: [],
    availableActions: [],
  };
}

describe('attentionReasons', () => {
  it('returns no reasons for an application at rest', () => {
    expect(attentionReasons(liveProjection())).toEqual([]);
  });

  it('flags a failed source', () => {
    const projection = liveProjection({
      source: {
        ...SOURCE_IDENTITY,
        status: 'source_failed',
        failureStage: 'fetch',
        failureClass: 'transport',
        failureAt: 500,
        retryAt: null,
        retryCount: 0,
      },
    });
    expect(attentionReasons(projection)).toContain('source_failed');
  });

  it('flags an unknown source outcome', () => {
    const projection = liveProjection({
      source: {
        ...RESTING_SOURCE,
        status: 'source_unknown',
        interruptedStage: 'fetch_started',
        interruptedAt: 500,
        interruptedOperationId: null,
        interruptedGenerationId: null,
      },
    });
    expect(attentionReasons(projection)).toContain('source_unknown_outcome');
  });

  it('flags review, conflict, reconcile, retry, and suspension source states', () => {
    expect(attentionReasons(liveProjection({
      source: { ...RESTING_SOURCE, status: 'source_review_pending', reviewBlockReason: null },
    }))).toContain('source_review_pending');
    expect(attentionReasons(liveProjection({ source: { ...RESTING_SOURCE, status: 'source_conflict_blocker' } })))
      .toContain('source_conflict_blocker');
    expect(attentionReasons(liveProjection({ source: { ...RESTING_SOURCE, status: 'source_reconcile_required' } })))
      .toContain('source_reconcile_required');
    expect(attentionReasons(liveProjection({
      source: { ...RESTING_SOURCE, status: 'source_retry_scheduled', retryAt: 900, retryCount: 2 },
    }))).toContain('source_retry_scheduled');
    expect(attentionReasons(liveProjection({
      source: { ...RESTING_SOURCE, status: 'source_suspended', suspendedAt: 900, suspendedReason: null },
    }))).toContain('source_suspended');
  });

  it('names a stateful-withdrawal block instead of the generic review state', () => {
    const blocked = attentionReasons(liveProjection({
      source: {
        ...RESTING_SOURCE,
        status: 'source_review_pending',
        reviewBlockReason: 'stateful_withdrawal',
      },
    }));
    expect(blocked).toEqual(['stateful_withdrawal_blocked']);
    // The block is a pending operator decision, not damage: the posture stays
    // `attention`, never `failed`.
    expect(hasFailureReason(blocked)).toBe(false);
  });

  it('does not flag a pending-but-normal candidate as attention', () => {
    // candidate_ready means the state machine is waiting for the operator to
    // apply an update by design; the issue's attention set intentionally does
    // not include it, so the queue stays for exceptions.
    expect(attentionReasons(liveProjection({ source: { ...RESTING_SOURCE, status: 'candidate_ready' } }))).toEqual([]);
  });

  it('flags recovery states on the source facet', () => {
    expect(attentionReasons(liveProjection({
      source: { ...RESTING_SOURCE, status: 'recovery_required', recoveryRef: null, recoveryGenerationId: null },
    }))).toContain('recovery_required');
    expect(attentionReasons(liveProjection({
      source: { ...RESTING_SOURCE, status: 'recovery_failed', recoveryRef: null, recoveryGenerationId: null, failureClass: 'x', failureAt: 1 },
    }))).toContain('recovery_failed');
  });

  it('flags placement gating states', () => {
    expect(attentionReasons(liveProjection({ placement: { status: 'placement_review_pending' } })))
      .toContain('placement_review_pending');
    expect(attentionReasons(liveProjection({ placement: { status: 'stateful_confirmation_required' } })))
      .toContain('stateful_confirmation_required');
  });

  it('flags rollout authorization pending, stale, and preflight blocked', () => {
    const binding = {
      rolloutCandidateId: 'rc-1',
      acceptedGenerationId: 'gen-1',
      artifactSetId: 'art-1',
      intentRevisionId: 'ir-1',
      requiredNodeIds: [1],
      sourceAcceptanceRef: 'sa-1',
      placementApprovalRef: 'pa-1',
      preflightFingerprint: 'fp-1',
    };
    expect(attentionReasons(liveProjection({
      placement: { status: 'rollout_authorization_pending', rolloutAuthorizationRef: null, binding },
    }))).toContain('rollout_authorization_pending');
    expect(attentionReasons(liveProjection({
      placement: { status: 'rollout_authorization_stale', rolloutAuthorizationRef: 'ra-1', bound: binding },
    }))).toContain('rollout_authorization_stale');
    expect(attentionReasons(liveProjection({
      placement: { status: 'preflight_blocked', reason: 'registry', binding },
    }))).toContain('preflight_blocked');
  });

  it('flags rollout pause, partial rollout, unknown completion, and failed rollback', () => {
    expect(attentionReasons(liveProjection({
      rollout: { status: 'rollout_paused', pauseAt: 1, pauseReason: null },
    }))).toContain('rollout_paused');
    expect(attentionReasons(liveProjection({
      rollout: { status: 'partially_rolled_out', partial: null },
    }))).toContain('rollout_partial');
    expect(attentionReasons(liveProjection({
      rollout: { status: 'completion_unknown' },
    }))).toContain('rollout_completion_unknown');
    expect(attentionReasons(liveProjection({
      rollout: { status: 'rollback_partial_failed', recoveryRef: 'r', recoveryGenerationId: null, failureClass: 'x', failureAt: 1 },
    }))).toContain('rollback_failed');
  });

  it('flags node connectivity via the rollout facet and target evidence', () => {
    expect(attentionReasons(liveProjection({ rollout: { status: 'target_unreachable' } })))
      .toContain('target_unreachable');
    expect(attentionReasons(liveProjection({ rollout: { status: 'target_stale' } })))
      .toContain('target_stale');
    const withUnreachableTarget = liveProjection({
      targets: [target({ connectivity: 'unreachable' })],
    });
    expect(attentionReasons(withUnreachableTarget)).toContain('target_unreachable');
  });

  it('flags artifact uncertainty that blocks a convergence claim', () => {
    expect(attentionReasons(liveProjection({ artifact: artifactAt('artifact_unresolved') })))
      .toContain('artifact_unqualified');
    expect(attentionReasons(liveProjection({ artifact: artifactAt('artifact_unavailable') })))
      .toContain('artifact_unqualified');
    expect(attentionReasons(liveProjection({ artifact: artifactAt('artifact_local_build_unverified') })))
      .toContain('artifact_unqualified');
    expect(attentionReasons(liveProjection({ artifact: artifactAt('artifact_stale') })))
      .toContain('artifact_stale');
    expect(attentionReasons(liveProjection({ artifact: artifactAt('artifact_identity_changed') })))
      .toContain('artifact_identity_changed');
    // Resolution still in flight and exact proof are not attention.
    expect(attentionReasons(liveProjection({ artifact: artifactAt('artifact_resolution_pending') })))
      .toEqual([]);
    expect(attentionReasons(liveProjection({ artifact: artifactAt('artifact_exact') }))).toEqual([]);
  });

  it('flags confirmed drift once regardless of class count', () => {
    const item = {
      class: 'runtime' as const,
      expected: { kind: 'generation' as const, id: 'g' },
      observed: { kind: 'none' as const },
      freshnessAt: null,
      owner: 'test',
      reason: 'test',
      configuredPolicy: null,
      affectedTargets: [],
      action: 'deploy' as const,
    };
    expect(attentionReasons(liveProjection({ drift: [item, { ...item, class: 'health' }] }))).toEqual(['drift']);
  });

  it('flags a failed health verdict on any target', () => {
    const projection = liveProjection({
      targets: [target({ runtime: runtimeAt('synced_and_healthy'), health: healthAt('failed') })],
    });
    expect(attentionReasons(projection)).toContain('health_failed');
  });

  it.each(['failed_after_mutation', 'failed_previous_workload_intact'] as const)(
    'flags a hard deploy failure (%s) on a target',
    (status) => {
      const projection = liveProjection({
        targets: [target({ runtime: runtimeAt(status) })],
      });
      expect(attentionReasons(projection)).toContain('deploy_failed');
      // Failure tone, so the posture is `failed`: this is damage, not a
      // pending decision.
      expect(hasFailureReason(attentionReasons(projection))).toBe(true);
    },
  );

  it('does not flag a target that is merely behind', () => {
    const projection = liveProjection({
      targets: [target({ runtime: runtimeAt('applied_not_deployed') })],
    });
    expect(attentionReasons(projection)).toEqual([]);
  });

  it('most failure states carry failure tone; pending decisions do not', () => {
    expect(ATTENTION_TONE.source_failed).toBe('failure');
    expect(ATTENTION_TONE.recovery_failed).toBe('failure');
    expect(ATTENTION_TONE.rollback_failed).toBe('failure');
    expect(ATTENTION_TONE.target_unreachable).toBe('failure');
    expect(ATTENTION_TONE.source_review_pending).toBe('pending');
    expect(ATTENTION_TONE.preflight_blocked).toBe('pending');
    expect(ATTENTION_TONE.drift).toBe('pending');
    expect(ATTENTION_TONE.rollout_authorization_pending).toBe('pending');
  });

  it('hasFailureReason distinguishes failure from pending', () => {
    expect(hasFailureReason(['source_failed'])).toBe(true);
    expect(hasFailureReason(['source_review_pending', 'drift'])).toBe(false);
    expect(hasFailureReason([])).toBe(false);
  });

  it('every attention reason has exactly one declared tone', () => {
    const tones = Object.keys(ATTENTION_TONE).sort();
    expect(tones).toEqual([
      'artifact_identity_changed',
      'artifact_stale',
      'artifact_unqualified',
      'deploy_failed',
      'drift',
      'health_failed',
      'placement_review_pending',
      'preflight_blocked',
      'recovery_failed',
      'recovery_required',
      'rollback_failed',
      'rollout_authorization_pending',
      'rollout_authorization_stale',
      'rollout_completion_unknown',
      'rollout_partial',
      'rollout_paused',
      'source_conflict_blocker',
      'source_failed',
      'source_reconcile_required',
      'source_retry_scheduled',
      'source_review_pending',
      'source_suspended',
      'source_unknown_outcome',
      'stateful_confirmation_required',
      'stateful_withdrawal_blocked',
      'target_stale',
      'target_unreachable',
    ]);
  });
});
