import { describe, expect, it } from 'vitest';

import {
  absentRevision,
  facets,
  liveRevision,
  missingApplicationLimitation,
  plainSource,
  sourceIdentity,
} from '@/__tests__/gitopsFixtures';
import {
  ARTIFACT_STATE,
  ARTIFACT_STATE_LOOKUP,
  GITOPS_TONE_CLASS,
  PLACEMENT_STATE,
  PLACEMENT_STATE_LOOKUP,
  ROLLOUT_STATE,
  ROLLOUT_STATE_LOOKUP,
  RUNTIME_STATE,
  RUNTIME_STATE_LOOKUP,
  SOURCE_STATE,
  SOURCE_STATE_LOOKUP,
  absentFault,
  identityRefLabel,
  livePlacementFacet,
  liveRolloutFacet,
  liveSourceFacet,
  pendingSourceStatus,
  type GitOpsTone,
} from '@/lib/gitopsState';
import type {
  GitOpsArtifactStatus,
  GitOpsIdentityRef,
  GitOpsPlacementStatus,
  GitOpsRolloutStatus,
  GitOpsRuntimeStatus,
  GitOpsSourceStatus,
} from '@/types/gitops';

// Listed rather than derived from the map: this is the copy of the contract the
// test owns, so a status silently dropped from SOURCE_STATE fails here instead
// of the assertion quietly iterating one fewer key.
const SOURCE_STATUSES: GitOpsSourceStatus[] = [
  'not_applicable',
  'never_reconciled',
  'checking_fetching',
  'application_generation_accepted',
  'candidate_ready',
  'source_review_pending',
  'source_conflict_blocker',
  'source_reconcile_required',
  'source_superseded',
  'applying',
  'source_poll_scheduled',
  'source_retry_scheduled',
  'source_suspended',
  'source_failed',
  'source_unknown',
  'recovery_required',
  'recovery_failed',
  'not_live',
];

const ARTIFACT_STATUSES: GitOpsArtifactStatus[] = [
  'not_applicable',
  'artifact_unresolved',
  'artifact_resolution_pending',
  'artifact_exact',
  'artifact_qualified',
  'artifact_stale',
  'artifact_unavailable',
  'artifact_local_build_unverified',
  'artifact_identity_changed',
];

const PLACEMENT_STATUSES: GitOpsPlacementStatus[] = [
  'not_applicable',
  'unbound_direct',
  'unknown',
  'source_acceptance_pending',
  'placement_review_pending',
  'rollout_authorization_pending',
  'rollout_authorization_stale',
  'stateful_confirmation_required',
  'preflight_blocked',
  'blueprint_bound',
];

const ROLLOUT_STATUSES: GitOpsRolloutStatus[] = [
  'not_applicable',
  'rollout_not_executable',
  'rollout_queued',
  'canary_in_progress',
  'batch_in_progress',
  'rollout_paused',
  'partially_rolled_out',
  'fully_deployed_health_pending',
  'configuration_converged_artifact_qualified',
  'exactly_converged_healthy',
  'rollout_superseded',
  'target_stale',
  'target_unreachable',
  'rollback_in_progress',
  'rollback_partial_failed',
  'recovery_required',
  'completion_unknown',
];

const RUNTIME_STATUSES: GitOpsRuntimeStatus[] = [
  'tombstoned',
  'recovery_required',
  'deploying',
  'withdrawing',
  'failed_previous_workload_intact',
  'failed_after_mutation',
  'disk_invocation_drift',
  'rollout_artifact_drift',
  'runtime_artifact_drift',
  'artifact_verification_pending',
  'never_applied',
  'applied_not_deployed',
  'acknowledged_completion_unknown',
  'stale_acknowledgement',
  'pending_state_review',
  'evict_blocked',
  'drifted',
  'correcting',
  'fully_deployed_health_pending',
  'health_checking',
  'synced_and_healthy',
  'health_drift',
  'partially_rolled_out',
  'retry_scheduled',
  'paused',
  'recovery_failed',
  'completion_unknown',
];

const TONES: GitOpsTone[] = ['brand', 'success', 'warning', 'destructive', 'neutral'];

describe('the state vocabulary', () => {
  it('names every artifact status', () => {
    for (const status of ARTIFACT_STATUSES) {
      expect(ARTIFACT_STATE[status].label.length).toBeGreaterThan(0);
      expect(ARTIFACT_STATE[status].line.length).toBeGreaterThan(0);
    }
  });

  it('returns nothing for unknown statuses through the lookup views', () => {
    // The views are what surfaces read, because a newer remote node can send a
    // status this build predates. A miss has to be a quiet undefined, and the
    // view has to be the very same object as the map, not a drifting copy.
    expect(SOURCE_STATE_LOOKUP.forward_source_status).toBeUndefined();
    expect(ARTIFACT_STATE_LOOKUP.forward_artifact_status).toBeUndefined();
    expect(PLACEMENT_STATE_LOOKUP.forward_placement_status).toBeUndefined();
    expect(ROLLOUT_STATE_LOOKUP.forward_rollout_status).toBeUndefined();
    expect(RUNTIME_STATE_LOOKUP.forward_runtime_status).toBeUndefined();
    expect(SOURCE_STATE_LOOKUP).toBe(SOURCE_STATE);
    expect(ARTIFACT_STATE_LOOKUP).toBe(ARTIFACT_STATE);
    expect(PLACEMENT_STATE_LOOKUP).toBe(PLACEMENT_STATE);
    expect(ROLLOUT_STATE_LOOKUP).toBe(ROLLOUT_STATE);
    expect(RUNTIME_STATE_LOOKUP).toBe(RUNTIME_STATE);
  });

  it('names every source status', () => {
    expect(Object.keys(SOURCE_STATE).sort()).toEqual([...SOURCE_STATUSES].sort());
  });

  it('names every placement status', () => {
    expect(Object.keys(PLACEMENT_STATE).sort()).toEqual([...PLACEMENT_STATUSES].sort());
    for (const status of PLACEMENT_STATUSES) {
      expect(PLACEMENT_STATE[status].label.length).toBeGreaterThan(0);
    }
  });

  it('names every rollout status', () => {
    expect(Object.keys(ROLLOUT_STATE).sort()).toEqual([...ROLLOUT_STATUSES].sort());
    for (const status of ROLLOUT_STATUSES) {
      expect(ROLLOUT_STATE[status].label.length).toBeGreaterThan(0);
    }
  });

  it('names every runtime status', () => {
    expect(Object.keys(RUNTIME_STATE).sort()).toEqual([...RUNTIME_STATUSES].sort());
  });

  it('gives every state a tone from the five semantic slots and copy that stands alone', () => {
    for (const meta of [...Object.values(SOURCE_STATE), ...Object.values(PLACEMENT_STATE), ...Object.values(ROLLOUT_STATE), ...Object.values(RUNTIME_STATE)]) {
      expect(TONES).toContain(meta.tone);
      expect(meta.label.trim().length).toBeGreaterThan(0);
      // The line doubles as the sidebar tooltip, so it has to be a sentence.
      expect(meta.line.trim()).toMatch(/\.$/);
      expect(meta.line).not.toContain('—');
      expect(meta.label).not.toContain('—');
    }
  });

  it('has a card class for every tone', () => {
    for (const tone of TONES) expect(GITOPS_TONE_CLASS[tone]).toBeTruthy();
  });
});

describe('pendingSourceStatus', () => {
  it('is null when there is no application to ask', () => {
    expect(pendingSourceStatus(absentRevision())).toBeNull();
  });

  it('is null for an application with no Git source', () => {
    const revision = liveRevision({
      targetMode: 'inline_blueprint',
      facets: facets({
        source: { status: 'not_applicable' },
        placement: { status: 'blueprint_bound', completion: 'unknown' },
      }),
    });
    expect(pendingSourceStatus(revision)).toBeNull();
  });

  it('is null when no candidate is waiting, even for a status that can also mean one is', () => {
    // source_reconcile_required is reachable from the accepted generation with
    // no candidate at all. Flagging that stack would light an indicator that is
    // blank today, on a stack with nothing to review.
    const revision = liveRevision({
      facets: facets({ source: plainSource('source_reconcile_required', { candidateGenerationId: null }) }),
    });
    expect(pendingSourceStatus(revision)).toBeNull();
  });

  it('is null for a retired application that still carries a candidate pointer', () => {
    // Tombstoning keeps the candidate pointer as a frozen fact, so a stack
    // detached while a commit was staged still has one. Reporting it would
    // advertise an update on a stack Git no longer manages.
    const revision = liveRevision({
      lifecycleStatus: 'detached',
      facets: facets({ source: { ...sourceIdentity(), status: 'not_live', lifecycleStatus: 'detached' } }),
    });
    expect(revision.facets.source).toHaveProperty('candidateGenerationId', 'gen-candidate');
    expect(pendingSourceStatus(revision)).toBeNull();
  });

  it('reports the exact status of a waiting candidate', () => {
    const statuses = [
      'candidate_ready',
      'source_conflict_blocker',
      'source_review_pending',
      'source_reconcile_required',
    ] as const;
    for (const status of statuses) {
      const revision = liveRevision({ facets: facets({ source: plainSource(status) }) });
      expect(pendingSourceStatus(revision)).toBe(status);
    }
  });

  it('reports a candidate held behind an in-flight apply', () => {
    const revision = liveRevision({
      facets: facets({
        source: { ...sourceIdentity(), status: 'applying', activeOperationId: 'op-1', activeGenerationId: 'gen-1' },
      }),
    });
    expect(pendingSourceStatus(revision)).toBe('applying');
  });
});

describe('liveSourceFacet', () => {
  it('is null when there is no revision to read', () => {
    expect(liveSourceFacet(null)).toBeNull();
  });

  it('is null when there is no application to ask', () => {
    expect(liveSourceFacet(absentRevision())).toBeNull();
  });

  it('is null for a Blueprint-owned application, which has no Git source', () => {
    const revision = liveRevision({
      targetMode: 'inline_blueprint',
      facets: facets({
        source: { status: 'not_applicable' },
        placement: { status: 'blueprint_bound', completion: 'unknown' },
      }),
    });
    expect(liveSourceFacet(revision)).toBeNull();
  });

  it('returns the facet, identity fields and all, for a live Git source', () => {
    const source = plainSource('source_review_pending');
    expect(liveSourceFacet(liveRevision({ facets: facets({ source }) }))).toEqual(source);
  });

  it('returns a retired source facet, which is a state to name rather than hide', () => {
    // not_live is in SOURCE_STATE and reads as "the identity shown is what it
    // was". Only pendingSourceStatus excludes it, because it is not an update
    // waiting to be applied.
    const source = { ...sourceIdentity(), status: 'not_live' as const, lifecycleStatus: 'detached' as const };
    expect(liveSourceFacet(liveRevision({ facets: facets({ source }) }))).toEqual(source);
  });
});

describe('livePlacementFacet', () => {
  it('is null when there is no revision to read', () => {
    expect(livePlacementFacet(null)).toBeNull();
  });

  it('is null when there is no application to ask', () => {
    expect(livePlacementFacet(absentRevision())).toBeNull();
  });

  it('is null when placement does not apply to the application', () => {
    const revision = liveRevision({ facets: facets({ placement: { status: 'not_applicable' } }) });
    expect(livePlacementFacet(revision)).toBeNull();
  });

  it('returns the facet for a live application', () => {
    // The fixture default is a Direct application, whose placement reads as
    // unbound_direct rather than not_applicable.
    expect(livePlacementFacet(liveRevision())).toEqual({ status: 'unbound_direct' });
  });
});

describe('liveRolloutFacet', () => {
  it('is null when there is no revision to read', () => {
    expect(liveRolloutFacet(null)).toBeNull();
  });

  it('is null when there is no application to ask', () => {
    expect(liveRolloutFacet(absentRevision())).toBeNull();
  });

  it('is null when no rollout applies to the application', () => {
    // The fixture default is a Direct application with no rollout in play.
    expect(liveRolloutFacet(liveRevision())).toBeNull();
  });

  it('returns the facet when a rollout is in play', () => {
    const rollout = { status: 'rollout_queued' as const, rolloutGenerationId: 'rg-1' };
    const revision = liveRevision({ facets: facets({ rollout }) });
    expect(liveRolloutFacet(revision)).toEqual(rollout);
  });
});

describe('absentFault', () => {
  it('is empty for a stack the model was never asked about', () => {
    expect(absentFault(absentRevision())).toEqual([]);
  });

  it('reports an application that was expected and could not be reached', () => {
    expect(absentFault(absentRevision([missingApplicationLimitation]))).toEqual([
      missingApplicationLimitation,
    ]);
  });

  it('is empty for a live application, even one carrying limitations', () => {
    // A live arm's limitations are caveats on state that is being reported, not
    // faults. Merging the two would recreate the conflation in reverse.
    const revision = liveRevision({
      limitations: [{ code: 'repo_identity_invalid', message: 'Repository identity could not be read.', evidence: null }],
    });
    expect(absentFault(revision)).toEqual([]);
  });
});

describe('identityRefLabel', () => {
  const cases: Array<[GitOpsIdentityRef, string]> = [
    [{ kind: 'none' }, 'none'],
    [{ kind: 'unknown' }, 'unknown'],
    [{ kind: 'commit', sha: 'a1b2c3d4e5f6', repoUrl: 'https://example.test/a.git', ref: 'main' }, 'commit a1b2c3d'],
    [{ kind: 'generation', id: 'gen-12345678-x' }, 'generation gen-1234'],
    [
      { kind: 'artifact_set', id: 'art-12345678-x', qualification: 'exact', evidenceVersion: 3 },
      'artifact art-1234 · exact',
    ],
    [{ kind: 'runtime_artifact', identity: 'nginx@sha256:abc', observedAt: 1 }, 'nginx@sha256:abc'],
    [{ kind: 'intent', id: 'int-12345678-x', composeContentSha256: 'deadbeef' }, 'intent int-1234'],
    [{ kind: 'rollout_candidate', id: 'rc-123456789' }, 'candidate rc-12345'],
    [{ kind: 'rollout_generation', id: 'rg-123456789' }, 'rollout rg-12345'],
    [
      {
        kind: 'invocation',
        authored: {
          composeFileOrder: ['compose.yaml', 'compose.override.yaml'],
          projectName: null,
          projectDirectory: null,
          envFileOrder: [],
        },
      },
      'compose.yaml, compose.override.yaml',
    ],
    [{ kind: 'health_run', runId: 'run-12345678-x', deployedGenerationId: null }, 'health run run-1234'],
  ];

  it.each(cases)('labels %o', (ref, expected) => {
    expect(identityRefLabel(ref)).toBe(expected);
  });

  it('names an invocation that authored no compose files', () => {
    expect(
      identityRefLabel({
        kind: 'invocation',
        authored: { composeFileOrder: [], projectName: null, projectDirectory: null, envFileOrder: [] },
      }),
    ).toBe('no compose files');
  });
});
