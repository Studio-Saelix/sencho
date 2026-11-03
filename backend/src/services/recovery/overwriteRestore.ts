import { createHash } from 'crypto';
import type Docker from 'dockerode';
import { errorMessageForLog, sanitizeForLog } from '../../utils/safeLog';
import { classifyRecoveryError, RecoveryError } from './redaction';
import {
  RECOVERY_STAGING_TARGET_PREFIX,
  RestoreIntentStore,
  type RestoreIntentRecord,
} from './restoreIntents';
import {
  applyRestoreFence,
  fenceIdentityFor,
  releaseRestoreFence,
  RestoreFenceStore,
  type FenceMember,
  type FenceMemberInput,
  type RestartPolicy,
} from './restoreFence';
import { createLabelledVolume, removeLabelledVolume } from './restoreTargets';
import { HELPER_LABEL_RESTORE_INTENT } from './restic/helperRunner';
import { RESTIC_ENGINE_ID } from './restic/ResticEngine';
import { StorageIdentityStore } from './storageIdentity';
import {
  describeIneligible,
  generationTokenMatchesVolume,
  inspectVolumeSource,
  probeGenerationToken,
  probeVolumeReport,
  resolveVolumeDependents,
} from './volumeSources';
import { runSwapStep, swapIncomingDir, type SwapStatus } from './volumeSwap';
import type { RecoveryHelperRunner } from './restic/helperRunner';
import type { RecoveryPointStore } from './recoveryPoints';
import type { RecoveryRepositoryStore } from './repositories';
import type {
  BackupEngine,
  EngineExecutionContext,
  OperationFinish,
  RecoveryErrorClass,
  RecoveryPoint,
  RecoveryProgress,
  RepositoryDescriptor,
  StorageIdentity,
} from './types';

/**
 * Restore over the existing volume.
 *
 * This is the only destructive recovery path, so it is one durable operation
 * with a fence and a journal rather than a sequence of best-effort calls:
 *
 *   1. the point is proven in a separate staging volume, with no workload
 *      touched;
 *   2. every container that mounts the target is recorded and fenced, with its
 *      restart policy pinned to `no` so a daemon restart cannot resurrect it on
 *      half-swapped data;
 *   3. a pre-restore root point is taken with the workloads stopped, and must be
 *      complete;
 *   4. the point is restored inside the target's own filesystem, in a hidden
 *      work directory;
 *   5. the swap renames entries through a journal, and the originals are deleted
 *      before any workload restarts;
 *   6. the fence is released, restoring every recorded restart policy and
 *      starting only the containers that were running.
 *
 * Every step before `swapped` can be rolled back. From `swapped` on the data is
 * committed, and a cleanup that fails leaves the workloads stopped until an
 * operator resolves it. Nothing here claims the swap is atomic: each rename is,
 * the set is not, and the preview says so.
 */

const SWAP_WARNINGS: readonly string[] = [
  'The containers that use this volume stop while the restore runs. They start again afterwards if they were running before.',
  'The restored data is crash consistent, not application consistent. A database may need to recover, replay or check its files on the next start.',
  'Your Compose files and environment files are not changed. Only the contents of the volume change.',
  'The recovery repository is on this host, in a Docker volume. Losing this host loses both the data and the points that protect it.',
  'Restoring to a new volume is the safer option: it never touches the running data. Use this overwrite only when the data has to stay on this volume.',
  'The swap is a series of renames, not one atomic step. Sencho stops the workloads and journals every step so a crash can be recovered, but the volume is briefly in an intermediate state.',
  'A container started outside Sencho after the fence is not stopped by it. The swap re-checks just before it starts and refuses if one is running.',
];

/** Phases in which the live volume has not been touched. */
const PRE_FENCE_PHASES = ['recorded', 'staging', 'staged_verified'];
/** Phases whose fence is applied or may have been applied. */
const FENCED_PHASES = ['fenced', 'protecting', 'materializing'];

export interface OverwriteContainerFact {
  id: string;
  name: string;
  stack: string | null;
  project: string | null;
  running: boolean;
  restartPolicy: RestartPolicy;
}

export interface OverwritePreview {
  point: {
    id: string;
    completedAt: number | null;
    consistency: string;
    capture: { fileCount: number; byteCount: number; skippedCount: number } | null;
    latestVerification: string | null;
    generation: number;
    isCurrentGeneration: boolean;
  };
  node: { id: number; name: string; transport: string };
  target: {
    volumeName: string;
    storageKey: string;
    generation: number;
    generationToken: string;
    eligible: boolean;
    ineligibleReason: string | null;
  };
  dependents: { stacks: string[]; containers: OverwriteContainerFact[] };
  inUse: boolean;
  swap: { method: 'fenced_rename'; atomic: false; supported: boolean; reason: string | null };
  space: { requiredBytes: number; freeBytes: number | null; sufficient: boolean | null };
  preRestorePoint: { required: true; consistency: 'crash_consistent_stopped' };
  warnings: string[];
  confirmation: { token: string };
}

/**
 * What every preview, admission and reconciliation needs from the node. The
 * runner is a getter so a test can substitute one without the engine having
 * started a container.
 */
export interface OverwriteDeps {
  nodeId: number;
  nodeName: string;
  transport: string;
  docker: Docker;
  runner: () => RecoveryHelperRunner;
  points: RecoveryPointStore;
  repositories: RecoveryRepositoryStore;
  intents: RestoreIntentStore;
  fence: RestoreFenceStore;
  ownerNodeKey: string;
  knownStackNames: string[];
  actor: string;
  authorizeStack: (stackName: string) => boolean;
  /** The node-wide check, for a mounting container no stack owns. */
  authorizeGlobal: () => boolean;
}

type FulfilledPoint = Extract<RecoveryPoint, { status: 'succeeded' | 'partial' }>;

interface TargetObservation {
  storage: StorageIdentity;
  point: FulfilledPoint;
  repository: RepositoryDescriptor;
  volumeName: string;
  eligible: boolean;
  ineligibleReason: string | null;
  generationToken: string;
  isCurrentGeneration: boolean;
  containers: OverwriteContainerFact[];
  stacks: string[];
  /** Free bytes on the volume's filesystem, or null when the probe could not say. */
  freeBytes: number | null;
}

function requirePoint(deps: OverwriteDeps, pointId: string): TargetObservation["point"] {
  const point = deps.points.get(pointId);
  if (!point) throw new RecoveryError('invalid_request');
  if (point.status !== 'succeeded' && point.status !== 'partial') throw new RecoveryError('invalid_request');
  if (!point.snapshotId) throw new RecoveryError('invalid_request');
  return point as FulfilledPoint;
}

function requireStorage(deps: OverwriteDeps, point: FulfilledPoint): StorageIdentity {
  const storage = StorageIdentityStore.getInstance().getById(point.storageId);
  if (!storage) throw new RecoveryError('identity_unknown');
  if (storage.state !== 'current') throw new RecoveryError('identity_unknown');
  return storage;
}

function requireRepository(deps: OverwriteDeps, point: FulfilledPoint): RepositoryDescriptor {
  const repository = deps.repositories.get(point.repositoryId);
  if (!repository) throw new RecoveryError('repository_unavailable');
  if (deps.repositories.getActive()?.id !== repository.id) {
    throw new RecoveryError('repository_unavailable', {
      reason: 'repository_replaced',
      detail: 'This point is in a recovery repository that has been replaced, and it can no longer be restored here.',
    });
  }
  return repository;
}

function containerName(container: { Names?: string[] }): string {
  const first = Array.isArray(container.Names) ? container.Names[0] : undefined;
  return typeof first === 'string' ? first.replace(/^\//, '') : '';
}

async function projectToStackMap(knownStackNames: readonly string[]): Promise<Map<string, string>> {
  // Imported lazily: DockerController imports the recovery fence, and this
  // module is loaded by the engine that imports the controller.
  const { default: DockerController } = await import('../DockerController');
  return DockerController.resolveProjectNameMap([...knownStackNames]);
}

async function inspectContainer(
  deps: OverwriteDeps,
  containerId: string,
): Promise<{ name: string; running: boolean; restartPolicy: RestartPolicy } | null> {
  try {
    const inspected = await deps.docker.getContainer(containerId).inspect() as {
      Name?: string;
      State?: { Running?: boolean };
      HostConfig?: { RestartPolicy?: RestartPolicy };
    };
    return {
      name: typeof inspected.Name === 'string' ? inspected.Name.replace(/^\//, '') : '',
      running: inspected.State?.Running === true,
      restartPolicy: inspected.HostConfig?.RestartPolicy ?? { Name: 'no' },
    };
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw err;
  }
}

/** Every container that mounts the volume, with the facts the preview shows. */
async function listMountingContainers(deps: OverwriteDeps, volumeName: string): Promise<OverwriteContainerFact[]> {
  const listed = await deps.docker.listContainers({ all: true }) as Array<{
    Id: string;
    Names?: string[];
    State?: string;
    Labels?: Record<string, string>;
    Mounts?: Array<{ Type?: string; Name?: string }>;
  }>;
  const projectToStack = await projectToStackMap(deps.knownStackNames);
  const facts: OverwriteContainerFact[] = [];
  for (const container of listed) {
    if (!(container.Mounts ?? []).some((m) => m.Type === 'volume' && m.Name === volumeName)) continue;
    const inspect = await inspectContainer(deps, container.Id);
    if (!inspect) continue;
    const identity = fenceIdentityFor(container, projectToStack, deps.knownStackNames);
    facts.push({
      id: container.Id,
      name: containerName(container) || inspect.name,
      stack: identity.stackName,
      project: identity.projectName,
      running: inspect.running,
      restartPolicy: inspect.restartPolicy,
    });
  }
  return facts;
}

/**
 * The Docker-endpoint guard's answer for one mounting container, or null when
 * the container is ordinary. Stopping the container that carries the Docker API
 * would take Sencho offline in the middle of its own restore, so any refusal is
 * a refusal of the target.
 *
 * `unresolved` is not the same fact as `sencho`: the guard could not identify
 * Sencho's own container at all, so it cannot prove this volume is not the one
 * Sencho runs on. The refusal stands either way; the sentence differs, because
 * the operator's next step does.
 */
async function dockerEndpointRefusal(
  deps: OverwriteDeps,
  containerId: string,
): Promise<{ unresolved: boolean } | null> {
  const { evaluateDockerEndpointContainer } = await import('../../helpers/dockerEndpointGuard');
  try {
    const refusal = await evaluateDockerEndpointContainer(containerId, 'stop', deps.docker);
    if (!refusal) return null;
    return { unresolved: refusal.reason === 'unresolved' };
  } catch {
    // A guard that cannot answer must not become a "yes": eligibility and the
    // fence still protect the volume.
    return null;
  }
}

/**
 * The facts behind a preview and an admission. Authorization is part of it,
 * because the facts name dependent stacks and containers, and the same call
 * decides both surfaces so they cannot disagree.
 */
async function observeTarget(deps: OverwriteDeps, pointId: string): Promise<TargetObservation> {
  const point = requirePoint(deps, pointId);
  const storage = requireStorage(deps, point);
  const repository = requireRepository(deps, point);
  const source = await inspectVolumeSource(deps.docker, storage.locator);
  const resolution = await resolveVolumeDependents({
    nodeId: deps.nodeId,
    ownerNodeKey: deps.ownerNodeKey,
    knownStackNames: deps.knownStackNames,
    volumeName: storage.locator,
    volumeLabels: source?.labels ?? {},
    render: true,
    docker: deps.docker,
  });
  const containers = await listMountingContainers(deps, storage.locator);
  const stacks = new Set<string>();
  for (const dependent of resolution.dependents) stacks.add(dependent.stackName);
  for (const container of containers) if (container.stack) stacks.add(container.stack);
  // A model that cannot be rendered may own the volume, so the operator is held
  // to the node-wide check rather than a narrower set.
  if (resolution.kind === 'unrenderable') {
    if (!deps.authorizeGlobal()) throw new RecoveryError('permission_denied');
  }
  for (const stackName of stacks) {
    if (!deps.authorizeStack(stackName)) throw new RecoveryError('permission_denied');
  }
  if (containers.some((container) => container.stack === null) && !deps.authorizeGlobal()) {
    throw new RecoveryError('permission_denied');
  }
  // A volume no stack and no container names is a node-wide decision; without
  // this an unowned volume would be described to any caller.
  if (stacks.size === 0 && containers.length === 0 && !deps.authorizeGlobal()) {
    throw new RecoveryError('permission_denied');
  }

  let endpointRefusal: { unresolved: boolean } | null = null;
  for (const container of containers) {
    endpointRefusal = await dockerEndpointRefusal(deps, container.id);
    if (endpointRefusal) break;
  }

  let freeBytes: number | null = null;
  try {
    const report = await probeVolumeReport({
      runner: deps.runner(),
      operationId: `overwrite-preview-${point.id}`,
      volumeName: storage.locator,
    });
    freeBytes = report.free;
  } catch (err) {
    // The estimate is useful, not required: a probe that cannot run makes the
    // space answer unknown, and admission checks again only when it has a number.
    console.warn('[Recovery] Could not read free space for %s:', sanitizeForLog(storage.locator), errorMessageForLog(err));
  }

  return {
    storage,
    point,
    repository,
    volumeName: storage.locator,
    eligible: source?.eligible === true && endpointRefusal === null,
    ineligibleReason: endpointRefusal === null
      ? describeIneligible(source ? source.ineligibleReason : 'volume_missing')
      : endpointRefusal.unresolved
        ? 'Sencho cannot prove this volume is not the one it runs on, because it could not identify its own container. Check the Docker endpoint permissions, then try again.'
        : 'This volume is mounted by the container that runs the Docker endpoint, so overwriting it would take Sencho offline with it.',
    generationToken: storage.generationToken,
    isCurrentGeneration: generationTokenMatchesVolume(storage.generationToken, source?.createdAt ?? null),
    containers,
    stacks: [...stacks].sort(),
    freeBytes,
  };
}

/**
 * The confirmation is bound to the exact state the operator saw: the point, the
 * storage generation, the repository and the set of containers with the stack
 * each belongs to. A container that appears, a stack that changes, a volume
 * recreated or a repository replaced all change it.
 */
export function confirmationTokenFor(input: {
  pointId: string;
  storageKey: string;
  generationToken: string;
  repositoryId: string;
  containers: ReadonlyArray<{
    id: string;
    stack: string | null;
    running: boolean;
    restartPolicy: RestartPolicy;
  }>;
}): string {
  // Running state and restart policy are part of what the operator saw: a
  // container that stops or changes policy after the preview would otherwise
  // be admitted with a token that no longer describes what it promised to do.
  const canonical = [
    input.pointId,
    input.storageKey,
    input.generationToken,
    input.repositoryId,
    ...[...input.containers].map((container) => [
      container.id,
      container.stack ?? '',
      container.running ? 'running' : 'stopped',
      container.restartPolicy?.Name ?? '',
      container.restartPolicy?.MaximumRetryCount ?? 0,
    ].join(':')).sort(),
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** The staging volume name for an intent, derived before the row exists. */
export function stagingVolumeFor(intentId: string): string {
  return `${RECOVERY_STAGING_TARGET_PREFIX}${intentId}`;
}

/** Read-only facts for the confirmation screen. Writes no row. */
export async function previewOverwrite(deps: OverwriteDeps, pointId: string): Promise<OverwritePreview> {
  if (!deps.points.get(pointId) && !deps.authorizeGlobal()) throw new RecoveryError('permission_denied');
  const observed = await observeTarget(deps, pointId);
  const requiredBytes = observed.point.capture.byteCount;
  const sufficient = observed.freeBytes === null ? null : observed.freeBytes >= requiredBytes;
  const verifications = deps.points.listVerifications(observed.point.id);
  return {
    point: {
      id: observed.point.id,
      completedAt: observed.point.completedAt,
      consistency: observed.point.consistency,
      capture: observed.point.capture,
      latestVerification: verifications.length > 0 ? verifications[verifications.length - 1].result : null,
      generation: observed.storage.generation,
      isCurrentGeneration: observed.isCurrentGeneration,
    },
    node: { id: deps.nodeId, name: deps.nodeName, transport: deps.transport },
    target: {
      volumeName: observed.volumeName,
      storageKey: observed.storage.storageKey,
      generation: observed.storage.generation,
      generationToken: observed.generationToken,
      eligible: observed.eligible,
      ineligibleReason: observed.ineligibleReason,
    },
    dependents: { stacks: observed.stacks, containers: observed.containers },
    inUse: observed.containers.some((container) => container.running),
    swap: {
      method: 'fenced_rename',
      atomic: false,
      supported: observed.eligible,
      reason: observed.eligible ? null : observed.ineligibleReason,
    },
    space: { requiredBytes, freeBytes: observed.freeBytes, sufficient },
    preRestorePoint: { required: true, consistency: 'crash_consistent_stopped' },
    warnings: [...SWAP_WARNINGS],
    confirmation: {
      token: confirmationTokenFor({
        pointId: observed.point.id,
        storageKey: observed.storage.storageKey,
        generationToken: observed.generationToken,
        repositoryId: observed.repository.id,
        containers: observed.containers,
      }),
    },
  };
}

export interface AdmittedOverwrite {
  storage: StorageIdentity;
  point: FulfilledPoint;
  repository: RepositoryDescriptor;
  /** The containers whose restart policies the fence will own. */
  fenceMembers: FenceMemberInput[];
  /** Every stack whose model declares the volume, with or without containers. */
  stacks: string[];
  storageKey: string;
  liveGenerationToken: string;
}

/**
 * Everything an admission must prove before it records anything. It is the
 * preview's own observation plus the live generation probe, so a state that
 * moved between the two is refused with `precondition_failed` and writes no
 * row.
 */
export async function prepareOverwriteAdmission(deps: OverwriteDeps, input: {
  pointId: string;
  confirmationToken: string;
  confirmVolumeName: string;
}): Promise<AdmittedOverwrite> {
  if (!deps.points.get(input.pointId) && !deps.authorizeGlobal()) throw new RecoveryError('permission_denied');
  const observed = await observeTarget(deps, input.pointId);
  if (!observed.eligible) throw new RecoveryError('invalid_request', { detail: observed.ineligibleReason ?? undefined });
  if (input.confirmVolumeName !== observed.volumeName) throw new RecoveryError('invalid_request');

  const liveGenerationToken = await probeGenerationToken({
    runner: deps.runner(),
    operationId: `overwrite-admission-${observed.point.id}`,
    volumeName: observed.volumeName,
    createdAt: (await inspectVolumeSource(deps.docker, observed.volumeName))?.createdAt ?? null,
  });
  if (liveGenerationToken !== observed.generationToken) {
    throw new RecoveryError('precondition_failed', {
      reason: 'generation_changed',
      detail: 'This volume was recreated since the preview. Ask for a new preview and confirm again.',
    });
  }
  const expected = confirmationTokenFor({
    pointId: observed.point.id,
    storageKey: observed.storage.storageKey,
    generationToken: observed.generationToken,
    repositoryId: observed.repository.id,
    containers: observed.containers,
  });
  if (expected !== input.confirmationToken) {
    throw new RecoveryError('precondition_failed', {
      reason: 'dependents_changed',
      detail: 'A container or stack using this volume changed since the preview. Ask for a new preview and confirm again.',
    });
  }

  if (observed.freeBytes !== null && observed.freeBytes < observed.point.capture.byteCount) {
    throw new RecoveryError('insufficient_space');
  }
  if (deps.fence.liveIntentForVolume(observed.volumeName)) {
    throw new RecoveryError('lock_held', { detail: 'Another restore is already running on this volume.' });
  }

  return {
    storage: observed.storage,
    point: observed.point,
    repository: observed.repository,
    stacks: observed.stacks,
    fenceMembers: observed.containers.map((container) => ({
      containerId: container.id,
      containerName: container.name,
      stackName: container.stack,
      projectName: container.project,
      restartPolicy: container.restartPolicy,
      wasRunning: container.running,
    })),
    storageKey: observed.storage.storageKey,
    liveGenerationToken,
  };
}

// --- The pipeline -----------------------------------------------------------

export interface OverwriteRunContext {
  deps: OverwriteDeps;
  operationId: string;
  intentId: string;
  repository: RepositoryDescriptor;
  engine: BackupEngine;
  context: EngineExecutionContext;
  finish: (outcome: OperationFinish) => void;
  onProgress: (progress: RecoveryProgress) => void;
}

interface PipelineState {
  intent: RestoreIntentRecord;
  storage: StorageIdentity;
  members: FenceMember[];
  workDir: string;
}

/**
 * Run one staged overwrite. Every exit path settles the intent, the fence and
 * the operation exactly once; a thrown error is the last resort and leaves the
 * intent where it is for reconciliation, which is the truthful state.
 */
export async function runOverwritePipeline(ctx: OverwriteRunContext): Promise<void> {
  const deps = ctx.deps;
  const intent = deps.intents.get(ctx.intentId);
  if (!intent || intent.targetMode !== 'staged_overwrite' || !intent.targetVolume) {
    ctx.finish({ state: 'failed', errorClass: 'invalid_request' });
    return;
  }
  const point = deps.points.get(intent.pointId);
  const storage = point ? StorageIdentityStore.getInstance().getById(point.storageId) : null;
  if (!storage) {
    ctx.finish({ state: 'failed', errorClass: 'identity_unknown' });
    return;
  }
  const state: PipelineState = {
    intent,
    storage,
    members: deps.fence.listMembers(intent.id),
    workDir: swapIncomingDir(intent.id),
  };

  if (!await stagePoint(ctx, state)) return;
  if (!await removeStaging(ctx, state)) return;
  if (!await fenceWorkloads(ctx, state)) return;
  if (!await takePreRestorePoint(ctx, state)) return;
  if (!await materializePoint(ctx, state)) return;
  await swapAndCleanup(ctx, state);
}

/**
 * Stage and verify the point in the separate volume. A wrong key, a missing or
 * corrupt pack, a full disk and unverified metadata all fail here, with the live
 * volume untouched and no container stopped.
 */
async function stagePoint(ctx: OverwriteRunContext, state: PipelineState): Promise<boolean> {
  const deps = ctx.deps;
  const stagingVolume = state.intent.stagingVolume;
  if (!stagingVolume) {
    await settleRollback(ctx, state, 'internal');
    return false;
  }
  deps.intents.advance(state.intent.id, 'staging');
  let created;
  try {
    created = await createLabelledVolume(deps.docker, stagingVolume, state.intent.id);
  } catch (err) {
    deps.intents.advance(state.intent.id, 'rolled_back', { outcomeClass: classifyRecoveryError(err) });
    releaseHolds(deps, state.intent.id);
    ctx.finish({ state: 'failed', errorClass: classifyRecoveryError(err) });
    return false;
  }
  if (created.labels[HELPER_LABEL_RESTORE_INTENT] !== state.intent.id) {
    await settleRollback(ctx, state, 'identity_unknown');
    return false;
  }
  const point = deps.points.get(state.intent.pointId);
  if (!point || !point.snapshotId) {
    await settleRollback(ctx, state, 'invalid_request');
    return false;
  }
  ctx.onProgress({ operationId: ctx.operationId, phase: 'transferring', filesDone: 0, bytesDone: 0, bytesTotal: null });
  let result;
  try {
    result = await ctx.engine.restore(
      {
        id: state.intent.id,
        operationId: ctx.operationId,
        pointId: point.id,
        repositoryId: ctx.repository.id,
        snapshotId: point.snapshotId,
        target: { mode: 'new_volume', volumeName: stagingVolume },
        pathScope: null,
        phase: 'staging',
        actor: state.intent.actor,
        createdAt: state.intent.createdAt,
      },
      ctx.context,
    );
  } catch (err) {
    result = { ok: false as const, errorClass: classifyRecoveryError(err) };
  }
  if (!result.ok) {
    await removeLabelledVolume(deps.docker, stagingVolume, state.intent.id);
    deps.intents.advance(state.intent.id, 'rolled_back', { outcomeClass: result.errorClass });
    releaseHolds(deps, state.intent.id);
    ctx.finish(
      result.errorClass === 'interrupted'
        ? { state: 'cancelled' }
        : { state: 'failed', errorClass: result.errorClass },
    );
    return false;
  }
  if (result.evidence.verified === false) {
    await removeLabelledVolume(deps.docker, stagingVolume, state.intent.id);
    deps.intents.advance(state.intent.id, 'rolled_back', { outcomeClass: 'attributes_not_restored' });
    releaseHolds(deps, state.intent.id);
    ctx.finish({ state: 'failed', errorClass: 'attributes_not_restored' });
    return false;
  }
  deps.intents.advance(state.intent.id, 'staged_verified', {
    filesRestored: result.evidence.filesRestored,
    bytesRestored: result.evidence.bytesRestored,
    verified: true,
    xattrWarnings: result.evidence.xattrWarnings ?? 0,
  });
  return true;
}

/** The staging volume proved the point; remove it before the workloads stop. */
async function removeStaging(ctx: OverwriteRunContext, state: PipelineState): Promise<boolean> {
  const deps = ctx.deps;
  const stagingVolume = state.intent.stagingVolume;
  if (!stagingVolume) return true;
  const removed = await removeLabelledVolume(deps.docker, stagingVolume, state.intent.id);
  if (removed === 'removed' || removed === 'missing') return true;
  if (removed === 'in_use' || removed === 'not_ours') {
    // The staging volume is not provably disposable, so Sencho keeps the intent
    // and the holds rather than guessing. No workload was touched.
    deps.intents.advance(state.intent.id, 'completion_unknown', { outcomeClass: 'lock_held' });
    ctx.finish({ state: 'completion_unknown' });
    return false;
  }
  // It is still ours and unused, and reconciliation from `staged_verified`
  // removes it, so the operation ends and nothing live moved.
  deps.intents.advance(state.intent.id, 'rolled_back', { outcomeClass: 'node_error' });
  releaseHolds(deps, state.intent.id);
  ctx.finish({ state: 'failed', errorClass: 'node_error' });
  return false;
}

/**
 * Record the fence (already recorded at admission, refreshed here) and apply it.
 * A container set that changed since admission aborts before any policy change.
 */
async function fenceWorkloads(ctx: OverwriteRunContext, state: PipelineState): Promise<boolean> {
  const deps = ctx.deps;
  const dependency = await recheckDependents(ctx, state, { requireStopped: false });
  if (dependency !== 'ok') {
    await settleRollback(ctx, state, dependency === 'changed' ? 'dependents_changed' : 'identity_unknown');
    return false;
  }
  const current = await listMountingContainers(deps, state.intent.targetVolume ?? '');
  const recorded = new Set(state.members.map((member) => member.containerId));
  if (current.length !== state.members.length || current.some((container) => !recorded.has(container.id))) {
    await settleRollback(ctx, state, 'dependents_changed');
    return false;
  }
  // Refresh the recorded facts: a container may have restarted since admission.
  deps.fence.recordMembers(state.intent.id, current.map((container) => ({
    containerId: container.id,
    containerName: container.name,
    stackName: container.stack,
    projectName: container.project,
    restartPolicy: container.restartPolicy,
    wasRunning: container.running,
  })));
  state.members = deps.fence.listMembers(state.intent.id);
  deps.intents.advance(state.intent.id, 'fenced');
  // From here the workloads are being stopped, so the fence is live: every
  // Sencho path that could start or browse one is refused from this record.
  deps.fence.setFenceState(state.intent.id, 'held');
  try {
    await applyRestoreFence(state.intent.id, deps.docker, state.members);
  } catch (err) {
    await settleRollback(ctx, state, classifyRecoveryError(err));
    return false;
  }
  deps.intents.advance(state.intent.id, 'protecting');
  return true;
}

/** A complete root point of the target's current generation, taken stopped. */
async function takePreRestorePoint(ctx: OverwriteRunContext, state: PipelineState): Promise<boolean> {
  const deps = ctx.deps;
  const point = deps.points.begin({
    kind: 'root',
    storageId: state.storage.id,
    expectedGenerationToken: state.intent.expectedGenerationToken ?? state.storage.generationToken,
    repositoryId: ctx.repository.id,
    trigger: 'pre_restore',
    actor: state.intent.actor,
    sourceOperationId: ctx.operationId,
    sourceNodeKey: deps.ownerNodeKey,
    engineId: RESTIC_ENGINE_ID,
  });
  deps.points.addHold({ pointId: point.id, holderKind: 'restore_intent', holderRef: state.intent.id });
  // Still `protecting`: the point id is evidence for this phase, not a move.
  deps.intents.update(state.intent.id, { preRestorePointId: point.id });

  let result;
  try {
    result = await ctx.engine.createPoint(
      { storage: state.storage, repository: ctx.repository, trigger: 'pre_restore', actor: state.intent.actor, kind: 'root' },
      { ...ctx.context, pointId: point.id },
    );
  } catch (err) {
    result = { ok: false as const, errorClass: classifyRecoveryError(err) };
  }
  if (!result.ok) {
    settleFailedPoint(deps, point.id, result.errorClass);
    await settleRollback(ctx, state, 'pre_restore_failed');
    return false;
  }
  const finalized = deps.points.finalize(point.id, { status: 'succeeded', evidence: result.evidence });
  if (finalized.status !== 'succeeded' || result.evidence.capture.skippedCount > 0) {
    await settleRollback(ctx, state, 'pre_restore_failed');
    return false;
  }
  return true;
}

function settleFailedPoint(deps: OverwriteDeps, pointId: string, errorClass: RecoveryErrorClass): void {
  try {
    deps.points.finalize(pointId, { status: 'failed', errorClass });
  } catch (err) {
    console.warn('[Recovery] Could not settle the pre-restore point:', errorMessageForLog(err));
  }
}

/** Restore the point inside the target's own work directory. */
async function materializePoint(ctx: OverwriteRunContext, state: PipelineState): Promise<boolean> {
  const deps = ctx.deps;
  deps.intents.advance(state.intent.id, 'materializing');
  const point = deps.points.get(state.intent.pointId);
  if (!point || !point.snapshotId || !state.intent.targetVolume) {
    await settleRollback(ctx, state, 'invalid_request');
    return false;
  }
  let result;
  try {
    result = await ctx.engine.restore(
      {
        id: state.intent.id,
        operationId: ctx.operationId,
        pointId: point.id,
        repositoryId: ctx.repository.id,
        snapshotId: point.snapshotId,
        target: {
          mode: 'staged_overwrite',
          storageId: state.storage.id,
          expectedGenerationToken: state.intent.expectedGenerationToken ?? state.storage.generationToken,
          workDir: state.workDir,
          volumeName: state.intent.targetVolume,
        },
        pathScope: null,
        phase: 'materializing',
        actor: state.intent.actor,
        createdAt: state.intent.createdAt,
      },
      ctx.context,
    );
  } catch (err) {
    result = { ok: false as const, errorClass: classifyRecoveryError(err) };
  }
  if (!result.ok) {
    await settleRollback(ctx, state, result.errorClass);
    return false;
  }
  if (result.evidence.verified === false) {
    await settleRollback(ctx, state, 'attributes_not_restored');
    return false;
  }
  deps.intents.update(state.intent.id, {
    filesRestored: result.evidence.filesRestored,
    bytesRestored: result.evidence.bytesRestored,
    verified: true,
    xattrWarnings: result.evidence.xattrWarnings ?? 0,
  });
  return true;
}

/** Prepare, re-check, commit, clean up and release. */
async function swapAndCleanup(ctx: OverwriteRunContext, state: PipelineState): Promise<boolean> {
  const deps = ctx.deps;
  const volumeName = state.intent.targetVolume ?? '';
  const prepared = await runSwapStep({
    runner: deps.runner(),
    operationId: ctx.operationId,
    volumeName,
    intentId: state.intent.id,
    action: 'prepare',
    signal: ctx.context.signal,
  });
  if (!prepared.ok || prepared.report?.status !== 'planned') {
    await settleRollback(ctx, state, prepared.errorClass === 'interrupted' ? 'interrupted' : 'node_error');
    return false;
  }
  deps.intents.advance(state.intent.id, 'swapping');

  const dependency = await recheckDependents(ctx, state, { requireStopped: true });
  if (dependency !== 'ok') {
    await settleRollback(ctx, state, dependency === 'changed' ? 'dependents_changed' : 'identity_unknown');
    return false;
  }

  const committed = await runSwapStep({
    runner: deps.runner(),
    operationId: ctx.operationId,
    volumeName,
    intentId: state.intent.id,
    action: 'commit',
    signal: ctx.context.signal,
  });
  let finalStatus = await readSwapStatus(ctx, volumeName, state.intent.id, committed.report?.status ?? null);
  if (finalStatus === 'metadata_pending') {
    // Every entry moved but the journal never recorded the commit, so the root
    // metadata is not proven. One more commit finishes it; it is idempotent.
    await runSwapStep({
      runner: deps.runner(),
      operationId: ctx.operationId,
      volumeName,
      intentId: state.intent.id,
      action: 'commit',
      signal: ctx.context.signal,
    });
    finalStatus = await readSwapStatus(ctx, volumeName, state.intent.id, null);
  }
  if (finalStatus !== 'swapped') {
    if (finalStatus === 'inconsistent') {
      deps.intents.advance(state.intent.id, 'completion_unknown', { outcomeClass: 'identity_unknown' });
      ctx.finish({ state: 'completion_unknown' });
      return false;
    }
    await settleRollback(ctx, state, committed.errorClass === 'interrupted' ? 'interrupted' : 'node_error');
    return false;
  }
  deps.intents.advance(state.intent.id, 'swapped');

  // The originals are deleted before any workload restarts: some engines treat
  // an unknown directory in their data root as data.
  const cleaned = await runSwapStep({
    runner: deps.runner(),
    operationId: ctx.operationId,
    volumeName,
    intentId: state.intent.id,
    action: 'cleanup',
    signal: ctx.context.signal,
  });
  if (!cleaned.ok) {
    deps.intents.update(state.intent.id, { outcomeClass: 'cleanup_failed' });
    ctx.finish({ state: 'partial', errorClass: 'cleanup_failed' });
    return false;
  }

  const released = await releaseAfterCommit(ctx, state);
  deps.intents.advance(state.intent.id, 'committed', { outcomeClass: null });
  releaseHolds(deps, state.intent.id);
  ctx.finish(released ? { state: 'succeeded' } : { state: 'partial', errorClass: 'fence_unavailable' });
  return released;
}

async function readSwapStatus(
  ctx: OverwriteRunContext,
  volumeName: string,
  intentId: string,
  fallback: SwapStatus | null,
): Promise<SwapStatus> {
  const status = await runSwapStep({
    runner: ctx.deps.runner(),
    operationId: ctx.operationId,
    volumeName,
    intentId,
    action: 'status',
  });
  return status.report?.status ?? fallback ?? 'inconsistent';
}

async function releaseAfterCommit(ctx: OverwriteRunContext, state: PipelineState): Promise<boolean> {
  const members = ctx.deps.fence.listMembers(state.intent.id);
  try {
    await releaseRestoreFence(state.intent.id, ctx.deps.docker, members, { restart: true });
    return true;
  } catch (err) {
    console.warn(
      '[Recovery] The fence on %s could not be released:',
      sanitizeForLog(state.intent.targetVolume ?? ''),
      errorMessageForLog(err),
    );
    return false;
  }
}

/**
 * Roll a pre-commit intent back: undo the journal, remove the staging volume,
 * release the fence, then settle the intent and the operation. The workloads are
 * restarted only when the volume is proven to hold the original entries.
 */
async function settleRollback(
  ctx: OverwriteRunContext,
  state: PipelineState,
  errorClass: RecoveryErrorClass,
): Promise<void> {
  const outcome = await rollbackIntent(ctx.deps, state.intent.id);
  if (outcome === 'unknown') {
    ctx.finish({ state: 'completion_unknown' });
    return;
  }
  ctx.finish(errorClass === 'interrupted' ? { state: 'cancelled' } : { state: 'failed', errorClass });
}

/**
 * Keep the intent where the journal left it, and record why. Called from the
 * live pipeline and from `retry`, so it is idempotent: re-running it on an
 * intent that is already `completion_unknown` only refreshes the class.
 */
function markUnknown(
  deps: OverwriteDeps,
  intent: RestoreIntentRecord,
  outcomeClass: RecoveryErrorClass,
  now = Date.now(),
): void {
  if (intent.phase === 'completion_unknown') {
    deps.intents.update(intent.id, { outcomeClass }, now);
    return;
  }
  deps.intents.advance(intent.id, 'completion_unknown', { outcomeClass }, now);
}

type RollbackOutcome = 'rolled_back' | 'unknown';

/** Shared by the live pipeline, reconciliation and the resolve retry. */
export async function rollbackIntent(deps: OverwriteDeps, intentId: string): Promise<RollbackOutcome> {
  const intent = deps.intents.get(intentId);
  if (!intent || !intent.targetVolume) return 'unknown';
  // Only these phases can have a work directory or a journal to undo. Before
  // materializing nothing was written into the live volume at all.
  const swapMayHaveRun = intent.phase === 'materializing'
    || intent.phase === 'swapping'
    || intent.phase === 'swapped';
  if (swapMayHaveRun) {
    const swap = await runSwapStep({
      runner: deps.runner(),
      operationId: `overwrite-rollback-${intentId}`,
      volumeName: intent.targetVolume,
      intentId,
      action: 'rollback',
    });
    if (!swap.ok) {
      deps.intents.advance(intentId, 'completion_unknown', { outcomeClass: 'identity_unknown' });
      return 'unknown';
    }
  }
  if (intent.stagingVolume) {
    await removeLabelledVolume(deps.docker, intent.stagingVolume, intentId);
  }
  const released = await releaseFence(deps, intentId, true);
  try {
    deps.intents.advance(intentId, 'rolled_back', { outcomeClass: null });
  } catch (err) {
    // A phase that already settled is not an error on a retry.
    console.warn('[Recovery] Restore intent %s could not settle rolled_back:', intentId, errorMessageForLog(err));
  }
  releaseHolds(deps, intentId);
  return released ? 'rolled_back' : 'unknown';
}

async function releaseFence(deps: OverwriteDeps, intentId: string, restart: boolean): Promise<boolean> {
  const intent = deps.intents.get(intentId);
  if (!intent) return false;
  if (intent.fenceState === 'none' || intent.fenceState === 'released') return true;
  const members = deps.fence.listMembers(intentId);
  if (members.length === 0) {
    // Nothing to restart, but the fence itself has to leave `held`, or every
    // later overwrite of this volume is refused by a fence no one owns.
    deps.intents.setFenceState(intentId, 'released');
    return true;
  }
  try {
    await releaseRestoreFence(intentId, deps.docker, members, { restart });
    return true;
  } catch (err) {
    console.warn('[Recovery] Could not release the restore fence on intent %s:', intentId, errorMessageForLog(err));
    return false;
  }
}

/**
 * Drop both holds an intent owns. The row is re-read rather than taken from the
 * caller's snapshot: the pre-restore point is recorded mid-pipeline, so a
 * snapshot taken at the start would leave its hold behind forever.
 */
function releaseHolds(deps: OverwriteDeps, intentId: string): void {
  try {
    const intent = deps.intents.get(intentId);
    if (!intent) return;
    deps.points.removeHold({ pointId: intent.pointId, holderKind: 'restore_intent', holderRef: intentId });
    if (intent.preRestorePointId) {
      deps.points.removeHold({ pointId: intent.preRestorePointId, holderKind: 'restore_intent', holderRef: intentId });
    }
  } catch (err) {
    console.warn('[Recovery] Could not release the restore holds on %s:', intentId, errorMessageForLog(err));
  }
}

/** Whether the dependents changed since the fence, and whether any is running. */
async function recheckDependents(
  ctx: OverwriteRunContext,
  state: PipelineState,
  options: { requireStopped: boolean },
): Promise<'ok' | 'changed' | 'unknown'> {
  const deps = ctx.deps;
  const volumeName = state.intent.targetVolume ?? '';
  const source = await inspectVolumeSource(deps.docker, volumeName);
  const resolution = await resolveVolumeDependents({
    nodeId: deps.nodeId,
    ownerNodeKey: deps.ownerNodeKey,
    knownStackNames: deps.knownStackNames,
    volumeName,
    volumeLabels: source?.labels ?? {},
    render: true,
    docker: deps.docker,
  });
  if (resolution.kind === 'unrenderable') return 'changed';
  const current = await listMountingContainers(deps, volumeName);
  const recorded = new Set(state.members.map((member) => member.containerId));
  if (current.length !== state.members.length) return 'changed';
  if (current.some((container) => !recorded.has(container.id))) return 'changed';
  if (options.requireStopped && current.some((container) => container.running)) return 'changed';
  const recordedStacks = new Set(
    state.members.map((member) => member.stackName).filter((name): name is string => name !== null),
  );
  for (const dependent of resolution.dependents) {
    if (!recordedStacks.has(dependent.stackName)) return 'changed';
  }
  try {
    const live = await probeGenerationToken({
      runner: deps.runner(),
      operationId: ctx.operationId,
      volumeName,
      createdAt: source?.createdAt ?? null,
    });
    if (live !== state.intent.expectedGenerationToken) return 'unknown';
  } catch {
    return 'unknown';
  }
  return 'ok';
}

// --- Reconciliation and resolve --------------------------------------------

export interface OverwriteReconciliation {
  rolledBack: number;
  committed: number;
  unknown: number;
}

/**
 * Settle every overwrite a previous process left open. The direction is decided
 * by the journal, never only by how far a phase name got: a `swapping` intent
 * whose journal says `swapped` is rolled forward.
 */
export async function reconcileOverwriteIntentsAtStartup(
  deps: OverwriteDeps,
  now = Date.now(),
): Promise<OverwriteReconciliation> {
  const result: OverwriteReconciliation = { rolledBack: 0, committed: 0, unknown: 0 };
  for (const intent of deps.intents.listUnsettled('staged_overwrite')) {
    const outcome = await reconcileOverwriteIntent(deps, intent, now);
    if (outcome === 'rolled_back') result.rolledBack += 1;
    else if (outcome === 'committed') result.committed += 1;
    else result.unknown += 1;
  }
  // A release that failed after the intent settled leaves a durable fence with
  // no unsettled row. It is still a fence: release it here, restarting what was
  // running, or the volume stays closed to every workload.
  for (const intent of deps.intents.listWithLiveFence('staged_overwrite')) {
    const released = await releaseFence(deps, intent.id, true);
    if (released) {
      deps.points.removeHold({ pointId: intent.pointId, holderKind: 'restore_intent', holderRef: intent.id });
      if (intent.preRestorePointId) {
        deps.points.removeHold({
          pointId: intent.preRestorePointId, holderKind: 'restore_intent', holderRef: intent.id,
        });
      }
    } else {
      result.unknown += 1;
    }
  }
  return result;
}

/** One intent. Idempotent: the resolve route re-runs exactly this. */
export async function reconcileOverwriteIntent(
  deps: OverwriteDeps,
  intent: RestoreIntentRecord,
  now = Date.now(),
): Promise<'rolled_back' | 'committed' | 'unknown'> {
  if (intent.targetMode !== 'staged_overwrite') return 'unknown';
  // Settled is settled: a retry answers the same ending and touches nothing.
  if (intent.phase === 'committed') return 'committed';
  if (intent.phase === 'rolled_back') return 'rolled_back';
  const volumeName = intent.targetVolume;
  if (!volumeName) {
    markUnknown(deps, intent, 'identity_unknown', now);
    return 'unknown';
  }

  if (PRE_FENCE_PHASES.includes(intent.phase)) {
    // Nothing in the live volume has moved. Remove the staging volume if it is
    // ours and unused, and leave the workloads exactly as they were. A fence that
    // was recorded but never applied is released here too, which is a no-op on
    // a container that was never stopped.
    if (intent.stagingVolume) await removeLabelledVolume(deps.docker, intent.stagingVolume, intent.id);
    if (!await releaseFence(deps, intent.id, true)) {
      markUnknown(deps, intent, 'fence_unavailable', now);
      return 'unknown';
    }
    deps.intents.advance(intent.id, 'rolled_back', { outcomeClass: null }, now);
    releaseHolds(deps, intent.id);
    return 'rolled_back';
  }

  if (FENCED_PHASES.includes(intent.phase)) {
    // The workloads are stopped and nothing was renamed yet.
    const rollback = await runSwapStep({
      runner: deps.runner(),
      operationId: `overwrite-reconcile-${intent.id}`,
      volumeName,
      intentId: intent.id,
      action: 'rollback',
    });
    if (!rollback.ok) {
      markUnknown(deps, intent, 'identity_unknown', now);
      return 'unknown';
    }
    if (intent.stagingVolume) await removeLabelledVolume(deps.docker, intent.stagingVolume, intent.id);
    const released = await releaseFence(deps, intent.id, true);
    if (!released) {
      markUnknown(deps, intent, 'fence_unavailable', now);
      return 'unknown';
    }
    deps.intents.advance(intent.id, 'rolled_back', { outcomeClass: null }, now);
    releaseHolds(deps, intent.id);
    return 'rolled_back';
  }

  // swapping, swapped: the journal decides.
  const status = await runSwapStep({
    runner: deps.runner(),
    operationId: `overwrite-reconcile-${intent.id}`,
    volumeName,
    intentId: intent.id,
    action: 'status',
  });
  const swapStatus = status.report?.status ?? null;
  if (swapStatus === null || swapStatus === 'inconsistent' || swapStatus === 'absent') {
    markUnknown(deps, intent, 'identity_unknown', now);
    return 'unknown';
  }
  if (swapStatus === 'swapped' || swapStatus === 'metadata_pending') {
    // Roll forward: apply the root metadata again (idempotent), delete the work
    // directory, then release the fence and restart what was running. A pending
    // commit is not a committed swap, but the entries have all moved, so forward
    // is the only direction that cannot lose them.
    // The commit is idempotent, so it finishes a `metadata_pending` journal by
    // applying the root metadata and writing the marker.
    const commit = await runSwapStep({
      runner: deps.runner(),
      operationId: `overwrite-reconcile-${intent.id}`,
      volumeName,
      intentId: intent.id,
      action: 'commit',
    });
    if (!commit.ok) {
      markUnknown(deps, intent, 'integrity_mismatch', now);
      return 'unknown';
    }
    if (intent.phase === 'swapping') deps.intents.advance(intent.id, 'swapped', {}, now);
    const cleaned = await runSwapStep({
      runner: deps.runner(),
      operationId: `overwrite-reconcile-${intent.id}`,
      volumeName,
      intentId: intent.id,
      action: 'cleanup',
    });
    if (!cleaned.ok) {
      deps.intents.update(intent.id, { outcomeClass: 'cleanup_failed' }, now);
      return 'unknown';
    }
    const released = await releaseFence(deps, intent.id, true);
    if (!released) {
      markUnknown(deps, intent, 'fence_unavailable', now);
      return 'unknown';
    }
    deps.intents.advance(intent.id, 'committed', { outcomeClass: null }, now);
    releaseHolds(deps, intent.id);
    return 'committed';
  }

  // The journal says the swap did not commit. Roll the originals back.
  const rollback = await runSwapStep({
    runner: deps.runner(),
    operationId: `overwrite-reconcile-${intent.id}`,
    volumeName,
    intentId: intent.id,
    action: 'rollback',
  });
  if (!rollback.ok) {
    markUnknown(deps, intent, 'identity_unknown', now);
    return 'unknown';
  }
  const released = await releaseFence(deps, intent.id, true);
  if (!released) {
    markUnknown(deps, intent, 'fence_unavailable', now);
    return 'unknown';
  }
  deps.intents.advance(intent.id, 'rolled_back', { outcomeClass: null }, now);
  releaseHolds(deps, intent.id);
  return 'rolled_back';
}

export type ResolveAction = 'retry' | 'release_fence';

/**
 * The operator's answer to an overwrite that did not settle.
 *
 * `retry` re-runs the reconciler, which is idempotent. `release_fence` is the
 * explicit acceptance of the volume as it now is: it restores the recorded
 * restart policies, starts nothing, and leaves the intent `completion_unknown`
 * unless the journal proves the data committed.
 */
export async function resolveOverwriteIntent(
  deps: OverwriteDeps,
  input: { intentId: string; action: ResolveAction },
): Promise<{ outcome: 'rolled_back' | 'committed' | 'unknown' | 'fence_released' }> {
  const intent = deps.intents.get(input.intentId);
  if (!intent || intent.targetMode !== 'staged_overwrite') throw new RecoveryError('invalid_request');
  if (input.action === 'retry') {
    if (intent.phase === 'committed' || intent.phase === 'rolled_back') {
      // The data is settled; the only thing a retry can still finish is a fence a
      // failed release left behind, and that never starts a workload on unproven
      // data by itself (the release restarts only what the record says ran).
      if (intent.fenceState === 'held' || intent.fenceState === 'release_failed') {
        const released = await releaseFence(deps, intent.id, true);
        if (!released) throw new RecoveryError('fence_unavailable');
      }
      return { outcome: intent.phase === 'committed' ? 'committed' : 'rolled_back' };
    }
    return { outcome: await reconcileOverwriteIntent(deps, intent) };
  }
  if (intent.phase === 'committed' || intent.phase === 'rolled_back') throw new RecoveryError('invalid_request');
  // Once the fence has been released, the workloads may be running again, so no
  // reconciliation step may move data under them.
  if (intent.fenceState === 'released') {
    throw new RecoveryError('invalid_request', {
      reason: 'fence_released',
      detail: 'The fence on this restore has been released, so it can no longer roll forward or back. Restore again from a point if you need different data.',
    });
  }
  const released = await releaseFence(deps, intent.id, false);
  if (!released) throw new RecoveryError('fence_unavailable');

  // Acceptance changes who runs the workloads, not what the data is. Only the
  // journal can prove the swap committed; anything else stays unknown.
  const status = intent.targetVolume
    ? (await runSwapStep({
        runner: deps.runner(),
        operationId: `overwrite-resolve-${intent.id}`,
        volumeName: intent.targetVolume,
        intentId: intent.id,
        action: 'status',
      })).report?.status ?? null
    : null;
  if (status === 'swapped' && intent.phase === 'swapped') {
    deps.intents.advance(intent.id, 'committed', { outcomeClass: null });
    releaseHolds(deps, intent.id);
    return { outcome: 'committed' };
  }
  if (intent.phase !== 'completion_unknown') {
    deps.intents.advance(intent.id, 'completion_unknown', { outcomeClass: intent.outcomeClass ?? null });
  } else {
    deps.intents.update(intent.id, { outcomeClass: intent.outcomeClass ?? undefined });
  }
  return { outcome: 'fence_released' };
}

/** The paths a preview or a support response may name, relative to the volume. */
export function workDirFor(intentId: string): string {
  return swapIncomingDir(intentId);
}
