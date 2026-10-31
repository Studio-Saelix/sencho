/**
 * Canonical contracts for application-data recovery.
 *
 * Every data-protection surface (Files & Volumes, Storage, Anatomy, the
 * Recovery workplace, deploy checkpoints, mobility, drain) must import these
 * types rather than define its own storage identity, point record, coverage
 * model, engine, lock, or restore intent. This module carries no behavior.
 *
 * Configuration recovery (Fleet Snapshots, rollback generations) is a separate
 * domain and never appears here: a data point can reference a configuration
 * artifact by id, never merge with one.
 */

/** Version of the recovery contract a node speaks. Bumped only on a breaking change. */
export const RECOVERY_CONTRACT_VERSION = 1;

/**
 * Capability key for a node that can actually create and restore volume
 * points. Not in `CAPABILITIES`: the change that registers the first engine
 * adds it there too, so no build advertises protection it cannot perform. The
 * hub reads a node's status from its recovery descriptor, not from this key.
 */
export const VOLUME_PROTECTION_CAPABILITY = 'volume-protection-v1';
export const VOLUME_PROTECTION_CAPABILITY_VERSION = 1;

// --- Storage identity -------------------------------------------------------

/**
 * `named_volume` is a Docker-managed volume; `bind_root` is a reachable host
 * directory a stack binds. Anonymous volumes have no stable identity and are
 * never protectable roots.
 */
export type StorageKind = 'named_volume' | 'bind_root';

/**
 * Durable identity of one storage root on its owning node.
 *
 * Keyed by authority, owning engine, kind and canonical locator, never by an
 * integer node id, a stack name, or a container name, so it survives a stack
 * rename, a node rename and a restart. A volume deleted and recreated under the
 * same name is a new generation of the same key, linked by `lineageParentId`,
 * so a point taken of the old data is never counted as coverage of the new.
 * Shared storage is one identity with several dependents.
 */
export interface StorageIdentity {
  /** Durable id (UUID) of this generation. */
  id: string;
  /** The Sencho instance that owns this record (`recovery_authority_id`). */
  authorityId: string;
  /** Stable owning engine identity, e.g. `docker-engine:<engine id>`. */
  ownerNodeKey: string;
  kind: StorageKind;
  /** Canonical locator: the volume name, or the normalized absolute host path. */
  locator: string;
  /** Hash of authority, owner, kind and locator; equal across generations. Lock key for storage. */
  storageKey: string;
  /** 1-based generation within `storageKey`. */
  generation: number;
  /**
   * Adapter token that must change every time the storage is recreated. A
   * volume's `CreatedAt` alone does not qualify: it has one-second resolution,
   * so a `down -v` and `up` inside one second keeps it. The adapter combines it
   * with something the recreate always changes (a marker the adapter writes, or
   * the root's device and inode).
   */
  generationToken: string;
  /** Previous generation's id, or null for the first. */
  lineageParentId: string | null;
  state: 'current' | 'superseded';
  firstSeenAt: number;
  lastSeenAt: number;
}

/** One stack (and optionally service) that references a storage identity. */
export interface StorageDependent {
  stackName: string;
  /** Null (or an empty string, read back as null) when the service is not known. */
  serviceName: string | null;
}

// --- Repository -------------------------------------------------------------

export type RepositoryKind = 'local_volume';

/**
 * Whether a repository can fail together with the data it protects. A separate
 * Docker volume on the same engine is not a separate disk, so a local volume
 * repository should be registered as `same_failure_domain`; `unknown` when it
 * cannot be told.
 */
export type FailureDomainRelation = 'same_failure_domain' | 'separate' | 'unknown';

/** A recovery repository as every consumer sees it. Never carries a secret. */
export interface RepositoryDescriptor {
  id: string;
  authorityId: string;
  ownerNodeKey: string;
  kind: RepositoryKind;
  locator: string;
  /** Engine-reported repository id (restic `repository id`), set once when initialized. */
  repositoryFingerprint: string | null;
  failureDomain: FailureDomainRelation;
  /** Whether a secret is stored, never the secret itself. */
  secretState: 'absent' | 'stored';
  createdAt: number;
}

// --- Recovery points --------------------------------------------------------

export const RECOVERY_POINT_SCHEMA_VERSION = 1;

/**
 * `root` covers a whole storage root and can count toward protection. `path`
 * covers one path before a Files & Volumes mutation and never does.
 */
export type RecoveryPointKind = 'root' | 'path';

export type RecoveryPointTrigger = 'manual' | 'policy' | 'pre_change' | 'pre_restore';

/** `pending` is the only status a point can leave; every other one is final. */
export type RecoveryPointStatus = 'pending' | 'succeeded' | 'partial' | 'failed' | 'completion_unknown';

/**
 * Consistency labels this contract version supports. Nothing stronger
 * (application, database, transaction) exists until an adapter proves it.
 *
 * `crash_consistent_live` means a container was observed using the storage
 * while the capture ran, so its files may be mid-write.
 * `crash_consistent_stopped` means no container using the storage was running
 * at either check; Sencho stopped nothing, and an application that was simply
 * idle may still have had unflushed state. It is a statement about what was
 * observed, never a claim about the application's own consistency.
 */
export type ConsistencyClass = 'crash_consistent_live' | 'crash_consistent_stopped' | 'unknown';

/** Why a path was left out of a point. Only `policy_excluded` keeps a point complete. */
export type ExclusionReason = 'policy_excluded' | 'permission_denied' | 'unreadable' | 'vanished' | 'unsupported_type';

export interface PointExclusion {
  /** Path relative to the storage root. */
  path: string;
  reason: ExclusionReason;
}

/** What the engine counted while capturing a point. */
export interface CaptureSummary {
  fileCount: number;
  byteCount: number;
  /** Entries the engine could not read. Non-zero means the point is `partial`. */
  skippedCount: number;
}

export type IntegrityMethod = 'engine_check_metadata' | 'engine_check_read_data';
/** `error` is a check that could not run; it never counts as verified. */
export type IntegrityResult = 'verified' | 'mismatch' | 'error';

/** One verification of a point. Appended, never rewritten. */
export interface IntegrityVerification {
  id: string;
  pointId: string;
  method: IntegrityMethod;
  result: IntegrityResult;
  verifiedAt: number;
  /** Operation that ran the check, for the audit trail. */
  operationId: string | null;
}

/** Sanitized failure classes. Raw engine output never leaves the node. */
export type RecoveryErrorClass =
  | 'invalid_request'
  | 'permission_denied'
  | 'capability_unavailable'
  | 'update_required'
  | 'schema_unsupported'
  | 'identity_unknown'
  | 'lock_held'
  | 'lock_stale'
  | 'repository_unavailable'
  | 'repository_key_unavailable'
  | 'source_unreadable'
  | 'integrity_mismatch'
  | 'attributes_not_restored'
  | 'interrupted'
  | 'transport_unreachable'
  | 'node_refused'
  | 'node_error'
  | 'internal';

interface RecoveryPointBase {
  id: string;
  schemaVersion: number;
  storageId: string;
  storageGeneration: number;
  repositoryId: string;
  trigger: RecoveryPointTrigger;
  /** Username or policy id that asked for the point. */
  actor: string;
  sourceOperationId: string;
  sourceNodeKey: string;
  engineId: string;
  capabilityVersion: number;
  startedAt: number;
}

/** A root point covers the whole root; a path point names the path it covers. */
export type RecoveryPointScope =
  | { kind: 'root'; pathScope: null }
  | { kind: 'path'; pathScope: string };

/** What the point's status guarantees about its evidence. */
export type RecoveryPointOutcome =
  | { status: 'pending'; snapshotId: null; consistency: 'unknown'; capture: null; exclusions: []; completedAt: null; failureClass: null }
  | { status: 'succeeded' | 'partial'; snapshotId: string; consistency: ConsistencyClass; capture: CaptureSummary; exclusions: PointExclusion[]; completedAt: number; failureClass: null }
  | { status: 'failed'; snapshotId: null; consistency: 'unknown'; capture: null; exclusions: []; completedAt: number; failureClass: RecoveryErrorClass }
  | { status: 'completion_unknown'; snapshotId: null; consistency: 'unknown'; capture: null; exclusions: []; completedAt: number; failureClass: 'interrupted' };

/**
 * A versioned recovery-point record. Once its status leaves `pending` the row
 * is frozen by the database; later facts (verifications, holds) are separate
 * records.
 */
export type RecoveryPoint = RecoveryPointBase & RecoveryPointScope & RecoveryPointOutcome;

export type PointHolderKind = 'deploy_checkpoint' | 'recovery_policy' | 'mobility' | 'drain' | 'last_known_good' | 'operator';

/** Something that must keep a point from retention (checkpoint, policy, mobility, drain, LKG). */
export interface RecoveryPointHold {
  pointId: string;
  holderKind: PointHolderKind;
  holderRef: string;
  createdAt: number;
}

// --- Coverage ---------------------------------------------------------------

/**
 * Root coverage freshness. A root point older than this no longer counts toward
 * Protected; it is never a deletion trigger.
 */
export const ROOT_COVERAGE_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

export type CoverageState = 'protected' | 'partially_protected' | 'unprotected' | 'unknown';

/** Why one root is or is not covered. Only `covered` counts toward Protected. */
export type RootCoverageReason =
  | 'covered'
  | 'no_point'
  | 'in_progress'
  | 'completion_unknown'
  | 'stale'
  | 'partial_point'
  | 'failed_only'
  | 'unverified'
  | 'integrity_mismatch'
  | 'older_generation'
  | 'unsupported'
  | 'inaccessible'
  | 'identity_unknown'
  | 'evidence_inconsistent';

export type CoverageReason =
  | 'all_roots_covered'
  | 'some_roots_covered'
  | 'no_root_covered'
  | 'capability_unavailable'
  | 'capability_update_required'
  | 'capability_unknown'
  | 'no_qualifying_storage'
  | 'root_evidence_unknown';

// --- Capability -------------------------------------------------------------

/**
 * Whether volume protection can run on a node, as the hub sees it.
 * `update_required` is a real contract skew; a node on the same contract with
 * no engine is `unavailable`. Only `available` and `unavailable` are states a
 * node reports about itself; the other two are the hub's conclusions.
 */
export type VolumeProtectionState = 'available' | 'unavailable' | 'update_required' | 'unknown';

/** A volume-protection status, keyed so a state can only carry the reasons that explain it. */
export type VolumeProtectionStatus = {
  capability: typeof VOLUME_PROTECTION_CAPABILITY;
  version: number;
} & (
  | { state: 'available'; reason: 'engine_registered' }
  | {
      state: 'unavailable';
      reason:
        | 'engine_not_installed'
        | 'schema_newer_than_build'
        | 'recovery_store_unavailable'
        // Added with the first engine: this build can protect volumes, and one
        // of the things it needs is not ready. Additive to the contract, so an
        // older hub reads the pair as an invalid descriptor, i.e. Unknown.
        | 'engine_starting'
        | 'helper_unavailable'
        | 'repository_not_initialized'
        | 'repository_unavailable'
        | 'repository_key_unavailable';
    }
  | { state: 'update_required'; reason: 'node_contract_older' | 'hub_contract_older' }
  | {
    state: 'unknown';
    reason: 'node_unreachable' | 'node_refused' | 'node_error' | 'descriptor_invalid' | 'descriptor_mismatch';
  }
);

/** What a node reports about its own recovery support. Metadata only. */
export interface RecoveryNodeDescriptor {
  contractVersion: number;
  volumeProtection: VolumeProtectionStatus;
}

// --- Operations and locks ---------------------------------------------------

export type RecoveryOperationKind = 'create_point' | 'verify_point' | 'restore' | 'repository_init';

/** The states an operation can end in. `completion_unknown` is never success and never retried silently. */
export const TERMINAL_OPERATION_STATES = ['succeeded', 'partial', 'failed', 'cancelled', 'completion_unknown'] as const;
export type TerminalOperationState = (typeof TERMINAL_OPERATION_STATES)[number];
export type RecoveryOperationState = 'queued' | 'running' | TerminalOperationState;

/** How the request reached the node that executes it. */
export type RecoveryTransport = 'local' | 'node_proxy' | 'pilot_tunnel';

/** How an operation ends, with the error class each ending requires. */
export type OperationFinish =
  | { state: 'succeeded' | 'cancelled' }
  | { state: 'partial' | 'failed'; errorClass: RecoveryErrorClass }
  | { state: 'completion_unknown' };

export interface RecoveryOperation {
  id: string;
  /** Caller-supplied key that makes a replayed request return the same operation. */
  idempotencyKey: string;
  kind: RecoveryOperationKind;
  storageId: string | null;
  pointId: string | null;
  actor: string;
  transport: RecoveryTransport;
  state: RecoveryOperationState;
  errorClass: RecoveryErrorClass | null;
  /** Fixed, sanitized description of `errorClass`; never raw engine output. */
  errorDetail: string | null;
  /** Process epoch that created and owns the operation; a different epoch at boot means interrupted. */
  processEpoch: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

/** A storage lock is keyed by `StorageIdentity.storageKey`, a repository lock by its id. */
export type RecoveryLockTarget =
  | { scope: 'storage'; resourceKey: string }
  | { scope: 'repository'; resourceKey: string };
export type RecoveryLockScope = RecoveryLockTarget['scope'];

export type RecoveryLock = RecoveryLockTarget & {
  ownerOperationId: string;
  processEpoch: string;
  acquiredAt: number;
  /**
   * Set when the owner ended `completion_unknown`, at runtime or by boot
   * reconciliation. The row is removed only by a reviewed release.
   */
  staleSince: number | null;
};

export type ProgressPhase = 'preparing' | 'scanning' | 'transferring' | 'verifying' | 'finalizing';

/** Bounded progress an engine reports while running. */
export interface RecoveryProgress {
  operationId: string;
  phase: ProgressPhase;
  filesDone: number;
  bytesDone: number;
  /** Null when the engine cannot estimate a total. */
  bytesTotal: number | null;
}

// --- Engine contract --------------------------------------------------------

/** What the engine needs to run one operation on the owning node. */
export interface EngineExecutionContext {
  operationId: string;
  /**
   * The point this run is for: the point being captured, or the point being
   * verified or restored. The engine uses it as the capture's own tag, so a
   * snapshot in the repository can always be traced back to the record of it.
   */
  pointId?: string | null;
  /** The lock the operation holds; an engine never runs without one. */
  lock: RecoveryLock;
  signal: AbortSignal;
  onProgress: (progress: RecoveryProgress) => void;
}

export type CreatePointRequest = {
  storage: StorageIdentity;
  repository: RepositoryDescriptor;
  trigger: RecoveryPointTrigger;
  actor: string;
} & (
  | { kind: 'root'; pathScope?: undefined }
  | { kind: 'path'; pathScope: string }
);

/**
 * Restore targets. Overwrite of a live destination is a separate, staged mode,
 * pinned to the generation token the operator saw. The executor must compare it
 * with a fresh observation of the storage, not only the stored identity, so a
 * volume recreated since then is refused.
 */
export type RestoreTarget =
  | { mode: 'new_volume'; volumeName: string }
  | { mode: 'new_path'; hostPath: string }
  | { mode: 'staged_overwrite'; storageId: string; expectedGenerationToken: string; preRestorePointId: string };

export type RestoreIntentPhase =
  | 'recorded' | 'staging' | 'staged_verified' | 'swapping' | 'committed' | 'rolled_back' | 'completion_unknown';

/**
 * The shape of a restore's durable record. The slice that implements restore
 * must persist it before any byte moves and reconcile it at boot, so a restart
 * never starts workloads against half-written data.
 */
export interface RestoreIntent {
  id: string;
  operationId: string;
  pointId: string;
  /** The repository that holds the point, resolved once at admission. */
  repositoryId: string;
  /** The snapshot to restore, copied from the point so a later edit cannot move it. */
  snapshotId: string | null;
  target: RestoreTarget;
  /** Path inside the point to restore; null restores the whole point. */
  pathScope: string | null;
  phase: RestoreIntentPhase;
  actor: string;
  createdAt: number;
}

/**
 * Outcome of one engine call: the evidence, or a sanitized failure. A capture
 * that skipped data is still `ok: true` with its skipped count; the point store
 * records it as `partial`.
 */
export type EngineResult<T> =
  | { ok: true; evidence: T }
  | { ok: false; errorClass: RecoveryErrorClass };

export interface PointCaptureEvidence {
  snapshotId: string;
  capture: CaptureSummary;
  exclusions: PointExclusion[];
  consistency: ConsistencyClass;
}

export interface RestoreEvidence {
  filesRestored: number;
  bytesRestored: number;
  verified: boolean;
  /**
   * Extended-attribute sets restic could not apply (file capabilities, SELinux
   * labels). Non-zero with `verified: false` means the files are there and a
   * piece of their metadata is not: the operation reports `partial`, never
   * success, and never pretends the volume is a clean restore.
   */
  xattrWarnings?: number;
}

/** What an engine reports about itself on this node. */
export interface EngineProbe {
  engineId: string;
  /** Pinned engine build, e.g. an image digest. */
  build: string;
  usable: boolean;
}

/**
 * The single engine contract every adapter implements. Engines execute on the
 * node that owns the data; bytes never transit the hub. A check that could not
 * run is `ok: false`; a check that ran answers `verified` or `mismatch`.
 */
export interface BackupEngine {
  readonly engineId: string;
  readonly contractVersion: typeof RECOVERY_CONTRACT_VERSION;
  readonly storageKinds: readonly StorageKind[];
  probe(): Promise<EngineProbe>;
  createPoint(request: CreatePointRequest, ctx: EngineExecutionContext): Promise<EngineResult<PointCaptureEvidence>>;
  verifyPoint(
    point: Extract<RecoveryPoint, { status: 'succeeded' | 'partial' }>,
    method: IntegrityMethod,
    ctx: EngineExecutionContext,
  ): Promise<EngineResult<{ result: 'verified' | 'mismatch' }>>;
  restore(intent: RestoreIntent, ctx: EngineExecutionContext): Promise<EngineResult<RestoreEvidence>>;
}
