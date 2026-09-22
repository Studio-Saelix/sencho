import { liveRevision } from '@/__tests__/gitopsFixtures';
import type { GitOpsRevisionProjection } from '@/types/gitops';
import type { GitOpsPortfolioDetailResponse, GitOpsPortfolioRow } from '@/types/gitopsPortfolio';

/** A portfolio row for a Direct application on node 1, with overrides. */
export function portfolioRow(overrides: Partial<GitOpsPortfolioRow> = {}): GitOpsPortfolioRow {
  return {
    id: '1:app-1',
    targetMode: 'direct',
    name: 'bookstack',
    stackName: 'bookstack',
    blueprintId: null,
    nodeId: 1,
    nodeName: 'local',
    repository: {
      configuredRepoUrl: 'https://example.test/acme/infra.git',
      host: 'example.test',
      pathname: '/acme/infra',
      configuredRef: 'main',
    },
    desiredCommitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    fetchedCommitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
    candidateGenerationId: 'gen-candidate',
    acceptedGenerationId: 'gen-accepted',
    sourceStatus: 'candidate_ready',
    artifactStatus: 'not_applicable',
    artifactQualification: null,
    placementStatus: 'unbound_direct',
    rolloutStatus: 'not_applicable',
    runtimeStatus: 'synced_and_healthy',
    healthStatus: 'not_applicable',
    targets: [{
      nodeId: 1,
      nodeName: 'local',
      stackName: 'bookstack',
      runtime: 'synced_and_healthy',
      health: 'not_applicable',
      connectivity: 'reachable',
      evidence: 'fresh',
    }],
    drift: { count: 0, classes: [] },
    attention: [],
    posture: 'converged',
    availableActions: [],
    limitations: [],
    lastActivityAt: null,
    evidence: { partial: false, unreachableNodes: [], unknown: false },
    ...overrides,
  };
}

export function detailResponse(
  row: Partial<GitOpsPortfolioRow> = {},
  projection: GitOpsRevisionProjection = liveRevision(),
): GitOpsPortfolioDetailResponse {
  return { schemaVersion: 1, generatedAt: Date.now(), application: portfolioRow(row), projection };
}
