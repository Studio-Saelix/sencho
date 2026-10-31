import { createHash, randomUUID } from 'crypto';
import type Docker from 'dockerode';
import DockerController from '../DockerController';
import { errorMessageForLog, sanitizeForLog } from '../../utils/safeLog';
import type { LocalVolumeProtectionHealth } from './capability';
import {
  RepositoryProvisioner,
  checkRepository,
  generationOfLocator,
  ownerNodeKeyFor,
  readRepositoryConfig,
  recordRepositoryCheck,
  unlockRepository,
} from './localRepository';
import { RecoveryHelperRunner, HELPER_LABEL_RESTORE_INTENT } from './restic/helperRunner';
import { inspectHelperImage, resolveHelperImageRef, type HelperImageState } from './restic/helperImage';
import { RESTIC_ENGINE_ID, ResticEngine } from './restic/ResticEngine';
import { RecoveryOperationStore } from './operations';
import { RecoveryPointStore } from './recoveryPoints';
import { RecoveryRepositoryStore } from './repositories';
import { classifyRecoveryError, RecoveryError } from './redaction';
import { getRecoveryAuthorityId } from './recoveryDb';
import { RestoreIntentStore, reconcileRestoreIntentsAtStartup } from './restoreIntents';
import { StorageIdentityStore } from './storageIdentity';
import SelfIdentityService from '../SelfIdentityService';
import {
  describeStoredLocator,
  describeVolumeLocator,
  knownStacksFor,
  observeVolumeInUse,
  probeGenerationToken,
  resolveVolumeDependents,
} from './volumeSources';
import type {
  BackupEngine,
  EngineExecutionContext,
  IntegrityMethod,
  OperationFinish,
  RecoveryErrorClass,
  RecoveryOperation,
  RecoveryProgress,
  RepositoryDescriptor,
  StorageDependent,
} from './types';

/**
 * Runs recovery work on the node that owns the data.
 *
 * Two halves. The *admission* half is synchronous: a route validates, checks
 * readiness, resolves dependents, authorizes, probes the generation, records the
 * operation and takes the locks, and only then answers `202`. That is where a
 * real `409` (a lock is held, or is stale) and a real `503` (the engine is not
 * ready) come from, because a background task cannot answer an HTTP request.
 *
 * The *work* half is asynchronous, keyed by operation id, with one abort
 * controller and one progress record per running operation. It ends the point
 * first and the operation second, so an interruption can never leave a point
 * that looks finished next to an operation that is not.
 *
 * Boot is a gate as well as a sequence: until it finishes, every mutating route
 * answers `503 capability_unavailable` with reason `engine_starting`.
 */

/** The warning every repository and create-point answer carries. */
export const SAME_FAILURE_DOMAIN_WARNING =
  'Recovery points live on this node, in a Docker volume on the same host as the data they protect. They are not an off-host copy: losing this host loses both.';

export const RECOVERY_FAILURE_DOMAIN = 'same_failure_domain' as const;

export interface BootState {
  ready: boolean;
  startedAt: number | null;
  finishedAt: number | null;
  /** Why boot has not finished, when it has not. */
  reason: 'engine_starting' | null;
}

interface HealthSnapshot {
  health: LocalVolumeProtectionHealth;
  checkedAt: number;
  lastDeepCheckAt: number | null;
}

interface RunningWork {
  controller: AbortController;
  progress: RecoveryProgress | null;
}

/** How stale the cached health may be before a read refreshes it in the background. */
const HEALTH_TTL_MS = 60_000;

export interface AdmissionResult {
  operation: RecoveryOperation;
  replayed: boolean;
}

/**
 * A test seam: the engine every operation uses. Production always builds a
 * `ResticEngine`; a test can substitute one to exercise the runner's own logic
 * (settling, locking, verification, rollback) without a daemon.
 */
export type EngineFactory = (context: {
  repository: RepositoryDescriptor;
  operationId: string;
  signal: AbortSignal;
}) => BackupEngine;

export class RecoveryEngineService {
  private static instances = new Map<number, RecoveryEngineService>();
  private static engineFactory: EngineFactory | null = null;

  private readonly operations = RecoveryOperationStore.getInstance();
  private readonly points = RecoveryPointStore.getInstance();
  private readonly repositories = RecoveryRepositoryStore.getInstance();
  private readonly intents = RestoreIntentStore.getInstance();
  private readonly provisioner = new RepositoryProvisioner();

  private boot: BootState = { ready: false, startedAt: null, finishedAt: null, reason: 'engine_starting' };
  private healthSnapshot: HealthSnapshot | null = null;
  private healthRefresh: Promise<void> | null = null;
  private readonly work = new Map<string, RunningWork>();
  private readonly pending = new Map<string, Promise<void>>();
  private runner: RecoveryHelperRunner | null = null;

  private constructor(private readonly nodeId: number) {}

  static getInstance(nodeId: number): RecoveryEngineService {
    let instance = RecoveryEngineService.instances.get(nodeId);
    if (!instance) {
      instance = new RecoveryEngineService(nodeId);
      RecoveryEngineService.instances.set(nodeId, instance);
    }
    return instance;
  }

  /** Test seam: substitute the helper runner, so a probe needs no daemon. */
  setHelperRunnerForTests(helper: RecoveryHelperRunner | null): void {
    this.runner = helper;
  }

  /** Test seam: substitute the engine every operation builds. */
  static setEngineFactoryForTests(factory: EngineFactory | null): void {
    RecoveryEngineService.engineFactory = factory;
  }

  /** Test seam: open the boot gate without a daemon. */
  markReadyForTests(health: LocalVolumeProtectionHealth = { state: 'available' }): void {
    this.healthSnapshot = { health, checkedAt: Date.now(), lastDeepCheckAt: Date.now() };
    this.boot = { ready: true, startedAt: Date.now(), finishedAt: Date.now(), reason: null };
  }

  /** Test seam: drop every per-node instance and its cached state. */
  static resetForTests(): void {
    for (const instance of RecoveryEngineService.instances.values()) instance.shutdown();
    RecoveryEngineService.instances.clear();
    RecoveryEngineService.engineFactory = null;
  }

  private shutdown(): void {
    for (const running of this.work.values()) running.controller.abort();
    this.work.clear();
    this.pending.clear();
    this.healthSnapshot = null;
    this.runner = null;
    this.boot = { ready: false, startedAt: null, finishedAt: null, reason: 'engine_starting' };
  }

  get processEpoch(): string {
    return this.operations.processEpoch;
  }

  getBootState(): BootState {
    return this.boot;
  }

  isReady(): boolean {
    return this.boot.ready;
  }

  // --- Health ---------------------------------------------------------------

  /**
   * The cached health answer, for a descriptor or a status read. Never awaits a
   * container: a read that finds the cache stale starts a refresh and answers
   * with what it has.
   */
  health(): LocalVolumeProtectionHealth {
    if (!this.boot.ready) return { state: 'unavailable', reason: 'engine_starting' };
    const snapshot = this.healthSnapshot;
    if (!snapshot) {
      void this.refreshHealth();
      return { state: 'unavailable', reason: 'engine_starting' };
    }
    if (snapshot.checkedAt + HEALTH_TTL_MS < Date.now()) void this.refreshHealth();
    return snapshot.health;
  }

  /** Cheap checks only: the image, the volume, the key, the fingerprint, the last check. */
  async refreshHealth(): Promise<void> {
    if (this.healthRefresh) return this.healthRefresh;
    this.healthRefresh = this.refreshHealthInternal()
      .catch((err: unknown) => {
        console.warn('[Recovery] Health refresh failed:', errorMessageForLog(err));
        this.healthSnapshot = {
          health: { state: 'unavailable', reason: 'repository_unavailable' },
          checkedAt: Date.now(),
          lastDeepCheckAt: this.healthSnapshot?.lastDeepCheckAt ?? null,
        };
      })
      .finally(() => {
        this.healthRefresh = null;
      });
    return this.healthRefresh;
  }

  private async refreshHealthInternal(): Promise<void> {
    const health = await this.computeCheapHealth();
    this.healthSnapshot = {
      health,
      checkedAt: Date.now(),
      lastDeepCheckAt: this.healthSnapshot?.lastDeepCheckAt ?? null,
    };
  }

  /**
   * A health check that opens the repository. Only callers that already hold the
   * repository lock (boot, provisioning, and the end of an operation) run this.
   */
  async refreshHealthDeep(operationId: string): Promise<void> {
    const cheap = await this.computeCheapHealth();
    if (cheap.state === 'unavailable') {
      this.healthSnapshot = { health: cheap, checkedAt: Date.now(), lastDeepCheckAt: Date.now() };
      return;
    }
    const repository = this.repositories.getActive();
    if (!repository) {
      this.healthSnapshot = {
        health: { state: 'unavailable', reason: 'repository_not_initialized' },
        checkedAt: Date.now(),
        lastDeepCheckAt: Date.now(),
      };
      return;
    }
    try {
      const secret = this.repositories.readSecret(repository.id);
      const opened = await readRepositoryConfig({
        runner: this.helperRunner(),
        repositoryVolume: repository.locator,
        secret,
        operationId,
      });
      const health: LocalVolumeProtectionHealth = opened.kind === 'open'
        ? { state: 'available' }
        : opened.kind === 'absent'
          ? { state: 'unavailable', reason: 'repository_not_initialized' }
          : { state: 'unavailable', reason: healthReasonFor(opened.errorClass) };
      this.healthSnapshot = { health, checkedAt: Date.now(), lastDeepCheckAt: Date.now() };
    } catch (err) {
      const errorClass = classifyRecoveryError(err);
      this.healthSnapshot = {
        health: { state: 'unavailable', reason: healthReasonFor(errorClass) },
        checkedAt: Date.now(),
        lastDeepCheckAt: Date.now(),
      };
    }
  }

  private async computeCheapHealth(): Promise<LocalVolumeProtectionHealth> {
    const configured = resolveHelperImageRef();
    if (configured.kind === 'unpinned') return { state: 'unavailable', reason: 'helper_unavailable' };
    const image: HelperImageState = await inspectHelperImage(this.docker(), configured);
    if (image.state !== 'present') return { state: 'unavailable', reason: 'helper_unavailable' };
    const repository = this.repositories.getActive();
    if (!repository) return { state: 'unavailable', reason: 'repository_not_initialized' };
    if (repository.secretState !== 'stored') return { state: 'unavailable', reason: 'repository_key_unavailable' };
    try {
      this.repositories.readSecret(repository.id);
    } catch {
      // A key that no longer decrypts (the instance key was replaced) is a
      // missing key, and it is the one thing that makes every point unreadable.
      return { state: 'unavailable', reason: 'repository_key_unavailable' };
    }
    if (!repository.repositoryFingerprint) return { state: 'unavailable', reason: 'repository_not_initialized' };
    const present = await this.volumeExists(repository.locator);
    if (!present) return { state: 'unavailable', reason: 'repository_unavailable' };
    return { state: 'available' };
  }

  private async volumeExists(name: string): Promise<boolean> {
    try {
      await this.docker().getVolume(name).inspect();
      return true;
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return false;
      throw err;
    }
  }

  // --- Boot -----------------------------------------------------------------

  /**
   * Settle what a previous process left, in this order, and only then open the
   * gate. Nothing here can race this process's own work, because the gate is
   * closed until the sequence finishes.
   */
  async runBootSequence(): Promise<void> {
    this.boot = { ready: false, startedAt: Date.now(), finishedAt: null, reason: 'engine_starting' };
    try {
      this.operations.reconcileAtStartup();
      await this.registerOwnInfrastructure();
      if (resolveHelperImageRef().kind === 'pinned') {
        const runner = this.helperRunner();
        const removed = await runner.removeForeignEpochHelpers();
        if (removed > 0) console.log('[Recovery] Removed %d helper containers from a previous process', removed);
        const unlocked = await this.unlockAfterRestart();
        // With the previous helpers gone and restic's own locks cleared, an
        // interrupted capture, check or restore leaves nothing in the repository
        // to review, and an interrupted provisioning is continued by the next
        // provision request, so none of their repository locks may keep every
        // volume closed until an administrator releases it. A helper that could
        // not be removed may still be writing, so nothing is released while one
        // remains.
        const remaining = await runner.countForeignEpochHelpers();
        if (remaining === 0) {
          const active = this.repositories.getActive();
          const released = this.operations.releaseInterruptedRepositoryLocks(unlocked && active ? active.id : null);
          if (released > 0) console.log('[Recovery] Released %d repository locks left by interrupted work', released);
        }
        if (this.operations.hasStaleRepositoryLock()) {
          console.warn(
            '[Recovery] Repository locks left by interrupted work stay held: restic locks cleared=%s, previous helpers remaining=%d',
            String(unlocked), remaining,
          );
        }
      }
      const intents = await reconcileRestoreIntentsAtStartup(this.docker());
      if (intents.rolledBack > 0 || intents.unknown > 0) {
        console.log(
          '[Recovery] Restore intents reconciled: %d rolled back, %d unknown',
          intents.rolledBack, intents.unknown,
        );
      }
      await this.refreshHealth();
    } catch (err) {
      // Boot problems never stop Sencho; they keep recovery closed, which is the
      // truthful state, and the descriptor names why.
      console.error('[Recovery] Boot sequence failed:', errorMessageForLog(err));
      this.boot = { ready: false, startedAt: this.boot.startedAt, finishedAt: Date.now(), reason: 'engine_starting' };
      return;
    }
    this.boot = { ready: true, startedAt: this.boot.startedAt, finishedAt: Date.now(), reason: null };
  }

  /**
   * Tell `SelfIdentityService` which volumes and images are Sencho's own.
   *
   * One registration covers every existing guard: the prune plan, the managed
   * sweep, the itemized removal, the system prune, the fleet prune and the
   * remove-volume route all ask the same two predicates. The repository volume
   * holds every point this node has taken, and the helper is the only program
   * that can read them, so neither may be pruned as unused.
   */
  private async registerOwnInfrastructure(): Promise<void> {
    const self = SelfIdentityService.getInstance();
    try {
      await self.initialize();
    } catch (err) {
      console.warn('[Recovery] Could not settle self identity:', errorMessageForLog(err));
    }
    for (const repository of this.repositories.listForAuthority(getRecoveryAuthorityId())) {
      self.registerRecoveryVolume(repository.locator);
    }
    const configured = resolveHelperImageRef();
    if (configured.kind === 'pinned') {
      try {
        const inspected = await this.docker().getImage(configured.ref).inspect() as { Id?: string };
        if (inspected.Id) self.registerRecoveryImage(inspected.Id);
      } catch {
        // The image is not pulled yet; provisioning registers it after the pull.
      }
    }
  }

  /**
   * Clear restic's own locks left by a dead process, under no Sencho operation.
   * Answers whether they are known to be cleared.
   */
  private async unlockAfterRestart(): Promise<boolean> {
    const repository = this.repositories.getActive();
    if (!repository) return false;
    try {
      const secret = this.repositories.readSecret(repository.id);
      return await unlockRepository({
        runner: this.helperRunner(),
        repositoryVolume: repository.locator,
        secret,
        operationId: randomUUID(),
      });
    } catch (err) {
      // A repository whose key is unavailable cannot be unlocked, and that is
      // already reported as `repository_key_unavailable`.
      console.warn('[Recovery] Could not clear restic locks at boot:', errorMessageForLog(err));
      return false;
    }
  }

  // --- Admission ------------------------------------------------------------

  /**
   * Create a root point. Everything before the first byte happens here so the
   * errors are synchronous.
   */
  async admitCreatePoint(input: {
    nodeId: number;
    volumeName: string;
    actor: string;
    idempotencyKey: string;
    requestDigest: string;
    transport: RecoveryOperation['transport'];
    authorize: (context: { storageKey: string | null; dependents: readonly StorageDependent[] }) => boolean;
  }): Promise<AdmissionResult> {
    this.requireReady();
    const repository = this.requireActiveRepository();
    const docker = this.docker();
    const ownerNodeKey = await ownerNodeKeyFor(this.nodeId, docker);
    const knownStackNames = await knownStacksFor(this.nodeId);

    const described = await describeVolumeLocator({
      docker,
      ownerNodeKey,
      volumeName: input.volumeName,
    });
    if (!described.eligible) throw new RecoveryError('invalid_request');
    const resolution = await resolveVolumeDependents({
      nodeId: this.nodeId,
      ownerNodeKey,
      knownStackNames,
      volumeName: input.volumeName,
      volumeLabels: described.labels,
      render: true,
      docker,
    });
    // A stack whose model cannot be rendered may own this volume, so the check
    // becomes a global one rather than a narrower set.
    const storageKeyForCheck = resolution.kind === 'unrenderable' ? null : described.storageKey;
    if (!input.authorize({ storageKey: storageKeyForCheck, dependents: resolution.dependents })) {
      throw new RecoveryError('permission_denied');
    }

    const generationToken = await probeGenerationToken({
      runner: this.helperRunner(),
      operationId: randomUUID(),
      volumeName: input.volumeName,
      createdAt: described.createdAt,
    });

    const observed = StorageIdentityStore.getInstance().observe({
      ownerNodeKey,
      kind: 'named_volume',
      locator: input.volumeName,
      generationToken,
      dependents: resolution.dependents,
    });

    // One step: the operation, both locks and the pending point exist together or
    // not at all, so a `409` leaves nothing behind and the same key can be retried.
    const started = this.operations.admit(
      {
        idempotencyKey: input.idempotencyKey,
        kind: 'create_point',
        storageId: observed.id,
        actor: input.actor,
        transport: input.transport,
        requestDigest: input.requestDigest,
      },
      [
        { scope: 'storage', resourceKey: observed.storageKey },
        { scope: 'repository', resourceKey: repository.id },
      ],
      (operation) => this.points.begin({
        kind: 'root',
        storageId: observed.id,
        expectedGenerationToken: generationToken,
        repositoryId: repository.id,
        trigger: 'manual',
        actor: input.actor,
        sourceOperationId: operation.id,
        sourceNodeKey: ownerNodeKey,
        engineId: RESTIC_ENGINE_ID,
      }),
    );
    if (started.replayed || !started.setup) return { operation: started.operation, replayed: true };

    const operationId = started.operation.id;
    const point = started.setup;
    this.schedule(operationId, () => this.runCreatePoint(operationId, point.id, observed.id, repository));
    return { operation: this.operations.get(operationId) ?? started.operation, replayed: false };
  }

  /** Verify a point. The check itself is repository-wide evidence. */
  async admitVerify(input: {
    nodeId: number;
    pointId: string;
    actor: string;
    idempotencyKey: string;
    requestDigest: string;
    transport: RecoveryOperation['transport'];
    method: IntegrityMethod;
    /** A null `storageKey` means the dependent set is unknown: check globally. */
    authorize: (context: { storageKey: string | null; dependents: readonly StorageDependent[] }) => boolean;
  }): Promise<AdmissionResult> {
    this.requireReady();
    const point = this.points.get(input.pointId);
    if (!point) throw new RecoveryError('invalid_request');
    if (point.status !== 'succeeded' && point.status !== 'partial') throw new RecoveryError('invalid_request');
    const storage = StorageIdentityStore.getInstance().getById(point.storageId);
    if (!storage) throw new RecoveryError('identity_unknown');
    const repository = this.repositories.get(point.repositoryId);
    if (!repository) throw new RecoveryError('repository_unavailable');

    const ownerNodeKey = await ownerNodeKeyFor(this.nodeId, this.docker());
    const knownStackNames = await knownStacksFor(this.nodeId);
    // The volume may be gone by now (that is when a point is needed), so the
    // stored locator is described, not required.
    const described = await describeStoredLocator({
      docker: this.docker(),
      ownerNodeKey,
      locator: storage.locator,
    });
    const resolution = await resolveVolumeDependents({
      nodeId: this.nodeId,
      ownerNodeKey,
      knownStackNames,
      volumeName: storage.locator,
      volumeLabels: described.labels,
      render: true,
      docker: this.docker(),
    });
    // An unrenderable model makes the full dependent set unknown; the check then
    // has to be global, which the caller does for a null storage key.
    const storageKeyForCheck = resolution.kind === 'unrenderable' ? null : storage.storageKey;
    if (!input.authorize({ storageKey: storageKeyForCheck, dependents: resolution.dependents })) {
      throw new RecoveryError('permission_denied');
    }

    const started = this.operations.admit(
      {
        idempotencyKey: input.idempotencyKey,
        kind: 'verify_point',
        storageId: storage.id,
        pointId: point.id,
        actor: input.actor,
        transport: input.transport,
        requestDigest: input.requestDigest,
      },
      [{ scope: 'repository', resourceKey: repository.id }],
    );
    if (started.replayed) return { operation: started.operation, replayed: true };

    const operationId = started.operation.id;
    this.schedule(operationId, () => this.runVerify(operationId, point.id, repository, input.method));
    return { operation: this.operations.get(operationId) ?? started.operation, replayed: false };
  }

  /** Restore one point into a volume Sencho creates for it. */
  async admitRestore(input: {
    nodeId: number;
    pointId: string;
    targetVolumeName: string;
    actor: string;
    idempotencyKey: string;
    requestDigest: string;
    transport: RecoveryOperation['transport'];
    /** A null `storageKey` means the dependent set is unknown: check globally. */
    authorize: (context: { storageKey: string | null; dependents: readonly StorageDependent[] }) => boolean;
    authorizeCrossStack: (stackName: string) => boolean;
  }): Promise<AdmissionResult> {
    this.requireReady();
    const point = this.points.get(input.pointId);
    if (!point) throw new RecoveryError('invalid_request');
    if (point.status !== 'succeeded' && point.status !== 'partial') throw new RecoveryError('invalid_request');
    if (!point.snapshotId) throw new RecoveryError('invalid_request');
    const storage = StorageIdentityStore.getInstance().getById(point.storageId);
    if (!storage) throw new RecoveryError('identity_unknown');
    const repository = this.repositories.get(point.repositoryId);
    if (!repository) throw new RecoveryError('repository_unavailable');
    const active = this.repositories.getActive();
    if (!active || active.id !== repository.id) {
      throw new RecoveryError('repository_unavailable', {
        reason: 'repository_replaced',
        detail: 'This point is in a recovery repository that has been replaced, and it can no longer be restored here.',
      });
    }

    const ownerNodeKey = await ownerNodeKeyFor(this.nodeId, this.docker());
    const knownStackNames = await knownStacksFor(this.nodeId);
    const described = await describeStoredLocator({
      docker: this.docker(),
      ownerNodeKey,
      locator: storage.locator,
    });
    const resolution = await resolveVolumeDependents({
      nodeId: this.nodeId,
      ownerNodeKey,
      knownStackNames,
      volumeName: storage.locator,
      volumeLabels: described.labels,
      render: true,
      docker: this.docker(),
    });
    const storageKeyForCheck = resolution.kind === 'unrenderable' ? null : storage.storageKey;
    if (!input.authorize({ storageKey: storageKeyForCheck, dependents: resolution.dependents })) {
      throw new RecoveryError('permission_denied');
    }

    // A target named `<project>_...` for a known stack's Compose project would
    // plant data under a name that stack's own volumes use, so it needs the same
    // access that changing that stack does. The project name can differ from the
    // stack directory (a `name:` key, or a case difference), and Compose names its
    // volumes after the project, so both spellings have to be checked.
    const projectToStack = await DockerController.resolveProjectNameMap(knownStackNames);
    const crossStackTargets = new Map<string, string>();
    for (const stackName of knownStackNames) crossStackTargets.set(stackName, stackName);
    for (const [projectName, stackName] of projectToStack) crossStackTargets.set(projectName, stackName);
    for (const [prefix, stackName] of crossStackTargets) {
      if (!input.targetVolumeName.startsWith(`${prefix}_`)) continue;
      if (!input.authorizeCrossStack(stackName)) throw new RecoveryError('permission_denied');
    }

    // The operation, the repository lock and the intent exist together or not at
    // all: a refused restore (a held lock, a second restore into the same target)
    // leaves no row, so the same key can be sent again.
    const started = this.operations.admit(
      {
        idempotencyKey: input.idempotencyKey,
        kind: 'restore',
        storageId: storage.id,
        pointId: point.id,
        actor: input.actor,
        transport: input.transport,
        requestDigest: input.requestDigest,
      },
      [{ scope: 'repository', resourceKey: repository.id }],
      (operation) => this.intents.record({
        operationId: operation.id,
        pointId: point.id,
        targetVolume: input.targetVolumeName,
        actor: input.actor,
        processEpoch: this.processEpoch,
      }),
    );
    if (started.replayed || !started.setup) return { operation: started.operation, replayed: true };

    const operationId = started.operation.id;
    const intent = started.setup;
    this.schedule(operationId, () => this.runRestore(operationId, intent.id, point.id, repository));
    return { operation: this.operations.get(operationId) ?? started.operation, replayed: false };
  }

  /** Provision, or replace, this node's repository. */
  async admitRepositoryInit(input: {
    actor: string;
    idempotencyKey: string;
    replace: boolean;
    transport: RecoveryOperation['transport'];
  }): Promise<AdmissionResult> {
    this.requireReady();
    // A provision request that is not a replacement resumes the repository this
    // node already has. Allocating a new generation here would move the active
    // pointer and strand every existing point, which is the opposite of what an
    // operator repeating a request means.
    const existing = this.repositories.listForAuthority(getRecoveryAuthorityId());
    const active = this.repositories.getActive();
    const highestGeneration = existing.reduce(
      (highest, repository) => Math.max(highest, generationOfLocator(repository.locator) ?? 1),
      0,
    );
    const generation = input.replace ? highestGeneration + 1 : Math.max(1, highestGeneration);
    const started = this.operations.start({
      idempotencyKey: input.idempotencyKey,
      kind: 'repository_init',
      actor: input.actor,
      transport: input.transport,
      requestDigest: sha256Digest(['repository_init', input.replace ? 'replace' : 'provision']),
    });
    if (started.replayed) return { operation: started.operation, replayed: true };
    const operationId = started.operation.id;
    this.operations.markRunning(operationId);
    if (!input.replace && active && active.repositoryFingerprint) {
      // Already provisioned and working: a repeated request confirms it and
      // changes nothing, including the password that opens the existing points.
      this.operations.finish(operationId, { state: 'succeeded' });
      return { operation: this.operations.get(operationId) ?? started.operation, replayed: false };
    }
    this.schedule(operationId, () => this.runRepositoryInit(operationId, input.replace, generation));
    return { operation: this.operations.get(operationId) ?? started.operation, replayed: false };
  }

  // --- Cancellation and progress -------------------------------------------

  /** Ask a running operation to stop. Answers false when nothing is running. */
  cancel(operationId: string): boolean {
    const running = this.work.get(operationId);
    if (!running) return false;
    running.controller.abort();
    return true;
  }

  progressFor(operationId: string): RecoveryProgress | null {
    return this.work.get(operationId)?.progress ?? null;
  }

  // --- Background work -----------------------------------------------------

  private schedule(operationId: string, work: () => Promise<void>): void {
    const controller = new AbortController();
    this.work.set(operationId, { controller, progress: null });
    const pending = work()
      .catch((err: unknown) => {
        // Every path settles its own operation; this is the last resort for a bug.
        console.error('[Recovery] Operation %s failed unexpectedly:', operationId, errorMessageForLog(err));
        this.settleFailed(operationId, classifyRecoveryError(err));
      })
      .finally(() => {
        this.work.delete(operationId);
        this.pending.delete(operationId);
      });
    this.pending.set(operationId, pending);
  }

  /** Test seam: wait for every background operation started here to settle. */
  async whenIdleForTests(): Promise<void> {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending.values()]);
    }
  }

  private settleFailed(operationId: string, errorClass: RecoveryErrorClass): void {
    try {
      const operation = this.operations.get(operationId);
      if (!operation) return;
      this.operations.finish(operationId, { state: 'failed', errorClass });
    } catch (err) {
      console.error('[Recovery] Could not settle operation %s:', operationId, errorMessageForLog(err));
    }
  }

  private onProgress(operationId: string, progress: RecoveryProgress): void {
    const running = this.work.get(operationId);
    if (running) running.progress = progress;
  }

  private engineContext(
    operationId: string,
    pointId: string | null,
    signal: AbortSignal,
    repository: RepositoryDescriptor,
  ): EngineExecutionContext {
    const lock = this.operations.getLock('repository', repository.id);
    if (!lock) throw new RecoveryError('lock_stale');
    return {
      operationId,
      pointId,
      lock,
      signal,
      onProgress: (progress) => this.onProgress(operationId, progress),
    };
  }

  private async runCreatePoint(
    operationId: string,
    pointId: string,
    storageId: string,
    repository: RepositoryDescriptor,
  ): Promise<void> {
    const signal = this.work.get(operationId)?.controller.signal ?? new AbortController().signal;
    const storage = StorageIdentityStore.getInstance().getById(storageId);
    const point = this.points.get(pointId);
    if (!storage || !point) {
      this.settleFailed(operationId, 'identity_unknown');
      return;
    }
    this.onProgress(operationId, {
      operationId, phase: 'preparing', filesDone: 0, bytesDone: 0, bytesTotal: null,
    });

    const engine = this.buildEngine(repository, operationId, signal);
    let result;
    try {
      result = await engine.createPoint(
        { storage, repository, trigger: 'manual', actor: point.actor, kind: 'root' },
        this.engineContext(operationId, pointId, signal, repository),
      );
    } catch (err) {
      await this.afterAbnormalExit(operationId, repository, pointId, classifyRecoveryError(err));
      return;
    }

    if (!result.ok) {
      if (result.errorClass === 'interrupted') {
        // Cancel: the point is settled failed first, then the operation.
        this.points.finalize(pointId, { status: 'failed', errorClass: 'interrupted' });
        this.operations.finish(operationId, { state: 'cancelled' });
        await this.refreshHealthDeep(operationId);
        return;
      }
      await this.afterAbnormalExit(operationId, repository, pointId, result.errorClass);
      return;
    }

    const finalized = this.points.finalize(pointId, { status: 'succeeded', evidence: result.evidence });
    const outcome: OperationFinish = finalized.status === 'partial'
      ? { state: 'partial', errorClass: 'source_unreadable' }
      : { state: 'succeeded' };

    // Repository-wide verification, before the operation ends: a missing pack must
    // stop every point in this repository from reading Protected.
    await this.verifyRepository(operationId, repository, 'engine_check_metadata');
    this.operations.finish(operationId, outcome);
    await this.refreshHealthDeep(operationId);
  }

  /**
   * A capture that did not finish normally. Clear restic's own locks while
   * Sencho still holds the repository lock, settle the point, then the operation.
   */
  private async afterAbnormalExit(
    operationId: string,
    repository: RepositoryDescriptor,
    pointId: string,
    errorClass: RecoveryErrorClass,
  ): Promise<void> {
    await this.clearResticLocks(operationId, repository);
    try {
      this.points.finalize(pointId, { status: 'failed', errorClass });
    } catch (err) {
      console.warn('[Recovery] Could not finalize point %s:', pointId, errorMessageForLog(err));
    }
    this.operations.finish(operationId, { state: 'failed', errorClass });
    await this.refreshHealthDeep(operationId);
  }

  private async runVerify(
    operationId: string,
    pointId: string,
    repository: RepositoryDescriptor,
    method: IntegrityMethod,
  ): Promise<void> {
    const signal = this.work.get(operationId)?.controller.signal ?? new AbortController().signal;
    const point = this.points.get(pointId);
    if (!point || (point.status !== 'succeeded' && point.status !== 'partial')) {
      this.settleFailed(operationId, 'invalid_request');
      return;
    }
    const engine = this.buildEngine(repository, operationId, signal);
    let result;
    try {
      result = await engine.verifyPoint(point, method, this.engineContext(operationId, pointId, signal, repository));
    } catch (err) {
      result = { ok: false as const, errorClass: classifyRecoveryError(err) };
    }
    if (!result.ok) {
      if (result.errorClass === 'interrupted') {
        this.operations.finish(operationId, { state: 'cancelled' });
        return;
      }
      recordRepositoryCheck(repository.id, method, 'error', operationId);
      this.operations.finish(operationId, { state: 'failed', errorClass: result.errorClass });
      await this.refreshHealthDeep(operationId);
      return;
    }
    recordRepositoryCheck(repository.id, method, result.evidence.result, operationId);
    // A check that found damage ran fine and answered "not intact": ending that
    // `succeeded` would read as a pass in every client that only looks at the
    // operation state. The repository-wide record above is what coverage reads.
    this.operations.finish(
      operationId,
      result.evidence.result === 'mismatch'
        ? { state: 'failed', errorClass: 'integrity_mismatch' }
        : { state: 'succeeded' },
    );
    await this.refreshHealthDeep(operationId);
  }

  private async runRestore(
    operationId: string,
    intentId: string,
    pointId: string,
    repository: RepositoryDescriptor,
  ): Promise<void> {
    const signal = this.work.get(operationId)?.controller.signal ?? new AbortController().signal;
    const intentRecord = this.intents.get(intentId);
    const point = this.points.get(pointId);
    if (!intentRecord || !intentRecord.targetVolume || !point || !point.snapshotId) {
      this.settleFailed(operationId, 'invalid_request');
      return;
    }
    const targetVolume = intentRecord.targetVolume;

    // Prove the volume before a byte moves. Docker's create returns an existing
    // volume silently, so the label and the creation time are the proof that this
    // is the volume this intent made.
    let created: { labels: Record<string, string>; createdAt: string | null };
    try {
      created = await this.createRestoreTarget(targetVolume, intentId);
      const createdMs = created.createdAt ? Date.parse(created.createdAt) : NaN;
      if (created.labels[HELPER_LABEL_RESTORE_INTENT] !== intentId) throw new RecoveryError('invalid_request');
      if (Number.isFinite(createdMs) && createdMs + 1000 < intentRecord.createdAt) {
        throw new RecoveryError('invalid_request');
      }
    } catch (err) {
      this.intents.advance(intentId, 'rolled_back');
      this.operations.finish(operationId, { state: 'failed', errorClass: classifyRecoveryError(err) });
      return;
    }

    this.intents.advance(intentId, 'staging');
    this.onProgress(operationId, {
      operationId, phase: 'transferring', filesDone: 0, bytesDone: 0, bytesTotal: null,
    });

    const engine = this.buildEngine(repository, operationId, signal);
    let result;
    try {
      result = await engine.restore(
        {
          id: intentId,
          operationId,
          pointId,
          repositoryId: repository.id,
          snapshotId: point.snapshotId,
          target: { mode: 'new_volume', volumeName: targetVolume },
          pathScope: null,
          phase: 'staging',
          actor: intentRecord.actor,
          createdAt: intentRecord.createdAt,
        },
        this.engineContext(operationId, pointId, signal, repository),
      );
    } catch (err) {
      result = { ok: false as const, errorClass: classifyRecoveryError(err) };
    }

    if (!result.ok) {
      const settled = await this.rollbackTarget(intentId, targetVolume);
      this.operations.finish(
        operationId,
        result.errorClass === 'interrupted'
          ? { state: 'cancelled' }
          : { state: 'failed', errorClass: result.errorClass },
      );
      if (!settled) {
        console.error('[Recovery] Restore target %s could not be removed after a failed restore', sanitizeForLog(targetVolume));
      }
      return;
    }

    const partial = result.evidence.verified === false;
    this.intents.advance(intentId, 'staged_verified', {
      filesRestored: result.evidence.filesRestored,
      bytesRestored: result.evidence.bytesRestored,
      verified: result.evidence.verified,
      xattrWarnings: result.evidence.xattrWarnings ?? 0,
    });
    this.intents.advance(intentId, 'committed');
    this.operations.finish(
      operationId,
      partial
        ? { state: 'partial', errorClass: 'attributes_not_restored' }
        : { state: 'succeeded' },
    );
    await this.refreshHealthDeep(operationId);
  }

  private async createRestoreTarget(
    volumeName: string,
    intentId: string,
  ): Promise<{ labels: Record<string, string>; createdAt: string | null }> {
    const docker = this.docker();
    try {
      await docker.createVolume({
        Name: volumeName,
        Driver: 'local',
        Labels: { [HELPER_LABEL_RESTORE_INTENT]: intentId },
      });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status !== 409) {
        console.error('[Recovery] Restore target could not be created:', errorMessageForLog(err));
        // Only a refusal (a socket proxy forbidding volume creation) is a missing
        // capability. A name the daemon rejects is the caller's, and anything
        // else is the node failing.
        if (status === 400) throw new RecoveryError('invalid_request');
        throw new RecoveryError(status === 403 || status === 404 ? 'capability_unavailable' : 'node_error');
      }
    }
    const inspected = await docker.getVolume(volumeName).inspect() as {
      Labels?: Record<string, string> | null;
      CreatedAt?: string;
    };
    return {
      labels: inspected.Labels ?? {},
      createdAt: typeof inspected.CreatedAt === 'string' ? inspected.CreatedAt : null,
    };
  }

  /**
   * Remove a target this intent created, and only that: it must still carry this
   * intent's label and no container may be using it.
   */
  private async rollbackTarget(intentId: string, volumeName: string): Promise<boolean> {
    const docker = this.docker();
    try {
      const inspected = await docker.getVolume(volumeName).inspect() as { Labels?: Record<string, string> | null };
      if ((inspected.Labels ?? {})[HELPER_LABEL_RESTORE_INTENT] !== intentId) {
        this.intents.advance(intentId, 'completion_unknown');
        return false;
      }
      const inUse = await observeVolumeInUse(docker, volumeName);
      if (inUse.inUse) {
        this.intents.advance(intentId, 'completion_unknown');
        return false;
      }
      await docker.getVolume(volumeName).remove({ force: false });
      this.intents.advance(intentId, 'rolled_back');
      return true;
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) {
        this.intents.advance(intentId, 'rolled_back');
        return true;
      }
      console.warn('[Recovery] Could not remove restore target %s:', sanitizeForLog(volumeName), errorMessageForLog(err));
      this.intents.advance(intentId, 'completion_unknown');
      return false;
    }
  }

  private async runRepositoryInit(operationId: string, replace: boolean, generation: number): Promise<void> {
    const docker = this.docker();
    const ownerNodeKey = await ownerNodeKeyFor(this.nodeId, docker);
    const configured = resolveHelperImageRef();
    if (configured.kind === 'unpinned') {
      this.settleFailed(operationId, 'capability_unavailable');
      return;
    }
    try {
      // A pull happens only here: provisioning is the one place a download is
      // expected, so a status read never starts one.
      const image = await inspectHelperImage(docker, configured);
      if (image.state !== 'present') {
        const { pullHelperImage } = await import('./restic/helperImage');
        await pullHelperImage(docker, configured.ref);
      }
    } catch (err) {
      console.error('[Recovery] Helper image pull failed:', errorMessageForLog(err));
      this.settleFailed(operationId, 'capability_unavailable');
      return;
    }

    try {
      await this.provisioner.provision(
        {
          nodeId: this.nodeId,
          docker,
          authorityId: getRecoveryAuthorityId(),
          ownerNodeKey,
          runner: this.helperRunner(),
          operationId,
          // The repository lock is taken as soon as the row exists, so no other
          // repository work can start against a half-provisioned volume.
          acquireLock: (repositoryId) => {
            this.operations.acquireLock('repository', repositoryId, operationId);
          },
          onEvent: (event) => {
            console.log('[Recovery] Repository provisioning: %s', event);
          },
        },
        { replace, generation },
      );
      await this.registerOwnInfrastructure();
      await this.refreshHealthDeep(operationId);
      this.operations.finish(operationId, { state: 'succeeded' });
    } catch (err) {
      const errorClass = classifyRecoveryError(err);
      console.error('[Recovery] Repository provisioning failed:', errorMessageForLog(err));
      await this.refreshHealthDeep(operationId);
      this.operations.finish(operationId, { state: 'failed', errorClass });
    }
  }

  // --- Helpers --------------------------------------------------------------

  private async clearResticLocks(operationId: string, repository: RepositoryDescriptor): Promise<void> {
    try {
      const secret = this.repositories.readSecret(repository.id);
      await unlockRepository({
        runner: this.helperRunner(),
        repositoryVolume: repository.locator,
        secret,
        operationId,
      });
    } catch (err) {
      console.warn('[Recovery] Could not clear restic locks after an abnormal exit:', errorMessageForLog(err));
    }
  }

  private async verifyRepository(
    operationId: string,
    repository: RepositoryDescriptor,
    method: IntegrityMethod,
  ): Promise<void> {
    try {
      const secret = this.repositories.readSecret(repository.id);
      const outcome = await checkRepository(
        { runner: this.helperRunner(), repositoryVolume: repository.locator, secret, operationId },
        method,
      );
      recordRepositoryCheck(
        repository.id,
        method,
        outcome.result === 'verified' ? 'verified' : outcome.result === 'mismatch' ? 'mismatch' : 'error',
        operationId,
      );
    } catch (err) {
      console.warn('[Recovery] Repository check could not run:', errorMessageForLog(err));
      recordRepositoryCheck(repository.id, method, 'error', operationId);
    }
  }

  private buildEngine(repository: RepositoryDescriptor, operationId: string, signal: AbortSignal): BackupEngine {
    if (RecoveryEngineService.engineFactory) {
      return RecoveryEngineService.engineFactory({ repository, operationId, signal });
    }
    const secret = this.repositories.readSecret(repository.id);
    const docker = this.docker();
    return new ResticEngine({
      runner: this.helperRunner(),
      secret,
      helperImageRef: this.helperImageRef(),
      inspectHelperImage: async () => {
        const configured = resolveHelperImageRef();
        const state = await inspectHelperImage(docker, configured);
        return { state: state.state === 'present' ? 'present' : 'missing' };
      },
      parentSnapshot: (storage, repositoryId) => {
        const candidates = this.points
          .listForStorage(storage.id)
          .filter((p) => p.repositoryId === repositoryId
            && (p.status === 'succeeded' || p.status === 'partial')
            && typeof p.snapshotId === 'string'
            && p.snapshotId !== '');
        return candidates.length > 0 ? candidates[0].snapshotId : null;
      },
      readGenerationToken: async (volumeName) => {
        const ownerNodeKey = await ownerNodeKeyFor(this.nodeId, docker);
        const described = await describeVolumeLocator({ docker, ownerNodeKey, volumeName });
        return probeGenerationToken({
          runner: this.helperRunner(),
          operationId,
          volumeName,
          createdAt: described.createdAt,
        });
      },
      observeInUse: (volumeName) => observeVolumeInUse(docker, volumeName),
      repositoryFor: (repositoryId) => {
        const descriptor = this.repositories.get(repositoryId);
        return descriptor ? { id: descriptor.id, locator: descriptor.locator } : null;
      },
      runCheck: async (repositoryVolume, method, ctx) => {
        const secret = this.repositories.readSecret(repository.id);
        const outcome = await checkRepository(
          { runner: this.helperRunner(), repositoryVolume, secret, operationId: ctx.operationId, signal: ctx.signal },
          method,
        );
        return outcome;
      },
    });
  }

  private helperRunner(): RecoveryHelperRunner {
    if (this.runner) return this.runner;
    this.runner = new RecoveryHelperRunner({
      docker: this.docker(),
      authorityId: getRecoveryAuthorityId(),
      processEpoch: this.processEpoch,
      imageRef: this.helperImageRef(),
    });
    return this.runner;
  }

  private helperImageRef(): string {
    const configured = resolveHelperImageRef();
    if (configured.kind !== 'pinned') throw new RecoveryError('capability_unavailable');
    return configured.ref;
  }

  private docker(): Docker {
    return DockerController.getInstance(this.nodeId).getDocker();
  }

  private requireReady(): void {
    if (!this.boot.ready) throw new RecoveryError('capability_unavailable', { reason: 'engine_starting' });
  }

  private requireActiveRepository(): RepositoryDescriptor {
    const repository = this.repositories.getActive();
    if (!repository) {
      throw new RecoveryError('capability_unavailable', {
        reason: 'repository_not_initialized',
        detail: 'This node has no recovery repository yet. Provision one before taking a point.',
      });
    }
    return repository;
  }
}

/** The capability reason a repository failure maps to. */
function healthReasonFor(errorClass: RecoveryErrorClass): Extract<LocalVolumeProtectionHealth, { state: 'unavailable' }>['reason'] {
  switch (errorClass) {
    case 'repository_key_unavailable':
      return 'repository_key_unavailable';
    case 'capability_unavailable':
    case 'node_error':
      return 'helper_unavailable';
    case 'identity_unknown':
    case 'repository_unavailable':
      return 'repository_unavailable';
    default:
      return 'repository_unavailable';
  }
}

/** A stable digest of a canonical request, so a replayed key cannot answer a different one. */
export function sha256Digest(parts: readonly string[]): string {
  // Kept local to this module so no caller can invent its own canonical form.
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
