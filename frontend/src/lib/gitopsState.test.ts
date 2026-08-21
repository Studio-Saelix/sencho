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
  GITOPS_TONE_CLASS,
  RUNTIME_STATE,
  SOURCE_STATE,
  absentFault,
  identityRefLabel,
  pendingSourceStatus,
  type GitOpsTone,
} from '@/lib/gitopsState';
import type { GitOpsIdentityRef, GitOpsRuntimeStatus, GitOpsSourceStatus } from '@/types/gitops';

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
  'source_retry_scheduled',
  'source_suspended',
  'source_failed',
  'source_unknown',
  'recovery_required',
  'recovery_failed',
  'not_live',
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
  it('names every source status', () => {
    expect(Object.keys(SOURCE_STATE).sort()).toEqual([...SOURCE_STATUSES].sort());
  });

  it('names every runtime status', () => {
    expect(Object.keys(RUNTIME_STATE).sort()).toEqual([...RUNTIME_STATUSES].sort());
  });

  it('gives every state a tone from the five semantic slots and copy that stands alone', () => {
    for (const meta of [...Object.values(SOURCE_STATE), ...Object.values(RUNTIME_STATE)]) {
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
