/**
 * Canonical types for the Git managed-file change plan: a classified compare
 * of prior-manifest paths, candidate inventory, and live disk. Internal hashes
 * stay on the planner; public projections carry operations and counts only.
 */
import type {
    DeletionAuthority,
    InputOwnership,
    InputRole,
    InputSensitivity,
    ManifestProvenance,
} from './gitProjectManifest';

export const GIT_CHANGE_PLAN_SCHEMA_VERSION = 2 as const;

export type GitChangePlanOp =
    | 'add'
    | 'modify'
    | 'delete'
    | 'rename'
    | 'unchanged'
    | 'local-modified'
    | 'local-missing'
    | 'type-changed'
    | 'unmanaged-collision'
    | 'invocation';

export type GitChangePlanMode = 'update' | 'create';

export type GitPlanLastOutcome = 'applied' | 'blocked' | 'rolled_back' | 'failed';

export const BLOCKING_CHANGE_PLAN_OPS: ReadonlySet<GitChangePlanOp> = new Set([
    'local-modified',
    'local-missing',
    'type-changed',
    'unmanaged-collision',
]);

/** One classified path (or the invocation row) before public redaction. */
export interface GitChangePlanOperation {
    pathKey: string;
    op: GitChangePlanOp;
    role: InputRole | 'build-context-file' | 'invocation';
    deletionAuthority: DeletionAuthority | null;
    priorHash: string | null;
    candidateHash: string | null;
    liveHash: string | null;
    sensitivity: InputSensitivity;
    /** Present on rename: the prior (deleted) path. */
    fromPath?: string;
    ownership: InputOwnership;
    provenance: ManifestProvenance;
    /** Commit SHA the candidate inventory was built from. */
    sourceRevision: string;
    /** Human-readable classification note (internal plan only). */
    reason: string;
}

export interface GitChangePlanCounts {
    add: number;
    modify: number;
    delete: number;
    rename: number;
    unchanged: number;
    localModified: number;
    localMissing: number;
    typeChanged: number;
    unmanagedCollision: number;
    invocation: number;
}

export interface GitChangePlan {
    schemaVersion: typeof GIT_CHANGE_PLAN_SCHEMA_VERSION;
    fingerprint: string;
    /** File conflicts only. Invocation drift is `invocationBlocked`. */
    blocked: boolean;
    /** Live Compose invocation differs from the last applied generation. */
    invocationBlocked: boolean;
    candidateInvocation: string[];
    liveInvocation: string[];
    priorInvocation: string[];
    operations: GitChangePlanOperation[];
    counts: GitChangePlanCounts;
}

/** Public operation: no hashes, high-sensitivity paths redacted to null. */
export interface PublicGitChangePlanOperation {
    path: string | null;
    op: GitChangePlanOp;
    role: GitChangePlanOperation['role'];
    fromPath?: string | null;
}

export interface PublicGitChangePlan {
    /** File conflicts only. Invocation drift is `invocation.liveDiverged`. */
    blocked: boolean;
    counts: GitChangePlanCounts;
    operations: PublicGitChangePlanOperation[];
    invocation: {
        candidateChanged: boolean;
        liveDiverged: boolean;
    };
}

/** GET /git-source pending summary stored in `pending_plan_summary`. */
export interface PublicPendingPlan {
    fingerprint: string;
    /** File conflicts only. Invocation drift is not this field. */
    blocked: boolean;
    counts: GitChangePlanCounts;
    operations: PublicGitChangePlanOperation[];
}
