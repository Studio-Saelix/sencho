/**
 * Canonical contracts for application-data recovery.
 *
 * Every data-protection surface (Files & Volumes, Storage, Anatomy, the
 * Recovery workplace, deploy checkpoints, mobility, drain) imports these types
 * rather than defining its own storage identity, point record, coverage model,
 * engine, lock, or restore intent. This module carries no behavior.
 *
 * Configuration recovery (Fleet Snapshots, rollback generations) is a separate
 * domain and never appears here: a data point can reference a configuration
 * artifact by id, never merge with one.
 */

/** Version of the recovery contract a node speaks. Bumped only on a breaking change. */
export const RECOVERY_CONTRACT_VERSION = 1;

/**
 * Capability key a node advertises in `/api/meta` once it can actually create
 * and restore volume points. Deliberately absent from `CAPABILITIES` until an
 * engine is registered, so no build advertises protection it cannot perform.
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
  /** Hash of authority, owner, kind and locator; equal across generations. */
  storageKey: string;
  /** 1-based generation within `storageKey`. */
  generation: number;
  /** Opaque adapter token that changes when the underlying storage is recreated. */
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
  /** Null when the reference is stack-wide or the service is not known. */
  serviceName: string | null;
}

// --- Repository -------------------------------------------------------------

export type RepositoryKind = 'local_volume';

/**
 * Whether a repository can fail together with the data it protects. A separate
 * Docker volume on the same engine is not a separate disk, so the local default
 * is `same_failure_domain`; `unknown` when it cannot be told.
 */
export type FailureDomainRelation = 'same_failure_domain' | 'separate' | 'unknown';

/** A recovery repository as every consumer sees it. Never carries a secret. */
export interface RepositoryDescriptor {
  id: string;
  authorityId: string;
  ownerNodeKey: string;
  kind: RepositoryKind;
  locator: string;
  /** Engine-reported repository id (restic `repository id`), once initialized. */
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

/** Terminal point statuses are immutable; `pending` is the only mutable one. */
export type RecoveryPointStatus = 'pending' | 'succeeded' | 'partial' | 'failed' | 'completion_unknown';
export type TerminalRecoveryPointStatus = Exclude<RecoveryPointStatus, 'pending'>;

/**
 * Phase A consistency labels. Nothing stronger (application, database,
 * transaction) exists until an adapter proves it.
 */
export type ConsistencyClass = 'crash_consistent_live' | 'crash_consistent_stopped' | 'unknown';

/** A path left out of a point, with the reason. Skipped data disqualifies coverage. */
export interface PointExclusion {
  /** Path relative to the storage root. */
  path: string;
  reason: 'policy_excluded' | 'permission_denied' | 'unreadable' | 'vanished' | 'unsupported_type';
}

/** What the engine counted while capturing a point. */
export interface CaptureSummary {
  fileCount: number;
  byteCount: number;
  /** Entries the engine could not read. Non-zero means the point is `partial`. */
  skippedCount: number;
}

export type IntegrityMethod = 'engine_check_metadata' | 'engine_check_read_data';
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
  | 'interrupted'
  | 'transport_unreachable'
  | 'internal';

/** A versioned recovery-point record. */
export interface RecoveryPoint {
  id: string;
  schemaVersion: number;
  storageId: string;
  storageGeneration: number;
  kind: RecoveryPointKind;
  /** Relative path a `path` point covers; null for a `root` point. */
  pathScope: string | null;
  repositoryId: string;
  /** Engine snapshot id; null until the engine reports one. */
  snapshotId: string | null;
  status: RecoveryPointStatus;
  consistency: ConsistencyClass;
  capture: CaptureSummary | null;
  exclusions: PointExclusion[];
  trigger: RecoveryPointTrigger;
  /** Username or policy id that asked for the point. */
  actor: string;
  sourceOperationId: string;
  sourceNodeKey: string;
  engineId: string;
  capabilityVersion: number;
  startedAt: number;
  completedAt: number | null;
  failureClass: RecoveryErrorClass | null;
  /** Always true: a terminal point is never rewritten. Holds and verifications live elsewhere. */
  immutable: true;
}

/** Something that must keep a point from retention (checkpoint, policy, mobility, drain, LKG). */
export interface RecoveryPointHold {
  pointId: string;
  holderKind: 'deploy_checkpoint' | 'recovery_policy' | 'mobility' | 'drain' | 'last_known_good' | 'operator';
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
  | 'capability_unknown'
  | 'no_qualifying_storage'
  | 'root_evidence_unknown';

// --- Capability -------------------------------------------------------------

/**
 * Whether volume protection can run on a node, as the hub sees it.
 * `update_required` is reserved for a real version skew; a node on the same
 * contract that simply has no engine is `unavailable`.
 */
export type VolumeProtectionState = 'available' | 'unavailable' | 'update_required' | 'unknown';

export type VolumeProtectionReason =
  | 'engine_registered'
  | 'engine_not_installed'
  | 'schema_newer_than_build'
  | 'recovery_store_unavailable'
  | 'node_contract_older'
  | 'hub_contract_older'
  | 'node_unreachable'
  | 'descriptor_invalid';

export interface VolumeProtectionStatus {
  capability: typeof VOLUME_PROTECTION_CAPABILITY;
  version: number;
  state: VolumeProtectionState;
  reason: VolumeProtectionReason;
}

/** What a node reports about its own recovery support. Metadata only. */
export interface RecoveryNodeDescriptor {
  contractVersion: number;
  volumeProtection: VolumeProtectionStatus;
}

// --- Operations and locks ---------------------------------------------------

export type RecoveryOperationKind = 'create_point' | 'verify_point' | 'restore' | 'repository_init';

/**
 * `completion_unknown` is what an interrupted operation becomes after a
 * restart: never success, never silently retried.
 */
export type RecoveryOperationState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'completion_unknown';

export const TERMINAL_OPERATION_STATES: readonly RecoveryOperationState[] = [
  'succeeded', 'partial', 'failed', 'cancelled', 'completion_unknown',
];

/** How the request reached the node that executes it. */
export type RecoveryTransport = 'local' | 'node_proxy' | 'pilot_tunnel';

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
  /** Process epoch that last owned the operation; a different epoch at boot means interrupted. */
  processEpoch: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export type RecoveryLockScope = 'storage' | 'repository';

export interface RecoveryLock {
  scope: RecoveryLockScope;
  /** Storage key or repository id. */
  resourceKey: string;
  ownerOperationId: string;
  processEpoch: string;
  acquiredAt: number;
  /** Set at boot when the owning process is gone; cleared only by a reviewed release. */
  staleSince: number | null;
}

/** Bounded progress an engine reports while running. */
export interface RecoveryProgress {
  operationId: string;
  phase: 'preparing' | 'scanning' | 'transferring' | 'verifying' | 'finalizing';
  filesDone: number;
  bytesDone: number;
  /** Null when the engine cannot estimate a total. */
  bytesTotal: number | null;
}

// --- Engine contract --------------------------------------------------------

/** What the engine needs to run one operation on the owning node. */
export interface EngineExecutionContext {
  operationId: string;
  /** The lock the operation holds; an engine never runs without one. */
  lock: RecoveryLock;
  signal: AbortSignal;
  onProgress: (progress: RecoveryProgress) => void;
}

export interface CreatePointRequest {
  storage: StorageIdentity;
  repository: RepositoryDescriptor;
  kind: RecoveryPointKind;
  /** Required for a `path` point, absent for a `root` point. */
  pathScope?: string;
  trigger: RecoveryPointTrigger;
  actor: string;
}

/** Restore targets. Overwrite of a live destination is a separate, staged mode. */
export type RestoreTarget =
  | { mode: 'new_volume'; volumeName: string }
  | { mode: 'new_path'; hostPath: string }
  | { mode: 'staged_overwrite'; storage: StorageIdentity; preRestorePointId: string };

/**
 * The durable record of a restore, written before any byte moves so a restart
 * can reconcile it instead of starting workloads against half-written data.
 */
export interface RestoreIntent {
  id: string;
  operationId: string;
  pointId: string;
  target: RestoreTarget;
  /** Path inside the point to restore; null restores the whole point. */
  pathScope: string | null;
  phase: 'recorded' | 'staging' | 'staged_verified' | 'swapping' | 'committed' | 'rolled_back' | 'completion_unknown';
  actor: string;
  createdAt: number;
}

/** Outcome of one engine call: either the evidence, or a sanitized failure. */
export type EngineResult<T> =
  | { ok: true; evidence: T }
  | { ok: false; errorClass: RecoveryErrorClass; partialEvidence?: T };

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
 * node that owns the data; bytes never transit the hub.
 */
export interface BackupEngine {
  readonly engineId: string;
  readonly contractVersion: typeof RECOVERY_CONTRACT_VERSION;
  readonly storageKinds: readonly StorageKind[];
  probe(): Promise<EngineProbe>;
  createPoint(request: CreatePointRequest, ctx: EngineExecutionContext): Promise<EngineResult<PointCaptureEvidence>>;
  verifyPoint(point: RecoveryPoint, method: IntegrityMethod, ctx: EngineExecutionContext): Promise<EngineResult<{ result: IntegrityResult }>>;
  restore(intent: RestoreIntent, ctx: EngineExecutionContext): Promise<EngineResult<RestoreEvidence>>;
}
