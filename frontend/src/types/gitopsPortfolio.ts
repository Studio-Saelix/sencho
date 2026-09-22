/**
 * Wire types for the hub-owned GitOps portfolio surface
 * (`GET /api/gitops/applications[...]`).
 *
 * These mirror `backend/src/services/gitops/portfolioTypes.ts`. The mirror is
 * deliberate (see `lib/gitopsState.ts` for the convention): status-bearing
 * fields are typed `string` here, not closed unions, because rows can carry a
 * status a newer node learned before this build did. Surfaces read them through
 * the partial lookups in `lib/gitopsPortfolio.ts`, so an unknown status renders
 * as an explicit unknown state rather than a blank cell.
 */
import type { GitOpsRevisionProjection } from '@/types/gitops';

/** Per-application attention reason, as classified server-side. */
export type GitOpsAttentionReason = string;

export type GitOpsPortfolioPosture =
  | 'failed'
  | 'attention'
  | 'in_progress'
  | 'converged'
  | 'converged_qualified'
  | 'unknown';

export interface GitOpsPortfolioRepository {
  configuredRepoUrl: string;
  host: string;
  pathname: string;
  configuredRef: string;
}

export interface GitOpsPortfolioTargetSummary {
  nodeId: number;
  nodeName: string | null;
  stackName: string | null;
  runtime: string;
  health: string;
  connectivity: string;
  evidence: 'fresh' | 'stale' | 'unknown';
}

export interface GitOpsPortfolioRow {
  id: string;
  targetMode: 'direct' | 'blueprint' | 'inline_blueprint';
  name: string;
  stackName: string | null;
  blueprintId: number | null;
  nodeId: number | null;
  nodeName: string | null;
  repository: GitOpsPortfolioRepository | null;
  desiredCommitSha: string | null;
  fetchedCommitSha: string | null;
  candidateGenerationId: string | null;
  acceptedGenerationId: string | null;
  sourceStatus: string;
  artifactStatus: string;
  artifactQualification: string | null;
  placementStatus: string;
  rolloutStatus: string;
  runtimeStatus: string;
  healthStatus: string;
  targets: GitOpsPortfolioTargetSummary[];
  drift: { count: number; classes: string[] };
  attention: GitOpsAttentionReason[];
  posture: GitOpsPortfolioPosture;
  availableActions: string[];
  limitations: string[];
  lastActivityAt: number | null;
  evidence: {
    partial: boolean;
    unreachableNodes: number[];
    unknown: boolean;
  };
}

export interface GitOpsPortfolioSummary {
  applications: number;
  attentionRequired: number;
  failed: number;
  inProgress: number;
  converged: number;
  convergedQualified: number;
  unknown: number;
  drifted: number;
  byReason: Partial<Record<string, number>>;
}

export interface GitOpsPortfolioNodeCoverage {
  nodeId: number;
  nodeName: string | null;
  state: 'ok' | 'unreachable' | 'unsupported';
}

export interface GitOpsPortfolioResponse {
  schemaVersion: 1;
  generatedAt: number;
  summary: GitOpsPortfolioSummary;
  coverage: GitOpsPortfolioNodeCoverage[];
  /**
   * Applications carrying attention reasons, over the full authorized set:
   * independent of the list filters and pagination below, so narrowing the
   * table never hides an exception from the queue. `attentionQueueTruncated`
   * flags that more reasons exist beyond this bounded list (the summary counts
   * them all regardless).
   */
  attentionQueue: GitOpsPortfolioRow[];
  attentionQueueTruncated: boolean;
  applications: GitOpsPortfolioRow[];
  nextCursor: string | null;
  truncated: boolean;
}

/**
 * One application (`GET /api/gitops/applications/:id`): the same row the list
 * serves, plus the full canonical projection behind it.
 */
export interface GitOpsPortfolioDetailResponse {
  schemaVersion: 1;
  generatedAt: number;
  application: GitOpsPortfolioRow;
  projection: GitOpsRevisionProjection;
}

/** Filter set the list route accepts; mirrored from the backend contract. */
export interface GitOpsPortfolioFilters {
  q?: string;
  attention?: '1';
  mode?: 'direct' | 'blueprint';
  nodeId?: number;
  blueprintId?: number;
  source?: string;
  rollout?: string;
  health?: string;
  drift?: string;
  evidence?: 'stale' | 'unreachable' | 'unknown';
  sort?: 'attention' | 'name' | 'activity';
  dir?: 'asc' | 'desc';
}
