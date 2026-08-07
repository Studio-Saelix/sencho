/**
 * Canonical types for the Git managed-project materialization contract (the
 * single repository file inventory consumed by every GitOps feature).
 *
 * The manifest FILE is the source of truth; `stack_git_sources` cache columns
 * are cheap projections for GET/dashboard reads. The manifest is treated as
 * untrusted input on every read: shape, enum membership, and the identity
 * stamp are validated before any field is honored.
 */

/** File-side manifest state: what the manifest file itself can express. */
export type ManifestState = 'none' | 'migrated' | 'active' | 'partial' | 'unsupported';

/**
 * DB-column manifest state, strictly wider than the file-side state.
 * `migration_required` means a manifest was expected but could not be trusted
 * (corrupt shape, identity mismatch, declined crash-recovery restore);
 * `absent` means no manifest file exists yet. Neither can be expressed by a
 * manifest file, so they live only in the DB column and the GET projection.
 */
export type GitSourceManifestState = ManifestState | 'migration_required' | 'absent';

export type InputOwnership = 'managed' | 'unmanaged';
export type ManifestProvenance = 'fetch' | 'migration' | 'adopted';
export type InputSensitivity = 'high' | 'medium' | 'low';
export type InputState = 'present' | 'tombstoned';
export type DeletionAuthority = 'sencho' | 'user' | 'none';

export type InputRole =
  | 'compose-primary'
  | 'compose-additional'
  | 'compose-override'
  | 'env'
  | 'config'
  | 'secret'
  | 'label-file'
  | 'build-context'
  | 'dockerfile'
  | 'build-secret'
  | 'build-additional-context'
  | 'bind-mount'
  | 'other';

export type InputDependencyKind =
  | 'explicit'
  | 'implicit-override'
  | 'include'
  | 'include-env'
  | 'extends'
  | 'env_file'
  | 'interpolation-env'
  | 'config'
  | 'secret'
  | 'label_file'
  | 'build-context'
  | 'dockerfile'
  | 'build-secret'
  | 'build-additional-context'
  | 'sync-env'
  | 'bind-mount';

/** One materialized or referenced input. Exactly one authoritative entry per input. */
export interface ComposeInputEntry {
  /** Repo-relative source path; null for host/unmanaged references. */
  sourcePath: string | null;
  /** Stack-relative path after materialization; null when not copied. */
  materializedPath: string | null;
  role: InputRole;
  dependencyKind: InputDependencyKind;
  ownership: InputOwnership;
  provenance: ManifestProvenance;
  sensitivity: InputSensitivity;
  /** Null for unmanaged/refused entries. */
  contentSha256: string | null;
  sizeBytes: number | null;
  state: InputState;
  /** Who may delete this path during stale cleanup (manifest-scoped authority). */
  deletionAuthority: DeletionAuthority;
  /** Refusal reason / documented limitation. */
  note: string | null;
}

export interface RefusalInfo {
  sourcePath: string | null;
  kind: string;
  reason: string;
  actionable: boolean;
}

export interface BuildContextPlan {
  /** Context root, repo-relative. */
  repoPath: string;
  /** Repo-relative dockerfile path within the context, if declared. */
  dockerfile: string | null;
  /** Materialized context size after dockerignore filtering. */
  contextBytes: number;
  ignoredCount: number;
  dockerignoreApplied: boolean;
  /** True when the context is not copied (refused). */
  excludedFromCopy: boolean;
  note: string | null;
  /**
   * File-level inventory of the materialized context (context-relative paths
   * with content hashes). Gives the context file-granular ownership: local
   * edits and files removed upstream are detected per file, so a removed file
   * can be cleared on promotion and a locally edited one refuses apply.
   */
  files: Array<{ path: string; sha256: string; sizeBytes: number }>;
}

export interface ManifestBounds {
  maxFiles: number;
  maxBytes: number;
  maxContextBytes: number;
  maxPathDepth: number;
  maxFileBytes: number;
}

/** Stamp that binds a manifest to exactly one stack on one node. */
export interface ManifestIdentity {
  nodeId: string;
  stackName: string;
  repoUrl: string;
  branch: string;
}

export interface GitProjectManifest {
  schemaVersion: 1;
  /** Incremented on every successful write. */
  manifestVersion: number;
  state: ManifestState;
  generatedAt: number;
  identity: ManifestIdentity;
  repo: { url: string; branch: string };
  resolvedRevision: { commitSha: string; fetchedAt: number };
  project: {
    /** Repo-relative project root (today's context_dir); null = repo root. */
    root: string | null;
    /** Ordered explicit repo-relative compose file set. */
    composeFiles: string[];
    /** Stack-relative, passed as --project-directory. */
    effectiveProjectDir: string | null;
    /** Pinned via -p. */
    projectName: string;
    /** Ordered compose invocation args (relative paths). */
    invocation: string[];
  };
  inputs: ComposeInputEntry[];
  refusals: RefusalInfo[];
  buildContexts: BuildContextPlan[];
  generation: { candidateDir: string; appliedDir: string; previousDir: string | null };
  counts: { managed: number; unmanaged: number; refused: number };
  bounds: ManifestBounds;
}

/** Projection served by GET /git-source and the manifest read endpoint. */
export interface ManifestSummary {
  state: GitSourceManifestState;
  manifestVersion: number;
  resolvedCommitSha: string | null;
  managedCount: number;
  unmanagedCount: number;
  refusedCount: number;
  /** Actionable refusals surfaced to the UI. */
  refused: RefusalInfo[];
  hasBuildContexts: boolean;
  generatedAt: number | null;
}

// --- Discovery result types (declared here so they land once) ---

/** A declared input found by the pure parser (no I/O yet). */
export interface DeclaredInput {
  /** Repo-relative or host path; null for non-path forms. */
  sourcePath: string | null;
  baseDir: 'repo-root' | 'project-root' | 'compose-file-dir' | 'host';
  kind: InputDependencyKind;
  role: InputRole;
  /** Compose source context for diagnostics. */
  fromFile: string | null;
  /**
   * Service name that declared this input (build declarations, env_file,
   * configs references). Pairs a build context with its own dockerfile,
   * build secrets, and additional contexts when a file declares several
   * services. Null for top-level declarations.
   */
  service: string | null;
}

/** Path with ${VAR} interpolation that Compose resolves at deploy time. */
export interface DynamicInput {
  sourcePath: string;
  kind: InputDependencyKind;
  note: string;
}

export interface ParsedDeclaredInputs {
  inputs: DeclaredInput[];
  dynamic: DynamicInput[];
  parseErrors: string[];
}

/** Classification of every declared input against the cloned tree. */
export interface InventoryResult {
  inputs: ComposeInputEntry[];
  refusals: RefusalInfo[];
  buildContexts: BuildContextPlan[];
  dynamic: DynamicInput[];
  counts: { managed: number; unmanaged: number; refused: number };
}
