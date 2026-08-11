/**
 * Authored-project rollback generation content schema.
 *
 * The DB row in stack_update_recovery_generations remains the listing /
 * lifecycle authority. Files under the generation content directory are the
 * referenced content store (paths, checksums, invocation, tombstones).
 */
import type { InputDependencyKind, InputSensitivity, ManifestProvenance } from './gitProjectManifest';

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
}

export interface RollbackInvocationRecord {
  /** Ordered compose -f / project-directory / env-file args used for mutation. */
  composeArgsPrefix: string[];
  projectDirectory: string | null;
  projectName: string | null;
  explicitComposeFiles: string[];
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
  };
  images: RollbackImageIdentity[];
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
  /** True when inventory claims exact atomic coverage. */
  exactCoverage: boolean;
  coverageRefusal: string | null;
}
