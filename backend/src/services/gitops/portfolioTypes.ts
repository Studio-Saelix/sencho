/**
 * Wire types for the hub-owned GitOps portfolio read surface
 * (`GET /api/gitops/applications[...]`).
 *
 * These are the shapes the workplace renders. They are projections over
 * canonical GitOps state plus the per-application attention classification in
 * `attention.ts`; nothing on the wire re-derives state.
 *
 * The frontend mirrors the status-bearing fields as Partial-Record lookups
 * (the `gitopsState.ts` precedent), so a newer node answering an older build
 * degrades to an explicit unknown chip rather than a blank row, and a stale
 * hub build cannot invent a status it does not know.
 */

import type { GitOpsAttentionReason } from './attention';
import type {
  GitOpsAvailableAction,
  GitOpsDriftItem,
  GitOpsLimitation,
  GitOpsRevisionProjection,
  GitOpsTargetMode,
} from './types';

/**
 * One-line posture of an application, derived server-side.
 *
 * Ordering rule: a reason that says something *failed* outranks a pending
 * decision, which outranks work still in flight, which outranks a provably
 * converged state. `qualified` convergence stays visibly distinct from exact
 * convergence: it means runtime matches intent but the executable artifact was
 * not provable bit-identical (a multi-arch platform digest or an unverifiable
 * local build), so the stronger claim would overstate what is known.
 *
 * `unknown` is a first-class posture, not an error: it marks applications
 * whose canonical evidence cannot currently prove any other posture, so the
 * portfolio can never quietly call them healthy.
 */
export type GitOpsPortfolioPosture =
  | 'failed'
  | 'attention'
  | 'in_progress'
  | 'converged'
  | 'converged_qualified'
  | 'unknown';

/**
 * Stable portfolio identity.
 *
 * Blueprint applications are hub-owned and single-instanced by blueprint id
 * (`bp:<blueprintId>`). Direct applications live on the node that owns the
 * stack, so the id names the owning node as the hub knows it
 * (`<nodeId>:<applicationId>`). Both forms are opaque to clients; only the
 * `:id` detail route parses them back.
 */
export type GitOpsPortfolioId = string;

export type GitOpsPortfolioRepository = {
  /** Secret-free URL, rebuilt from the parsed identity (never carries userinfo). */
  configuredRepoUrl: string;
  host: string;
  pathname: string;
  configuredRef: string;
};

export type GitOpsPortfolioTargetSummary = {
  nodeId: number;
  nodeName: string | null;
  stackName: string | null;
  runtime: string;
  health: string;
  connectivity: string;
  evidence: 'fresh' | 'stale' | 'unknown';
};

/**
 * One row of the portfolio. Where a field says "status", the value is one of
 * the canonical facet statuses from `services/gitops/types.ts` (`SourceFacet`,
 * `PlacementFacet`, `RolloutFacet`, `RuntimeFacet`, `HealthFacet`,
 * `ArtifactFacet`) or a status this hub build does not know when the evidence
 * crossed a version boundary; clients must read those via their partial
 * lookups, never as exhaustively-known unions.
 */
export type GitOpsPortfolioRow = {
  id: GitOpsPortfolioId;
  targetMode: GitOpsTargetMode;
  /** Blueprint name, or the stack name for Direct applications. */
  name: string;
  stackName: string | null;
  blueprintId: number | null;
  /** Owning node for Direct applications; null on Blueprint applications. */
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
  /** Worst per-target runtime/health status. See `worstRuntime` in portfolio.ts. */
  runtimeStatus: string;
  healthStatus: string;
  targets: GitOpsPortfolioTargetSummary[];
  /** Drift confirmed by the canonical projection, as classes plus a count. */
  drift: { count: number; classes: GitOpsDriftItem['class'][] };
  attention: GitOpsAttentionReason[];
  posture: GitOpsPortfolioPosture;
  availableActions: GitOpsAvailableAction[];
  /** Limitation codes currently attached to the projection, when it is live. */
  limitations: string[];
  /**
   * Freshest evidence timestamp this instance holds for the application:
   * locally the latest recorded history entry; for remote applications the
   * freshest timestamp the projection or source row carries. Null when no
   * evidence carries a timestamp.
   */
  lastActivityAt: number | null;
  /**
   * Evidence-quality flags. `partial` means at least one contributing node
   * could not be read or gave incomplete evidence. `unknown` marks a row whose
   * payload predates the evidence fields the classification needs, so its
   * statuses are reported verbatim with no interpretation.
   */
  evidence: {
    partial: boolean;
    unreachableNodes: number[];
    unknown: boolean;
  };
};

export type GitOpsPortfolioSummary = {
  applications: number;
  attentionRequired: number;
  failed: number;
  inProgress: number;
  converged: number;
  convergedQualified: number;
  unknown: number;
  drifted: number;
  /** Count of applications carrying each attention reason. */
  byReason: Partial<Record<GitOpsAttentionReason, number>>;
};

/** How one contributing node's read went. An unreachable node is named, never silently absent. */
export type GitOpsPortfolioNodeCoverage = {
  nodeId: number;
  nodeName: string | null;
  state: 'ok' | 'unreachable' | 'unsupported';
};

export type GitOpsPortfolioResponse = {
  schemaVersion: 1;
  generatedAt: number;
  /** Whole-portfolio facts, computed over the full authorized set pre-filter. */
  summary: GitOpsPortfolioSummary;
  coverage: GitOpsPortfolioNodeCoverage[];
  /**
   * Every application carrying at least one attention reason, over the full
   * authorized set: independent of list filters and pagination, so narrowing
   * the table can never hide an exception from the queue. Bounded;
   * `attentionQueueTruncated` reports when the bound was hit (the summary
   * still counts every reason either way).
   */
  attentionQueue: GitOpsPortfolioRow[];
  attentionQueueTruncated: boolean;
  /** Filtered + sorted + paginated rows. */
  applications: GitOpsPortfolioRow[];
  nextCursor: string | null;
  /** True when the merged set exceeded the scan bound and was truncated. */
  truncated: boolean;
};

export type GitOpsPortfolioDetailResponse = {
  schemaVersion: 1;
  generatedAt: number;
  application: GitOpsPortfolioRow;
  /** The full canonical projection for the application (the SEN-510 read shape). */
  projection: GitOpsRevisionProjection;
};

/** Query filters accepted by the list route. Unknown values are rejected, not dropped. */
export type GitOpsPortfolioFilters = {
  q?: string;
  attentionOnly: boolean;
  targetMode?: 'direct' | 'blueprint';
  nodeId?: number;
  blueprintId?: number;
  sourceStatus?: string;
  rolloutStatus?: string;
  healthStatus?: string;
  driftClass?: GitOpsDriftItem['class'];
  evidence?: 'stale' | 'unreachable' | 'unknown';
  sort: 'attention' | 'name' | 'activity';
  dir: 'asc' | 'desc';
};

/** Reasons an absent facet carries: limitation codes are the raw evidence trail. */
export type { GitOpsLimitation };
