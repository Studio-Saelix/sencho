/**
 * The GitOps evidence fingerprint binds a rollout preview to the authority
 * facts it displays: the apply route refuses a confirmation whose digest moved.
 * These cases pin what must move the digest (authority and identity) and what
 * deliberately must not (observations that tick on their own), because a false
 * mismatch strands the preview as permanently stale.
 */
import { describe, expect, it } from 'vitest';
import { gitopsEvidenceFingerprint } from '../services/blueprintPreviewProjection';
import type {
    ArtifactFacet,
    FutureRolloutAuthorizationBinding,
    GitOpsApprovalRefs,
    GitOpsFacets,
    GitOpsLimitation,
    GitOpsRevisionProjection,
    GitOpsTargetProjection,
    SourceFacet,
    SourceIdentityFields,
} from '../services/gitops/types';

/** The live arm of the backend union, which is not exported as a named type. */
type GitOpsRevisionLive = Extract<GitOpsRevisionProjection, { facets: GitOpsFacets }>;

const noApprovals: GitOpsApprovalRefs = {
    sourceAcceptanceRef: null,
    placementApprovalRef: null,
    rolloutAuthorizationRef: null,
    legacyCombinedApprovalRef: null,
};

const sourceIdentity: SourceIdentityFields = {
    configuredRepoUrl: 'https://example.test/acme/infra.git',
    repoIdentity: { host: 'example.test', pathname: '/acme/infra' },
    configuredRef: 'main',
    desiredCommitSha: 'a'.repeat(40),
    fetchedCommitSha: 'a'.repeat(40),
    candidateGenerationId: null,
    acceptedGenerationId: 'gen-accepted',
};

const acceptedSource: SourceFacet = {
    ...sourceIdentity,
    status: 'application_generation_accepted',
};

const exactArtifact: ArtifactFacet = {
    status: 'artifact_exact',
    artifactSetId: 'art-1',
    generationId: 'gen-accepted',
    evidenceVersion: 1,
    qualification: 'exact',
    freshnessAt: 1,
    expected: { artifactSetId: 'art-1', evidenceVersion: 1, qualification: 'exact', identity: 'nginx@sha256:abc' },
    latestEvidence: { artifactSetId: 'art-1', evidenceVersion: 1, qualification: 'exact', identity: 'nginx@sha256:abc' },
};

const authorizationBinding: FutureRolloutAuthorizationBinding = {
    rolloutCandidateId: 'candidate-1',
    acceptedGenerationId: 'gen-accepted',
    artifactSetId: 'art-1',
    intentRevisionId: 'intent-1',
    requiredNodeIds: [2, 1],
    sourceAcceptanceRef: 'acceptance-1',
    placementApprovalRef: 'placement-1',
    preflightFingerprint: 'preflight-1',
};

function target(overrides: Partial<GitOpsTargetProjection> = {}): GitOpsTargetProjection {
    return {
        nodeId: 1,
        stackName: 'web',
        desiredGenerationId: 'gen-accepted',
        candidateGenerationId: null,
        appliedGenerationId: 'gen-accepted',
        deployedGenerationId: 'gen-accepted',
        healthyGenerationId: 'gen-accepted',
        lkgGenerationId: null,
        lkgArtifactSetId: null,
        lkgUnavailableAt: null,
        lkgUnavailableReason: null,
        expectedArtifactSetId: 'art-1',
        latestArtifactSetId: 'art-1',
        artifact: exactArtifact,
        observedArtifactIdentity: { kind: 'unknown' },
        intentRevisionId: 'intent-1',
        rolloutCandidateId: 'candidate-1',
        rolloutGenerationId: 'rollout-1',
        approvals: noApprovals,
        connectivity: 'reachable',
        legacyAppliedRevision: null,
        runtime: { status: 'synced_and_healthy' },
        health: { status: 'not_applicable' },
        lkg: { status: 'none' },
        tombstoned: false,
        ...overrides,
    };
}

function liveRevision(overrides: Partial<GitOpsRevisionLive> = {}): GitOpsRevisionLive {
    return {
        schemaVersion: 1,
        targetMode: 'blueprint',
        applicationId: 'app-1',
        lifecycleStatus: 'active',
        stackName: null,
        blueprintId: 7,
        rolloutGenerationId: 'rollout-1',
        approvals: noApprovals,
        facets: {
            source: acceptedSource,
            artifact: exactArtifact,
            placement: { status: 'blueprint_bound', completion: 'unknown' },
            rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'candidate-1' },
        },
        targets: [target()],
        drift: [],
        limitations: [],
        availableActions: ['apply'],
        ...overrides,
    };
}

const absent: GitOpsRevisionProjection = {
    schemaVersion: 1,
    targetMode: 'not_applicable',
    applicationId: null,
    facets: null,
    targets: [],
    drift: [],
    limitations: [],
    availableActions: [],
    approvals: null,
};

const faultLimitation: GitOpsLimitation = {
    code: 'application_row_missing',
    message: 'The application row backing this Blueprint could not be read, so its state cannot be reported.',
    evidence: { applicationId: 'app-1' },
};

describe('gitopsEvidenceFingerprint', () => {
    it('answers null on the absent arm: there is no evidence to bind', () => {
        expect(gitopsEvidenceFingerprint(absent)).toBeNull();
    });

    it('binds the limitation codes of a projection that faulted', () => {
        const faulted = gitopsEvidenceFingerprint({
            ...absent,
            limitations: [faultLimitation],
        });
        expect(faulted).toEqual(expect.any(String));
        expect(gitopsEvidenceFingerprint({ ...absent, limitations: [] })).toBeNull();
        expect(faulted).not.toBe(gitopsEvidenceFingerprint({
            ...absent,
            limitations: [{ code: 'other_fault', message: 'Other', evidence: null }],
        }));
    });

    it('binds fault codes regardless of order or message text', () => {
        const first: GitOpsLimitation = { code: 'a', message: 'A', evidence: null };
        const second: GitOpsLimitation = { code: 'b', message: 'B', evidence: null };
        const digest = gitopsEvidenceFingerprint({ ...absent, limitations: [first, second] });
        expect(digest).not.toBeNull();
        expect(gitopsEvidenceFingerprint({ ...absent, limitations: [second, first] })).toBe(digest);
        expect(gitopsEvidenceFingerprint({
            ...absent,
            limitations: [{ ...first, message: 'A reworded' }, second],
        })).toBe(digest);
    });

    it('is stable across repeated reads of unchanged evidence', () => {
        const first = gitopsEvidenceFingerprint(liveRevision());
        expect(first).toEqual(expect.any(String));
        expect(gitopsEvidenceFingerprint(liveRevision())).toBe(first);
    });

    it('moves when the configured repository location changes', () => {
        const located = (configuredRepoUrl: string, configuredRef: string): GitOpsRevisionLive => liveRevision({
            facets: {
                ...liveRevision().facets,
                source: {
                    ...sourceIdentity,
                    status: 'application_generation_accepted',
                    configuredRepoUrl,
                    configuredRef,
                },
            },
        });
        const base = gitopsEvidenceFingerprint(located('https://example.test/acme/infra.git', 'main'));
        expect(gitopsEvidenceFingerprint(located('https://example.test/acme/other.git', 'main'))).not.toBe(base);
        expect(gitopsEvidenceFingerprint(located('https://example.test/acme/infra.git', 'develop'))).not.toBe(base);
    });

    it('moves when a not-live source is detached or deleted', () => {
        const notLive = gitopsEvidenceFingerprint(liveRevision({
            facets: {
                ...liveRevision().facets,
                source: { ...sourceIdentity, status: 'not_live', lifecycleStatus: 'detached' },
            },
        }));
        const deleted = gitopsEvidenceFingerprint(liveRevision({
            facets: {
                ...liveRevision().facets,
                source: { ...sourceIdentity, status: 'not_live', lifecycleStatus: 'deleted' },
            },
        }));
        expect(notLive).not.toBe(deleted);
    });

    it('moves when a recorded approval appears', () => {
        const base = gitopsEvidenceFingerprint(liveRevision());
        const granted = gitopsEvidenceFingerprint(liveRevision({
            approvals: { ...noApprovals, placementApprovalRef: 'placement-1' },
        }));
        expect(granted).not.toBe(base);
    });

    it.each([
        ['source acceptance', { sourceAcceptanceRef: 'source-1' }],
        ['placement approval', { placementApprovalRef: 'placement-1' }],
        ['rollout authorization', { rolloutAuthorizationRef: 'rollout-1' }],
        ['legacy combined', { legacyCombinedApprovalRef: 'legacy-1' }],
    ])('moves when the %s ref is recorded', (_label, refs: Partial<GitOpsApprovalRefs>) => {
        const base = gitopsEvidenceFingerprint(liveRevision());
        expect(gitopsEvidenceFingerprint(liveRevision({
            approvals: { ...noApprovals, ...refs },
        }))).not.toBe(base);
    });

    it('moves when the application identity or lifecycle moves', () => {
        const base = gitopsEvidenceFingerprint(liveRevision());
        expect(gitopsEvidenceFingerprint(liveRevision({ applicationId: 'app-2' }))).not.toBe(base);
        expect(gitopsEvidenceFingerprint(liveRevision({ lifecycleStatus: 'creating' }))).not.toBe(base);
    });

    it('moves when the source becomes superseded', () => {
        const base = gitopsEvidenceFingerprint(liveRevision());
        const superseded = gitopsEvidenceFingerprint(liveRevision({
            facets: {
                ...liveRevision().facets,
                source: { ...acceptedSource, status: 'source_superseded', supersededGenerationId: 'gen-old' },
            },
        }));
        expect(superseded).not.toBe(base);
    });

    it('moves when the executable artifact identity changes', () => {
        const base = gitopsEvidenceFingerprint(liveRevision());
        const resolved = gitopsEvidenceFingerprint(liveRevision({
            facets: {
                ...liveRevision().facets,
                artifact: { ...exactArtifact, artifactSetId: 'art-2', evidenceVersion: 2 },
            },
        }));
        expect(resolved).not.toBe(base);
    });

    it('moves when a stale authorization was granted against different inputs', () => {
        const stale = (preflightFingerprint: string): GitOpsRevisionLive => liveRevision({
            facets: {
                ...liveRevision().facets,
                placement: {
                    status: 'rollout_authorization_stale',
                    rolloutAuthorizationRef: 'authorization-1',
                    bound: { ...authorizationBinding, preflightFingerprint },
                },
            },
        });
        expect(gitopsEvidenceFingerprint(stale('preflight-1')))
            .not.toBe(gitopsEvidenceFingerprint(stale('preflight-2')));
    });

    it('moves when the rollout generation changes', () => {
        const base = gitopsEvidenceFingerprint(liveRevision());
        const next = gitopsEvidenceFingerprint(liveRevision({ rolloutGenerationId: 'rollout-2' }));
        expect(next).not.toBe(base);
    });

    it('moves when the accepted generation moves', () => {
        const accepted = (acceptedGenerationId: string): GitOpsRevisionLive => liveRevision({
            facets: {
                ...liveRevision().facets,
                source: { ...sourceIdentity, status: 'application_generation_accepted', acceptedGenerationId },
            },
        });
        expect(gitopsEvidenceFingerprint(accepted('gen-1')))
            .not.toBe(gitopsEvidenceFingerprint(accepted('gen-2')));
    });

    it('moves when any facet status moves', () => {
        const facets = liveRevision().facets;
        const digests = [
            gitopsEvidenceFingerprint(liveRevision()),
            gitopsEvidenceFingerprint(liveRevision({
                facets: { ...facets, artifact: { ...exactArtifact, status: 'artifact_stale' } },
            })),
            gitopsEvidenceFingerprint(liveRevision({
                facets: { ...facets, placement: { status: 'unbound_direct' } },
            })),
            gitopsEvidenceFingerprint(liveRevision({
                facets: { ...facets, rollout: { status: 'rollout_queued', rolloutGenerationId: 'rollout-1' } },
            })),
        ];
        expect(new Set(digests).size).toBe(digests.length);
    });

    it('moves when a blocked preflight reason changes', () => {
        const blocked = (reason: string): GitOpsRevisionLive => liveRevision({
            facets: {
                ...liveRevision().facets,
                placement: { status: 'preflight_blocked', reason, binding: authorizationBinding },
            },
        });
        expect(gitopsEvidenceFingerprint(blocked('registry credential missing')))
            .not.toBe(gitopsEvidenceFingerprint(blocked('target unreachable')));
    });

    it('binds the authorization binding regardless of node id order', () => {
        const stale = (requiredNodeIds: number[]): GitOpsRevisionLive => liveRevision({
            facets: {
                ...liveRevision().facets,
                placement: {
                    status: 'rollout_authorization_stale',
                    rolloutAuthorizationRef: 'authorization-1',
                    bound: { ...authorizationBinding, requiredNodeIds },
                },
            },
        });
        expect(gitopsEvidenceFingerprint(stale([1, 2]))).toBe(gitopsEvidenceFingerprint(stale([2, 1])));
        expect(gitopsEvidenceFingerprint(stale([1, 2]))).not.toBe(gitopsEvidenceFingerprint(stale([1, 3])));
    });

    it('ignores a retry being rescheduled', () => {
        const retrying = (retryCount: number): GitOpsRevisionLive => liveRevision({
            facets: {
                ...liveRevision().facets,
                source: { ...sourceIdentity, status: 'source_retry_scheduled', retryAt: 1000, retryCount },
            },
        });
        expect(gitopsEvidenceFingerprint(retrying(1))).toBe(gitopsEvidenceFingerprint(retrying(2)));
    });

    it('ignores per-target identity, which is display-only', () => {
        const deployed = (deployedGenerationId: string): GitOpsRevisionLive => liveRevision({
            targets: [target({ deployedGenerationId })],
        });
        expect(gitopsEvidenceFingerprint(deployed('gen-1'))).toBe(gitopsEvidenceFingerprint(deployed('gen-2')));
    });

    it('ignores a poll being rescheduled', () => {
        const polled = (nextPollAt: number): GitOpsRevisionLive => liveRevision({
            facets: {
                ...liveRevision().facets,
                source: { ...acceptedSource, status: 'source_poll_scheduled', nextPollAt },
            },
        });
        expect(gitopsEvidenceFingerprint(polled(1000))).toBe(gitopsEvidenceFingerprint(polled(2000)));
    });

    it('ignores artifact evidence freshness moving', () => {
        const fresh = (freshnessAt: number): GitOpsRevisionLive => liveRevision({
            facets: {
                ...liveRevision().facets,
                artifact: { ...exactArtifact, freshnessAt, status: 'artifact_exact' },
            },
        });
        expect(gitopsEvidenceFingerprint(fresh(1000))).toBe(gitopsEvidenceFingerprint(fresh(2000)));
    });

    it('ignores partial rollout progress payloads', () => {
        const partial = (partial: unknown): GitOpsRevisionLive => liveRevision({
            facets: {
                ...liveRevision().facets,
                rollout: { status: 'partially_rolled_out', partial },
            },
        });
        expect(gitopsEvidenceFingerprint(partial({ done: [1] })))
            .toBe(gitopsEvidenceFingerprint(partial({ done: [1, 2] })));
    });

    it('ignores per-target runtime observations', () => {
        const rolling = (runtime: GitOpsTargetProjection['runtime']): GitOpsRevisionLive =>
            liveRevision({ targets: [target({ runtime })] });
        expect(gitopsEvidenceFingerprint(rolling({ status: 'health_checking' })))
            .toBe(gitopsEvidenceFingerprint(rolling({ status: 'synced_and_healthy' })));
    });
});
