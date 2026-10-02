import { describe, expect, it } from 'vitest';

import {
  absentRevision,
  facets,
  liveArtifact,
  liveRevision,
  missingApplicationLimitation,
  noApprovals,
  plainSource,
  portfolioRow,
  sourceIdentity,
  target,
} from '@/__tests__/gitopsFixtures';
import {
  applicableStages,
  buildGitOpsStatus,
  formatRetryWait,
  grantedAuthority,
  isSpeakingStage,
} from '@/lib/gitopsStatus';

const REFS = { source: 'src-accept-0123', placement: 'plc-approve-0123', rollout: 'rlo-authorize-0123', legacy: 'lcy-combined-0123' };

describe('applicableStages', () => {
  it('leaves out stages that say nothing about this application', () => {
    // Unbound placement is true of every Direct stack, and an absent rollout is no stage at all.
    const stages = applicableStages(liveRevision({ facets: facets({ source: plainSource('candidate_ready') }) }));
    expect(stages.map(s => s.id)).toEqual(['source', 'runtime']);
  });

  it('keeps every stage that applies, in reading order', () => {
    const stages = applicableStages(liveRevision({
      facets: facets({
        source: plainSource('application_generation_accepted'),
        artifact: liveArtifact(),
        placement: { status: 'placement_review_pending' },
        rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'rc-1' },
      }),
    }));
    expect(stages.map(s => s.id)).toEqual(['source', 'artifact', 'placement', 'rollout', 'runtime']);
  });

  it('is empty on the absent arm', () => {
    expect(applicableStages(absentRevision())).toEqual([]);
    expect(applicableStages(null)).toEqual([]);
  });

  it('reads the runtime stage from the loudest target, and counts several', () => {
    const stages = applicableStages(liveRevision({
      targets: [
        target({ nodeId: 1, runtime: { status: 'synced_and_healthy' } }),
        target({ nodeId: 2, runtime: { status: 'drifted' } }),
      ],
    }));
    const runtime = stages.find(s => s.id === 'runtime');
    expect(runtime?.status).toBe('drifted');
    expect(runtime?.detail).toBe('2 targets');
  });

  it('words a status this build does not know instead of dropping the stage', () => {
    const unknown = JSON.parse('{"status":"from_a_newer_node"}') as ReturnType<typeof target>['runtime'];
    const stages = applicableStages(liveRevision({ targets: [target({ runtime: unknown })] }));
    expect(stages.find(s => s.id === 'runtime')?.word).toBe('unrecognized state');
  });
});

describe('buildGitOpsStatus', () => {
  it('is null where there is nothing to say', () => {
    expect(buildGitOpsStatus(null)).toBeNull();
    // The ordinary stack outside GitOps.
    expect(buildGitOpsStatus(absentRevision())).toBeNull();
  });

  it('reports an unreachable application as the one toned block', () => {
    const model = buildGitOpsStatus(absentRevision([missingApplicationLimitation]));
    expect(model?.kind).toBe('unavailable');
    expect(model?.answer.tone).toBe('destructive');
    expect(model?.answer.line).toBe(missingApplicationLimitation.message);
    expect(model?.stages).toEqual([]);
  });

  it('speaks for the loudest stage, earliest first on a tie', () => {
    const model = buildGitOpsStatus(liveRevision({
      facets: facets({
        source: plainSource('source_review_pending'),
        artifact: liveArtifact({ status: 'artifact_stale' }),
      }),
    }));
    expect(model?.answerStageId).toBe('source');
    expect(model?.answer.tone).toBe('warning');
  });

  it('lets a focused stage speak when it is as loud as any other, so its verb sits beside its own sentence', () => {
    const revision = liveRevision({
      facets: facets({
        source: plainSource('source_review_pending'),
        artifact: liveArtifact({ status: 'artifact_stale' }),
      }),
    });
    // Both warn, so the earlier one speaks unless the verb belongs to the other.
    expect(buildGitOpsStatus(revision)?.answerStageId).toBe('source');
    expect(buildGitOpsStatus(revision, null, 'artifact')?.answerStageId).toBe('artifact');
  });

  it('does not let a focused verb quiet a louder failure elsewhere', () => {
    // A waiting commit is a brand-toned item; a failing runtime is louder, and one toned block must not hide it.
    const revision = liveRevision({
      facets: facets({ source: plainSource('candidate_ready') }),
      targets: [target({ runtime: { status: 'recovery_failed', recoveryRef: null, recoveryGenerationId: null, failureClass: 'DEPLOY', failureAt: 1 } })],
    });
    const loud = buildGitOpsStatus(revision, null, 'source');
    expect(loud?.answerStageId).not.toBe('source');
    expect(loud?.answer.tone).not.toBe('brand');
  });

  it('does not let a settled stage take the focus from a louder one', () => {
    const revision = liveRevision({
      facets: facets({
        source: plainSource('application_generation_accepted'),
        artifact: liveArtifact({ status: 'artifact_stale' }),
      }),
    });
    expect(buildGitOpsStatus(revision, null, 'source')?.answerStageId).toBe('artifact');
  });

  it('puts the specifics of the speaking stage in the answer detail', () => {
    const model = buildGitOpsStatus(liveRevision({
      facets: facets({ source: plainSource('candidate_ready', { fetchedCommitSha: 'a1b2c3d4e5f6' }) }),
    }));
    expect(model?.answer.detail).toContain('a1b2c3d');
  });

  it('speaks for the application posture when the portfolio row is given', () => {
    const model = buildGitOpsStatus(liveRevision(), portfolioRow({ posture: 'failed', attention: ['health_failed'] }));
    expect(model?.answer.title).toBe('failed');
    expect(model?.answer.status).toBe('failed');
    expect(model?.kind).toBe('posture');
    expect(model?.answerStageId).toBeNull();
    expect(model?.answer.line).toBe('A health check on this application is failing.');
  });

  it('names the first reason, counts the rest, and keeps every one for the evidence', () => {
    const model = buildGitOpsStatus(liveRevision(), portfolioRow({ posture: 'attention', attention: ['drift', 'target_stale', 'artifact_stale'] }));
    expect(model?.answer.detail).toBe('2 more needing attention');
    expect(model?.otherReasons.map(r => r.label)).toEqual(['stale target', 'artifact stale']);
  });

  it('keeps the application posture when the revision is absent or unreadable', () => {
    // The posture is computed hub-side from more than this node's projection, so it holds without one.
    const absent = buildGitOpsStatus(absentRevision(), portfolioRow({ posture: 'unknown' }));
    expect(absent?.kind).toBe('posture');
    expect(absent?.answer.title).toBe('unknown');
    const fault = buildGitOpsStatus(absentRevision([missingApplicationLimitation]), portfolioRow({ posture: 'attention', attention: ['drift'] }));
    expect(fault?.kind).toBe('posture');
    expect(fault?.answer.status).toBe('attention');
    expect(fault?.answer.detail).toBe(missingApplicationLimitation.message);
    expect(fault?.marker).toBe('state unavailable');
  });

  it('flags nodes the portfolio could not reach even when the evidence is not marked partial', () => {
    const model = buildGitOpsStatus(liveRevision(), portfolioRow({ evidence: { partial: false, unreachableNodes: [2, 3], unknown: false } }));
    expect(model?.marker).toBe('2 nodes not reached');
  });

  it('keeps a caveat even when no stage applies', () => {
    // Silence about a stage is itself qualified by what could not be proven.
    const model = buildGitOpsStatus(liveRevision({
      targets: [],
      facets: facets({ source: { status: 'not_applicable' } }),
      limitations: [{ code: 'repo_identity_invalid', message: 'Repository identity could not be read.', evidence: null }],
    }));
    expect(model?.stages).toEqual([]);
    expect(model?.answer.title).toBe('no stage reported');
    expect(model?.marker).toBe('1 unproven');
  });

  it('says nothing when no stage applies and nothing is unproven', () => {
    expect(buildGitOpsStatus(liveRevision({ targets: [], facets: facets({ source: { status: 'not_applicable' } }) }))).toBeNull();
  });

  it('reads a posture it has no wording for as an explicit unknown', () => {
    const row = { ...portfolioRow(), posture: 'settled_by_a_newer_build' } as unknown as ReturnType<typeof portfolioRow>;
    const model = buildGitOpsStatus(liveRevision(), row);
    expect(model?.answer.title).toBe('unknown');
    expect(model?.answer.line).toContain('does not know');
  });

  it('flags partial evidence and unproven items on the answer', () => {
    const partial = buildGitOpsStatus(liveRevision(), portfolioRow({ evidence: { partial: true, unreachableNodes: [2], unknown: false } }));
    expect(partial?.marker).toBe('evidence partial · 1 node not reached');
    const unknown = buildGitOpsStatus(liveRevision(), portfolioRow({ evidence: { partial: false, unreachableNodes: [], unknown: true } }));
    expect(unknown?.marker).toBe('evidence unknown');
    const caveated = buildGitOpsStatus(liveRevision({
      limitations: [{ code: 'repo_identity_invalid', message: 'Repository identity could not be read.', evidence: null }],
    }));
    expect(caveated?.marker).toMatch(/unproven$/);
  });

  it('carries no marker when there is nothing to qualify', () => {
    expect(buildGitOpsStatus(liveRevision())?.marker).toBeNull();
  });
});

describe('isSpeakingStage', () => {
  const revision = liveRevision({
    facets: facets({
      source: plainSource('source_review_pending'),
      artifact: liveArtifact({ status: 'artifact_stale' }),
    }),
  });

  it('lets only blocking stages speak, and never the one the answer already spoke for', () => {
    const model = buildGitOpsStatus(revision);
    expect(model).not.toBeNull();
    const speaking = model!.stages.filter(s => isSpeakingStage(s, model!)).map(s => s.id);
    expect(speaking).toEqual(['artifact']);
  });

  it('keeps a settled stage quiet', () => {
    const model = buildGitOpsStatus(liveRevision({ facets: facets({ source: plainSource('application_generation_accepted') }) }));
    expect(model!.stages.some(s => isSpeakingStage(s, model!))).toBe(false);
  });
});

describe('grantedAuthority', () => {
  it('is empty when nothing was recorded, and on the absent arm', () => {
    expect(grantedAuthority(noApprovals, false)).toEqual([]);
    expect(grantedAuthority(null, false)).toEqual([]);
  });

  it('reads a recorded ref as a granted step, and nothing else as one', () => {
    const granted = grantedAuthority({ ...noApprovals, sourceAcceptanceRef: REFS.source }, false);
    expect(granted.map(g => g.approval)).toEqual(['source']);
  });

  it('does not call a stale rollout authorization granted even though its ref is stored', () => {
    // The ref proves a grant happened; the facet proves it no longer covers the current inputs.
    const approvals = { ...noApprovals, rolloutAuthorizationRef: REFS.rollout };
    expect(grantedAuthority(approvals, true)).toEqual([]);
    expect(grantedAuthority(approvals, false).map(g => g.approval)).toEqual(['rollout']);
  });

  it('keeps a legacy combined approval additional to the decomposed steps', () => {
    const granted = grantedAuthority({ ...noApprovals, sourceAcceptanceRef: REFS.source, legacyCombinedApprovalRef: REFS.legacy }, false);
    expect(granted.map(g => g.approval)).toEqual(['source', 'legacy']);
  });
});

describe('formatRetryWait', () => {
  it('words the wait in seconds, then minutes, and says when it is due', () => {
    expect(formatRetryWait(10_000, 0)).toBe('Retry in 10s');
    expect(formatRetryWait(120_000, 0)).toBe('Retry in 2m');
    expect(formatRetryWait(0, 5)).toBe('Retry due');
  });
});

describe('stage details', () => {
  const sourceModel = (source: ReturnType<typeof plainSource> | Record<string, unknown>) =>
    buildGitOpsStatus(liveRevision({ facets: facets({ source: source as ReturnType<typeof plainSource> }) }));

  it('names the failure class and the retry wait of a failed source', () => {
    const model = sourceModel({
      ...sourceIdentity({ candidateGenerationId: null }),
      status: 'source_failed',
      failureStage: 'fetch',
      failureClass: 'NETWORK_TIMEOUT',
      failureAt: 1,
      retryAt: Date.now() + 60_000,
      retryCount: 1,
    });
    expect(model?.answer.detail).toContain('NETWORK_TIMEOUT');
    expect(model?.answer.detail).toMatch(/Retry in \d+(s|m)/);
  });

  it('names the retry wait of a scheduled retry', () => {
    const model = sourceModel({
      ...sourceIdentity({ candidateGenerationId: null }),
      status: 'source_retry_scheduled',
      retryAt: Date.now() + 120_000,
      retryCount: 1,
    });
    expect(model?.answer.detail).toMatch(/^Retry in \d+(s|m)$/);
  });

  it('gives the reason a source was suspended', () => {
    const model = sourceModel({
      ...sourceIdentity({ candidateGenerationId: null }),
      status: 'source_suspended',
      suspendedAt: 1,
      suspendedReason: 'paused for maintenance',
    });
    expect(model?.answer.detail).toBe('paused for maintenance');
  });

  it('leads with the commit a waiting candidate concerns', () => {
    const model = sourceModel(plainSource('candidate_ready', { fetchedCommitSha: 'a1b2c3d4e5f6' }));
    expect(model?.answer.detail?.startsWith('Commit a1b2c3d')).toBe(true);
  });
});

describe('pending authority steps', () => {
  it.each<[string, Parameters<typeof facets>[0], string]>([
    ['source acceptance outstanding', { placement: { status: 'source_acceptance_pending', sourceAcceptanceRef: null, candidateGenerationId: 'gen-1' } }, 'source_acceptance_pending'],
    ['a stateful confirmation required', { placement: { status: 'stateful_confirmation_required' } }, 'stateful_confirmation_required'],
    ['placement review pending', { placement: { status: 'placement_review_pending' } }, 'placement_review_pending'],
    ['a preflight blocking the rollout', { placement: { status: 'preflight_blocked', reason: 'Image scan is still running.', binding: { rolloutCandidateId: 'rc-1', acceptedGenerationId: 'gen-1', artifactSetId: 'art-1', intentRevisionId: 'int-1', requiredNodeIds: [1], sourceAcceptanceRef: 's', placementApprovalRef: 'p', preflightFingerprint: 'fp' } } }, 'preflight_blocked'],
  ])('keeps %s in the path as an unsettled stage', (_name, overrides, status) => {
    const model = buildGitOpsStatus(liveRevision({ approvals: noApprovals, facets: facets({ source: plainSource('application_generation_accepted', { candidateGenerationId: null }), ...overrides }) }));
    const placement = model?.stages.find(s => s.id === 'placement');
    expect(placement?.status).toBe(status);
    expect(['warning', 'destructive', 'brand']).toContain(placement?.tone);
    expect(model?.answerStageId).toBe('placement');
  });

  it('does not read a missing ref alone as a pending step', () => {
    const model = buildGitOpsStatus(liveRevision({
      approvals: noApprovals,
      facets: facets({ source: plainSource('application_generation_accepted', { candidateGenerationId: null }) }),
    }));
    expect(model?.stages.find(s => s.id === 'placement')).toBeUndefined();
  });
});
