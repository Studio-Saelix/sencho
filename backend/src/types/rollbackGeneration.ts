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
  /**
   * Stack-relative Compose layers this invocation selected at the project root,
   * in application order: the single root compose file Compose discovers, plus
   * its implicit override when one exists. Distinct from `explicitComposeFiles`,
   * which also names included and extended files, because those are inputs
   * rather than invocation layers. Recovery pins this set when the captured
   * prefix carries no `-f`, so a root that appeared after capture cannot shadow
   * the captured project through Compose's own auto-discovery. Omitted on
   * generations captured before it was recorded: those keep the prefix they were
   * captured with, and a recovery override names the base compose file together
   * with the implicit override, because nothing else in that prefix pins them.
   */
  composeLayers?: string[];
  /**
   * Stack-relative env files, in the order the captured run applied them, that
   * a recovery invocation must name with `--env-file` when it pins
   * `composeLayers`. Translating a `COMPOSE_FILE` selection into an explicit
   * `-f` list drops the working directory's env file out of the interpolation
   * environment; these flags put it back with the original precedence, because
   * Compose applies repeated `--env-file` arguments in order with the last one
   * winning. Recorded only when the selection moved the project directory off
   * the stack root and every named file stays inside the compose root, so a
   * recovery resolver can launch with them. Omitted on generations captured
   * before it was recorded: those keep the invocation they were captured with.
   */
  interpolationEnvFiles?: string[];
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
  /**
   * Stack-relative paths of managed inputs left out of the capture (links
   * pointing outside the stack, at nothing, or at a non-file). Restore neither
   * writes nor deletes them. Omitted on generations captured before this was
   * recorded.
   */
  uncapturedRelativePaths?: string[];
  /** The operator-facing notes for everything left out of the capture. Omitted on older generations. */
  uncapturedInputs?: string[];
  /**
   * Raw declared source paths of application data or build inputs whose path
   * holds a Compose variable (`./${DATA_DIR}/data.env`, `$BUILD_CONTEXT`). The
   * capture cannot know what the substitution resolves to at restore time, and
   * a literal suffix is not proof: the variable may stand for a directory name
   * or for the whole path. A generation that recorded one deletes nothing from
   * the live stack, because any file there may be the operator's data. A
   * legacy Git host declaration whose path was not recorded, or a bind source
   * that mounts the stack root or an ancestor of it, is represented by a
   * marker value here, with the same delete-none effect. Omitted on
   * generations captured before this was recorded.
   */
  dynamicApplicationDataSources?: string[];
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
  /**
   * Why capture must not proceed, or null: for example no readable compose
   * file, a compose file whose link leaves the compose directory, a stack
   * directory that links elsewhere, case-colliding paths, or an unreadable Mesh
   * setting. This is the only signal that blocks a capture; inputs listed in
   * `uncapturedInputs` do not.
   */
  coverageRefusal: string | null;
  /**
   * Operator-facing notes, one per declared input a generation cannot hold:
   * files outside the stack directory, paths Compose resolves at deploy time,
   * links that leave the stack or point at nothing, and env files the run loads
   * for interpolation that the generation does not hold. The deploy proceeds and
   * a rollback uses their current content. Always empty when `coverageRefusal`
   * is set.
   */
  uncapturedInputs: string[];
  /**
   * Stack-relative paths of managed inputs the capture left out: links inside
   * the stack that point outside it, at nothing, or at a non-file. Restore
   * neither writes nor deletes them, and a live restore may still remove one
   * that became a link after capture, because the generation owns that managed
   * path. Application data and build inputs (bind mounts, build contexts,
   * dockerfiles) are never managed paths and never appear here: a restore
   * leaves them alone whether they existed at capture or appeared afterwards.
   * Not every note in `uncapturedInputs` has a path here.
   */
  uncapturedRelativePaths: string[];
  /**
   * Stack-relative paths any live input declares as application data or a
   * build input, whatever else also uses them. A path can be both a bind
   * mount and a managed input, and the merged entry kind follows the last
   * input that named it, so this set is the sticky ownership record: a
   * restore never forwards one of these paths as a cleanup candidate, from
   * the live entries or the live omissions, while a captured entry at the
   * path is still a held file the restore writes back. Empty when
   * `coverageRefusal` is set.
   */
  applicationDataPaths: string[];
  /**
   * Stack-relative bind-mount sources that are directories. Their descendants
   * are application data too: a live managed file beneath one is never a
   * cleanup candidate, because deleting it would delete the data the directory
   * bind mounts. Build-context directories are excluded; their files are
   * managed build inputs. Empty when `coverageRefusal` is set.
   */
  applicationDataPathPrefixes: string[];
  /**
   * Raw declared source paths of application data or build inputs whose path
   * holds a Compose variable, so the resolved source is unknown at capture and
   * can change before restore. A literal suffix is not proof of the resolved
   * path, so a restore that sees one here deletes nothing from the live stack.
   * A legacy Git host declaration whose path was not recorded, or a bind
   * source that mounts the stack root or an ancestor of it, is represented by
   * a marker value here, because it may name any stack path. Empty when
   * `coverageRefusal` is set.
   */
  dynamicApplicationDataSources: string[];
  /**
   * Compose declarations whose referenced content was not parsed: a selected
   * COMPOSE_FILE layer that is not a conventional root candidate, or an
   * include/extends source outside the stack or selected through a variable.
   * The inventory pins a chain layer as an omission and records an outside
   * include as a note, but either can declare an input the live inventory did
   * not see. A restore cannot treat the live project's remaining paths as
   * complete while one exists. Empty when `coverageRefusal` is set.
   */
  unparsedComposeSources: string[];
}
