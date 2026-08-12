/**
 * Authored-project rollback generation content schema.
 *
 * The DB row in stack_update_recovery_generations remains the listing /
 * lifecycle authority. Files under the generation content directory are the
 * referenced content store (paths, checksums, invocation, tombstones).
 */
import type { GitSourceManifestState, InputDependencyKind, InputSensitivity, ManifestProvenance } from './gitProjectManifest';

export const ROLLBACK_GENERATION_SCHEMA_VERSION = 1 as const;

export type RollbackOperationKind =
  | 'update'
  | 'deployment'
  | 'git_apply'
  | 'manual_backup'
  | 'unknown';

export type RollbackEntryKind =
  | InputDependencyKind
  | 'compose-root'
  | 'project-env'
  | 'invocation-meta'
  | 'other';

export type RollbackEntryProvenance = ManifestProvenance | 'authored' | 'sencho-generated';

export interface RollbackGenerationEntry {
  /** Stack-relative POSIX path. */
  relativePath: string;
  dependencyKind: RollbackEntryKind;
  provenance: RollbackEntryProvenance;
  /** present = file captured; tombstoned = must be absent after restore. */
  state: 'present' | 'tombstoned';
  contentSha256: string | null;
  sizeBytes: number | null;
  sensitivity: InputSensitivity;
  /** When true, content is encrypted at rest in the generation store. */
  encrypted: boolean;
  /**
   * POSIX permission bits (mode & 0o777) at capture. Null on legacy generations
   * or platforms where mode could not be read.
   */
  mode: number | null;
}

export interface RollbackInvocationRecord {
  /** Ordered compose -f / project-directory / env-file args used for mutation. */
  composeArgsPrefix: string[];
  projectDirectory: string | null;
  projectName: string | null;
  explicitComposeFiles: string[];
  /** Stack-relative mesh override path when Mesh was part of the capture invocation. */
  meshOverrideRelativePath?: string | null;
  /** True when Mesh was enabled for the stack at capture time. */
  meshEnabled?: boolean;
}

export interface RollbackGitIdentity {
  repoUrl: string;
  branch: string;
  commitSha: string;
  manifestVersion: number | null;
}

export interface RollbackImageIdentity {
  serviceName: string;
  imageId: string | null;
  repoDigest: string | null;
  platform: string | null;
  declaredImageRef: string | null;
}

/** On-disk generation.json for one recovery content directory. */
export interface RollbackGenerationManifest {
  schemaVersion: typeof ROLLBACK_GENERATION_SCHEMA_VERSION;
  capabilityVersion: 1;
  generationId: string;
  nodeId: number;
  stackName: string;
  capturedAt: number;
  operationKind: RollbackOperationKind;
  entries: RollbackGenerationEntry[];
  /**
   * Full managed relative-path set at capture time. Restore may delete live
   * files in this set that are not present entries (tombstones / absent-at-
   * capture). Paths outside this set are never touched by restore unless they
   * also appear in the caller-supplied liveManagedPaths discovery set.
   */
  managedRelativePaths: string[];
  invocation: RollbackInvocationRecord;
  git: RollbackGitIdentity | null;
  /** Prior applied/deployed/LKG refs when known (opaque strings). */
  priorRecords: {
    appliedDeploySpec: string | null;
    lkgHint: string | null;
    /** Git DB snapshot at capture (restored with files so Compose args match). */
    lastAppliedContentHash: string | null;
    manifestState: string | null;
    manifestGeneration: string | null;
    /**
     * True when git-manifest.v1.json was snapshotted into the generation.
     * False means the capture-time managed manifesto was absent (first apply
     * preimage); restore must clear any manifesto written after capture.
     * Omitted on older generations: inferred from whether the snapshot file exists.
     */
    gitManifestCaptured?: boolean;
  };
  images: RollbackImageIdentity[];
}

/** Durable Git database projection stored in restore-intent.json. */
export interface RollbackGitDbSnapshot {
  appliedDeploySpec: { files: string[]; contextDir: string | null } | null;
  lastAppliedCommitSha: string | null;
  lastAppliedContentHash: string | null;
  manifestVersion: number | null;
  manifestState: GitSourceManifestState | null;
  manifestGeneration: string | null;
}

/**
 * Git DB + managed-manifesto preimage recorded before a restore mutates the
 * live stack. Used as restoreGeneration transactionMeta and as
 * RollbackRestoreIntent.gitSide.
 */
export interface RollbackRestoreTransactionMeta {
  gitDbBefore: RollbackGitDbSnapshot | null;
  /** Raw manifest.v1.json text before restore, or null when absent. */
  managedManifestBefore: string | null;
}

/**
 * Crash-safe restore intent: pre-restore filesystem snapshot plus the Git DB
 * and managed-manifesto state that must be reinstated if the process dies
 * before commitRestoreTransaction.
 */
export interface RollbackRestoreIntent {
  generationId: string;
  stackName: string;
  nodeId: number;
  paths: string[];
  at: number;
  /**
   * Present when compensate recorded Git side-state. Absent on older intents
   * (filesystem-only reversion).
   */
  gitSide?: RollbackRestoreTransactionMeta;
}

export interface ResolvedRollbackInventory {
  entries: Array<{
    relativePath: string;
    dependencyKind: RollbackEntryKind;
    provenance: RollbackEntryProvenance;
    sensitivity: InputSensitivity;
    /** Absolute path on the live stack when present; null if absent (tombstone candidate). */
    absolutePath: string | null;
  }>;
  invocation: RollbackInvocationRecord;
  git: RollbackGitIdentity | null;
  appliedDeploySpec: string | null;
  lastAppliedContentHash: string | null;
  manifestState: string | null;
  manifestGeneration: string | null;
  /** True when inventory claims exact atomic coverage. */
  exactCoverage: boolean;
  coverageRefusal: string | null;
}
