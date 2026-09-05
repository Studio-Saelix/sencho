/**
 * Normalized reconcile-outcome coverage. outcomeFromSourceFacet derives from
 * the existing SourceFacet projection rather than inventing a second status
 * source, so "no source change" and "converged" cannot silently collapse
 * into the same result.
 */
import { describe, it, expect } from 'vitest';
import { outcomeFromSourceFacet } from '../services/gitops/outcomes';
import type { SourceFacet } from '../services/gitops/types';

const identity = {
  configuredRepoUrl: 'https://github.com/example/repo.git',
  repoIdentity: { host: 'github.com', pathname: '/example/repo.git' },
  configuredRef: 'main',
  desiredCommitSha: 'a'.repeat(40),
  fetchedCommitSha: 'a'.repeat(40),
  candidateGenerationId: null,
  acceptedGenerationId: 'gen-1',
};

describe('outcomeFromSourceFacet', () => {
  it('reports no_source_change for an accepted generation, never converged on SHA alone', () => {
    const facet: SourceFacet = { ...identity, status: 'application_generation_accepted' };
    const result = outcomeFromSourceFacet(facet);
    expect(result.outcome).toBe('no_source_change');
    expect(result.commitSha).toBe('a'.repeat(40));
  });

  it('reports candidate_already_fetched for a ready candidate', () => {
    const facet: SourceFacet = { ...identity, status: 'candidate_ready' };
    expect(outcomeFromSourceFacet(facet).outcome).toBe('candidate_already_fetched');
  });

  it('reports pending_review with a review next action', () => {
    const facet: SourceFacet = { ...identity, status: 'source_review_pending' };
    const result = outcomeFromSourceFacet(facet);
    expect(result.outcome).toBe('pending_review');
    expect(result.nextAction).toBe('review');
  });

  it('reports blocked with a resolve_conflict next action for a source conflict', () => {
    const facet: SourceFacet = { ...identity, status: 'source_conflict_blocker' };
    const result = outcomeFromSourceFacet(facet);
    expect(result.outcome).toBe('blocked');
    expect(result.nextAction).toBe('resolve_conflict');
  });

  it('reports superseded for a candidate a newer revision replaced', () => {
    const facet: SourceFacet = { ...identity, status: 'source_superseded', supersededGenerationId: 'gen-old' };
    expect(outcomeFromSourceFacet(facet).outcome).toBe('superseded');
  });

  it('reports retry_scheduled with the retry time surfaced', () => {
    const facet: SourceFacet = { ...identity, status: 'source_retry_scheduled', retryAt: 12345, retryCount: 2 };
    const result = outcomeFromSourceFacet(facet);
    expect(result.outcome).toBe('retry_scheduled');
    expect(result.retryAt).toBe(12345);
    expect(result.nextAction).toBe('none');
  });

  it('reports suspended with a resume next action', () => {
    const facet: SourceFacet = { ...identity, status: 'source_suspended', suspendedAt: 999, suspendedReason: 'operator paused sync' };
    const result = outcomeFromSourceFacet(facet);
    expect(result.outcome).toBe('suspended');
    expect(result.nextAction).toBe('resume');
    expect(result.reason).toContain('operator paused sync');
  });

  it('reports failed_previous_intact for a source failure, with a retry next action when a retry is scheduled', () => {
    const facet: SourceFacet = {
      ...identity,
      status: 'source_failed',
      failureStage: 'fetch',
      failureClass: 'permanent',
      failureAt: 100,
      retryAt: 200,
      retryCount: 1,
    };
    const result = outcomeFromSourceFacet(facet);
    expect(result.outcome).toBe('failed_previous_intact');
    expect(result.nextAction).toBe('retry');
    expect(result.retryAt).toBe(200);
  });

  it('reports failed_previous_intact with no retry next action when no retry is scheduled', () => {
    const facet: SourceFacet = {
      ...identity,
      status: 'source_failed',
      failureStage: 'fetch',
      failureClass: 'permanent',
      failureAt: 100,
      retryAt: null,
      retryCount: 0,
    };
    const result = outcomeFromSourceFacet(facet);
    expect(result.outcome).toBe('failed_previous_intact');
    expect(result.nextAction).toBe('configure_credentials');
  });

  it('reports recovery_required for an interrupted operation', () => {
    const facet: SourceFacet = {
      ...identity,
      status: 'source_unknown',
      interruptedStage: 'fetch_started',
      interruptedAt: 100,
      interruptedOperationId: 'op-1',
      interruptedGenerationId: null,
    };
    expect(outcomeFromSourceFacet(facet).outcome).toBe('recovery_required');
  });

  it('reports recovery_required with a view_target_results next action when recovery is outstanding', () => {
    const facet: SourceFacet = { ...identity, status: 'recovery_required', recoveryRef: 'rec-1', recoveryGenerationId: 'gen-1' };
    const result = outcomeFromSourceFacet(facet);
    expect(result.outcome).toBe('recovery_required');
    expect(result.nextAction).toBe('view_target_results');
  });

  it('reports recovery_required when recovery itself failed, distinguishing that in the reason', () => {
    const facet: SourceFacet = {
      ...identity,
      status: 'recovery_failed',
      recoveryRef: 'rec-1',
      recoveryGenerationId: 'gen-1',
      failureClass: 'io_error',
      failureAt: 100,
    };
    const result = outcomeFromSourceFacet(facet);
    expect(result.outcome).toBe('recovery_required');
    expect(result.reason).toMatch(/recovery/i);
  });

  it('reports unknown for an application that is no longer live', () => {
    const facet: SourceFacet = { ...identity, status: 'not_live', lifecycleStatus: 'detached' };
    expect(outcomeFromSourceFacet(facet).outcome).toBe('unknown');
  });

  it.each(['not_applicable', 'never_reconciled', 'checking_fetching', 'source_reconcile_required'] as const)(
    'reports unknown for %s, which has no settled outcome yet',
    (status) => {
      const facet = status === 'not_applicable'
        ? ({ status } as SourceFacet)
        : ({ ...identity, status } as SourceFacet);
      expect(outcomeFromSourceFacet(facet).outcome).toBe('unknown');
    },
  );

  it('reports unknown while an operation is in flight (applying)', () => {
    const facet: SourceFacet = { ...identity, status: 'applying', activeOperationId: 'op-1', activeGenerationId: 'gen-1' };
    expect(outcomeFromSourceFacet(facet).outcome).toBe('unknown');
  });
});
