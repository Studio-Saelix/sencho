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
  waitForStartsInFlight,
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
import { runSwapStep, swapIncomingDir, type SwapRunResult, type SwapStatus } from './volumeSwap';
import type { RecoveryHelperRunner } from './restic/helperRunner';
import type { RecoveryOperationStore } from './operations';
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
  /** The forwarding hub's id and name for this node, when a hub sent them; the preview names it. */
  hubNode?: { id: number; name: string };
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
    node: { id: deps.hubNode?.id ?? deps.nodeId, name: deps.hubNode?.name ?? deps.nodeName, transport: deps.transport },
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
      reason: 'confirmation_mismatch',
      // The token is a digest, so a mismatch cannot say which fact moved: it may
      // be a token from another preview, or the containers or the repository may
      // have changed since this one was issued (a recreated volume was refused
      // above, as `generation_changed`).
      detail: 'The confirmation token does not match this volume as it is now: it came from another preview, or something changed since the preview. Ask for a new preview and confirm again.',
    });
  }

  if (observed.freeBytes !== null && observed.freeBytes < observed.point.capture.byteCount) {
    throw new RecoveryError('insufficient_space');
  }
  if (deps.fence.liveIntentForVolume(observed.volumeName)) {
    throw new RecoveryError('lock_held', {
      detail: 'Another restore of this volume has not finished. Wait for it, or resolve it, then preview again.',
    });
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

/**
 * The rows an admission writes, in one place so the route and the tests can
 * reach the same shape: the intent, the source hold and the exact fence set.
 * Runs inside the operation's own transaction.
 */
export function recordOverwriteIntent(
  deps: OverwriteDeps,
  input: {
    intentId: string;
    operationId: string;
    pointId: string;
    targetVolume: string;
    actor: string;
    processEpoch: string;
    expectedGenerationToken: string;
    fenceMembers: readonly FenceMemberInput[];
    /** Every stack whose model declares the volume, with or without containers. */
    dependentStacks?: readonly string[];
  },
): RestoreIntentRecord {
  const intent = deps.intents.recordOverwrite({
    id: input.intentId,
    operationId: input.operationId,
    pointId: input.pointId,
    targetVolume: input.targetVolume,
    actor: input.actor,
    processEpoch: input.processEpoch,
    stagingVolume: stagingVolumeFor(input.intentId),
    expectedGenerationToken: input.expectedGenerationToken,
    dependentStacks: input.dependentStacks ? [...input.dependentStacks] : undefined,
  });
  deps.points.addHold({ pointId: input.pointId, holderKind: 'restore_intent', holderRef: intent.id });
  deps.fence.recordMembers(intent.id, input.fenceMembers);
  return intent;
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
export async function runOverwritePipeline(input: OverwriteRunContext): Promise<void> {
  // Every exit settles through `finish`, so this is where a run that ends in this
  // process says why it did not succeed (a restart's reconciliation logs its own
  // result). The API answers a class only and the helper container is gone by
  // then. The line is written first and must never stop the operation settling.
  let step = 'starting';
  const ctx: OverwriteRunContext = {
    ...input,
    finish: (outcome) => {
      try {
        logOverwriteOutcome(input.deps, input.intentId, step, outcome, input.context.signal);
      } catch (err) {
        console.warn('[Recovery] Could not log the end of overwrite %s:', sanitizeForLog(input.intentId), errorMessageForLog(err));
      }
      input.finish(outcome);
    },
  };
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

  step = 'staging the point';
  if (!await stagePoint(ctx, state)) return;
  step = 'removing the staging volume';
  if (!await removeStaging(ctx, state)) return;
  step = 'fencing the workloads';
  if (!await fenceWorkloads(ctx, state)) return;
  step = 'taking the pre-restore point';
  if (!await takePreRestorePoint(ctx, state)) return;
  step = 'copying the point into the volume';
  if (!await materializePoint(ctx, state)) return;
  step = 'swapping';
  await swapAndCleanup(ctx, state);
}

function logOverwriteOutcome(
  deps: OverwriteDeps,
  intentId: string,
  step: string,
  outcome: OperationFinish,
  signal: AbortSignal,
): void {
  if (outcome.state === 'succeeded') return;
  // A stop the operator asked for is not a failure. One nobody asked for (the
  // helper was signalled from outside) is worth a line.
  if (outcome.state === 'cancelled' && signal.aborted) return;
  const intent = deps.intents.get(intentId);
  console.warn(
    '[Recovery] Overwrite %s ended %s%s while %s (intent now %s, fence %s)',
    sanitizeForLog(intentId),
    outcome.state,
    'errorClass' in outcome ? ` with ${outcome.errorClass}` : '',
    step,
    intent?.phase ?? 'unknown',
    intent?.fenceState ?? 'unknown',
  );
}

/** An engine call that threw (a helper that could not start, say) keeps its cause in the log. */
function logEngineThrow(state: PipelineState, what: string, err: unknown): void {
  console.warn('[Recovery] %s for %s failed:', what, sanitizeForLog(state.intent.id), errorMessageForLog(err));
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
    console.warn('[Recovery] Could not create the staging volume for %s:', sanitizeForLog(state.intent.id), errorMessageForLog(err));
    // A create that failed after Docker made the volume (its answer was lost, or
    // the read-back failed) leaves a volume behind, so it is cleaned up like any
    // other staging failure.
    if (await stagingVolumeGone(deps, state.intent)) {
      deps.intents.advance(state.intent.id, 'rolled_back', { outcomeClass: classifyRecoveryError(err) });
      releaseHolds(deps, state.intent.id);
    } else {
      keepForCleanup(deps, state.intent.id);
    }
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
    logEngineThrow(state, 'Restoring the point into the staging volume', err);
    result = { ok: false as const, errorClass: classifyRecoveryError(err) };
  }
  if (!result.ok) {
    if (await stagingVolumeGone(deps, state.intent)) {
      deps.intents.advance(state.intent.id, 'rolled_back', { outcomeClass: result.errorClass });
      releaseHolds(deps, state.intent.id);
    } else {
      keepForCleanup(deps, state.intent.id);
    }
    ctx.finish(
      result.errorClass === 'interrupted'
        ? { state: 'cancelled' }
        : { state: 'failed', errorClass: result.errorClass },
    );
    return false;
  }
  if (result.evidence.verified === false) {
    if (await stagingVolumeGone(deps, state.intent)) {
      deps.intents.advance(state.intent.id, 'rolled_back', { outcomeClass: 'attributes_not_restored' });
      releaseHolds(deps, state.intent.id);
    } else {
      keepForCleanup(deps, state.intent.id);
    }
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
  if (await stagingVolumeGone(deps, state.intent)) return true;
  // The staging volume is a full copy of the point and is still on disk. The
  // intent stays in `staged_verified`, with its holds, so startup reconciliation
  // and a `retry` remove it later; settling now would make it unreachable. No
  // workload was touched.
  keepForCleanup(deps, state.intent.id);
  ctx.finish({ state: 'failed', errorClass: 'cleanup_failed' });
  return false;
}

/**
 * Remove the intent's staging volume and report whether it is gone. A volume
 * that carries another label is not Sencho's to remove and not Sencho's disk, so
 * it counts as gone; one that is in use or whose removal failed is still ours
 * and still holds a copy of the point, and its name is logged for the operator.
 */
async function stagingVolumeGone(
  deps: OverwriteDeps,
  intent: { id: string; stagingVolume: string | null },
): Promise<boolean> {
  if (!intent.stagingVolume) return true;
  const removed = await removeLabelledVolume(deps.docker, intent.stagingVolume, intent.id);
  if (removed === 'removed' || removed === 'missing') return true;
  if (removed === 'not_ours') {
    console.warn(
      '[Recovery] Left %s alone: it does not carry the label of restore %s.',
      sanitizeForLog(intent.stagingVolume),
      intent.id,
    );
    return true;
  }
  console.warn(
    '[Recovery] The staging volume %s of restore %s was not removed (%s). It stays until a retry removes it.',
    sanitizeForLog(intent.stagingVolume),
    intent.id,
    removed,
  );
  return false;
}

/**
 * Leave an intent in the non-terminal phase it is in, with its holds, because its
 * staging volume could not be removed. Such an intent is not terminal, so the
 * reconciler visits it again, and it keeps the target reserved until it settles.
 */
function keepForCleanup(deps: OverwriteDeps, intentId: string, now = Date.now()): void {
  deps.intents.update(intentId, { outcomeClass: 'cleanup_failed' }, now);
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
  deps.intents.advance(state.intent.id, 'fenced');
  // From here the workloads are being stopped, so the fence is live: every
  // Sencho path that could start or browse one is refused from this record.
  deps.fence.setFenceState(state.intent.id, 'held');
  // A start that passed its check before the fence was recorded is still on its
  // way; the observation below has to see its result, so it is waited for first.
  const drained = await waitForStartsInFlight();
  // Nothing has been stopped or re-pinned yet, so an abort from here puts the
  // fence back to `none`: a release would otherwise restore the admission-time
  // policies and start members an operator stopped since, or fail on a member
  // that no longer exists and leave the volume fenced for good.
  if (!drained) {
    console.warn('[Recovery] A container start is still unanswered; refusing the fence on %s.', state.intent.id);
    deps.fence.setFenceState(state.intent.id, 'none');
    await settleRollback(ctx, state, 'fence_unavailable');
    return false;
  }
  const current = await listMountingContainers(deps, state.intent.targetVolume ?? '');
  const recorded = new Set(state.members.map((member) => member.containerId));
  if (current.length !== state.members.length || current.some((container) => !recorded.has(container.id))) {
    deps.fence.setFenceState(state.intent.id, 'none');
    await settleRollback(ctx, state, 'dependents_changed');
    return false;
  }
  // Refresh the recorded facts: a container may have restarted since admission,
  // including one a start in flight just brought up.
  deps.fence.recordMembers(state.intent.id, current.map((container) => ({
    containerId: container.id,
    containerName: container.name,
    stackName: container.stack,
    projectName: container.project,
    restartPolicy: container.restartPolicy,
    wasRunning: container.running,
  })));
  state.members = deps.fence.listMembers(state.intent.id);
  try {
    await applyRestoreFence(state.intent.id, deps.docker, state.members);
  } catch (err) {
    console.warn('[Recovery] Could not fence the workloads for %s:', sanitizeForLog(state.intent.id), errorMessageForLog(err));
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
    logEngineThrow(state, 'Taking the pre-restore point', err);
    result = { ok: false as const, errorClass: classifyRecoveryError(err) };
  }
  if (!result.ok) {
    settleFailedPoint(deps, point.id, result.errorClass);
    // An operator's cancel aborts this capture. That is a stop, not a point that
    // came out incomplete, so it ends `cancelled` like a cancel at any other step.
    if (result.errorClass === 'interrupted') {
      await settleRollback(ctx, state, 'interrupted');
    } else {
      console.warn('[Recovery] The pre-restore point for %s failed with %s.', sanitizeForLog(state.intent.id), result.errorClass);
      await settleRollback(ctx, state, 'pre_restore_failed');
    }
    return false;
  }
  const finalized = deps.points.finalize(point.id, { status: 'succeeded', evidence: result.evidence });
  if (finalized.status !== 'succeeded' || result.evidence.capture.skippedCount > 0) {
    console.warn(
      '[Recovery] The pre-restore point for %s was not complete (status %s, %d skipped).',
      sanitizeForLog(state.intent.id),
      finalized.status,
      result.evidence.capture.skippedCount,
    );
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
    logEngineThrow(state, 'Copying the point into the volume', err);
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
  // The data is committed either way. A fence that could not be released is
  // still held, so the intent says so rather than clearing the class, and the
  // volume stays reserved until a retry or the next boot releases it.
  deps.intents.advance(state.intent.id, 'committed', { outcomeClass: released ? null : 'fence_unavailable' });
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
 * restarted only when the volume is proven to hold the original entries. An
 * intent whose staging volume is still on disk before the fence is not settled:
 * it stays open for the next pass, and the operation reports its own failure.
 */
async function settleRollback(
  ctx: OverwriteRunContext,
  state: PipelineState,
  errorClass: RecoveryErrorClass,
): Promise<void> {
  const outcome = await rollbackIntent(ctx.deps, state.intent.id);
  // `cleanup_pending` means the live volume is as it was and only the staging
  // volume is left, so the operation reports its own failure.
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

/**
 * Run `rollback` or `cleanup`, the two steps that end by removing the work
 * directory and its journal. The helper removes it before its closing syncs, so
 * a step that reports a failure may already have done all of its work, and with
 * the journal gone nothing could ever prove the volume again: an intent parked
 * `completion_unknown` would read an absent journal as unproven on every retry.
 * An absent journal after a failed step is that step having finished, so it is
 * taken as done. Any other answer keeps the failure.
 */
async function runClosingSwapStep(
  input: Parameters<typeof runSwapStep>[0] & { action: 'rollback' | 'cleanup' },
): Promise<SwapRunResult> {
  const result = await runSwapStep(input);
  if (result.ok) return result;
  const after = await runSwapStep({ ...input, action: 'status' });
  if (after.ok && after.report?.status === 'absent') return { ...result, ok: true };
  return result;
}

/** `cleanup_pending`: rolled back, but the staging volume is still on disk, so the intent stays open. */
type RollbackOutcome = 'rolled_back' | 'unknown' | 'cleanup_pending';

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
    const swap = await runClosingSwapStep({
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
  // The staging volume is removed before the fence goes up, so past that point a
  // leftover is not something the intent can wait on: the swap journal is gone and
  // a later pass would read the missing journal as an unproven state. It is still
  // removed here when it somehow exists, and its name is logged when it is not.
  const stagingOwed = PRE_FENCE_PHASES.includes(intent.phase);
  const stagingGone = (await stagingVolumeGone(deps, intent)) || !stagingOwed;
  const released = await releaseFence(deps, intentId, true);
  if (!stagingGone) {
    keepForCleanup(deps, intentId);
    return released ? 'cleanup_pending' : 'unknown';
  }
  try {
    deps.intents.advance(intentId, 'rolled_back', { outcomeClass: released ? null : 'fence_unavailable' });
  } catch (err) {
    // A phase that already settled is not an error on a retry.
    console.warn('[Recovery] Restore intent %s could not settle rolled_back:', intentId, errorMessageForLog(err));
  }
  releaseHolds(deps, intentId);
  return released ? 'rolled_back' : 'unknown';
}

/** A settled intent stops reporting `fence_unavailable` once its fence is released. */
function clearFenceOutcome(deps: OverwriteDeps, intent: RestoreIntentRecord): void {
  if (intent.outcomeClass === 'fence_unavailable') deps.intents.update(intent.id, { outcomeClass: null });
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
  // A dependent is a stack whose model declares the volume, and a stack that was
  // taken down still does. It has no fence member, so the set to compare with is
  // the one admission recorded (every declaring stack), plus the stacks of the
  // containers the fence owns. A stack that appeared after admission is in
  // neither, and that is what aborts here.
  const recordedStacks = new Set<string>(state.intent.dependentStacks);
  for (const member of state.members) {
    if (member.stackName !== null) recordedStacks.add(member.stackName);
  }
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
  const visited = new Set<string>();
  for (const intent of deps.intents.listUnsettled('staged_overwrite')) {
    visited.add(intent.id);
    const outcome = await reconcileOverwriteIntent(deps, intent, now);
    if (outcome === 'rolled_back') result.rolledBack += 1;
    else if (outcome === 'committed') result.committed += 1;
    else result.unknown += 1;
  }
  // A release that failed after the intent settled leaves a durable fence with
  // no unsettled row. It is still a fence: release it here, restarting what was
  // running, or the volume stays closed to every workload.
  for (const intent of deps.intents.listWithLiveFence('staged_overwrite')) {
    // Only a settled intent is released here. One that is still open (an unproven
    // swap, a leftover work directory) keeps its fence until the operator decides:
    // restarting its workloads would start them on data nobody has proven.
    if (intent.phase !== 'committed' && intent.phase !== 'rolled_back') {
      // The pass above counted every intent it visited. One it did not (parked
      // at `completion_unknown` with its fence held) is still an open restore.
      if (!visited.has(intent.id)) result.unknown += 1;
      continue;
    }
    const released = await releaseFence(deps, intent.id, true);
    if (released) {
      clearFenceOutcome(deps, intent);
      deps.points.removeHold({ pointId: intent.pointId, holderKind: 'restore_intent', holderRef: intent.id });
      if (intent.preRestorePointId) {
        deps.points.removeHold({
          pointId: intent.preRestorePointId, holderKind: 'restore_intent', holderRef: intent.id,
        });
      }
    } else if (!visited.has(intent.id)) {
      // A restore the pass above settled and counted is not counted again.
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
    const stagingGone = await stagingVolumeGone(deps, intent);
    const released = await releaseFence(deps, intent.id, true);
    // An open staging volume wins over the fence: the phase stays reachable, so
    // the next pass retries both.
    if (!stagingGone) {
      keepForCleanup(deps, intent.id, now);
      return 'unknown';
    }
    return settleProven(deps, intent, 'rolled_back', released, now);
  }

  if (FENCED_PHASES.includes(intent.phase)) {
    // The workloads are stopped and nothing was renamed yet.
    const rollback = await runClosingSwapStep({
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
    const stagingGone = await stagingVolumeGone(deps, intent);
    const released = await releaseFence(deps, intent.id, true);
    if (!stagingGone) {
      keepForCleanup(deps, intent.id, now);
      return 'unknown';
    }
    return settleProven(deps, intent, 'rolled_back', released, now);
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
  if (swapStatus === 'absent' && intent.phase === 'swapped') {
    // Cleanup only removes the work directory after the journal says the swap
    // committed, so an absent journal on a `swapped` intent means the clean-up
    // finished and the process died before the fence was released. There is
    // nothing left to move, and the data is proven: finish the release.
    const released = await releaseFence(deps, intent.id, true);
    return settleProven(deps, intent, 'committed', released, now);
  }
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
    const cleaned = await runClosingSwapStep({
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
      const current = deps.intents.get(intent.id);
      if (current?.phase === 'swapped') {
        // The data is committed and cleaned; only the fence is left. Keeping the
        // phase lets a retry finish it instead of pinning it as unknown.
        deps.intents.update(intent.id, { outcomeClass: 'fence_unavailable' }, now);
      } else {
        markUnknown(deps, intent, 'fence_unavailable', now);
      }
      return 'unknown';
    }
    deps.intents.advance(intent.id, 'committed', { outcomeClass: null }, now);
    releaseHolds(deps, intent.id);
    return 'committed';
  }

  // The journal says the swap did not commit. Roll the originals back.
  const rollback = await runClosingSwapStep({
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
  return settleProven(deps, intent, 'rolled_back', released, now);
}

/**
 * Settle an intent whose data is proven (the journal or the phase says which
 * way it went). A fence that could not be released is not a reason to call the
 * data unknown: the intent settles with `fence_unavailable`, the volume stays
 * reserved and closed to workloads while the fence is held, and a later release
 * (boot or `retry`) clears the class. This is the same ending the live pipeline
 * records for the same state.
 */
function settleProven(
  deps: OverwriteDeps,
  intent: RestoreIntentRecord,
  phase: 'committed' | 'rolled_back',
  released: boolean,
  now: number,
): 'committed' | 'rolled_back' {
  deps.intents.advance(intent.id, phase, { outcomeClass: released ? null : 'fence_unavailable' }, now);
  releaseHolds(deps, intent.id);
  return phase;
}

/**
 * How the operation of an overwrite that reads `completion_unknown` ends, once the
 * intent's own reconciliation has proven the data. `null` while the data is not
 * proven or the fence is still held over a rolled back volume: the operation then
 * keeps reading `completion_unknown` and its lock stays stale.
 *
 * A committed swap is `succeeded`, or `partial` while its clean-up or fence
 * release is owed, as the live pipeline reports it. A rollback is `failed` with
 * the class `interrupted` in every case, because the operation lost the process
 * that would have named a real class (the live pipeline reports `cancelled` or the
 * failing class for a rollback it ran itself, and that ending is never rewritten).
 */
export function overwriteEndingFor(
  intent: Pick<RestoreIntentRecord, 'phase' | 'outcomeClass'>,
): Exclude<OperationFinish, { state: 'completion_unknown' }> | null {
  const fenceOwed = intent.outcomeClass === 'fence_unavailable';
  switch (intent.phase) {
    case 'committed':
      return fenceOwed ? { state: 'partial', errorClass: 'fence_unavailable' } : { state: 'succeeded' };
    case 'rolled_back':
      return fenceOwed ? null : { state: 'failed', errorClass: 'interrupted' };
    case 'swapped':
      // The journal proved the swap committed; only a clean-up or a release is owed.
      if (intent.outcomeClass === 'cleanup_failed') return { state: 'partial', errorClass: 'cleanup_failed' };
      return fenceOwed ? { state: 'partial', errorClass: 'fence_unavailable' } : null;
    default:
      return null;
  }
}

/**
 * Bring the operation of every overwrite that reads `completion_unknown` (parked
 * by boot, or ended so by the live pipeline) in line with what its intent has
 * proven since. Idempotent, and a no-op for an intent that is still open. One
 * intent that cannot be settled is logged and does not stop the others.
 */
export function settleInterruptedOverwriteOperations(
  intents: Pick<RestoreIntentStore, 'listWithInterruptedOperation' | 'get'>,
  operations: Pick<RecoveryOperationStore, 'settleReconciled'>,
  intentId?: string,
): number {
  let candidates: RestoreIntentRecord[];
  if (intentId) {
    const intent = intents.get(intentId);
    candidates = intent ? [intent] : [];
  } else {
    candidates = intents.listWithInterruptedOperation('staged_overwrite');
  }
  let settled = 0;
  for (const intent of candidates) {
    if (!intent.operationId) continue;
    const ending = overwriteEndingFor(intent);
    if (!ending) continue;
    try {
      const stored = operations.settleReconciled(intent.operationId, ending);
      if (stored.state === ending.state) settled += 1;
    } catch (err) {
      console.warn('[Recovery] Could not settle the operation of restore %s:', intent.id, errorMessageForLog(err));
    }
  }
  return settled;
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
        clearFenceOutcome(deps, intent);
      }
      return { outcome: intent.phase === 'committed' ? 'committed' : 'rolled_back' };
    }
    return { outcome: await reconcileOverwriteIntent(deps, intent) };
  }
  if (intent.phase === 'committed' || intent.phase === 'rolled_back') throw new RecoveryError('invalid_request');
  // Until the fence is held nothing was stopped, so there is nothing to release, and
  // accepting the volume here would leave the staging volume with no owner.
  if (intent.fenceState === 'none' && (PRE_FENCE_PHASES.includes(intent.phase) || FENCED_PHASES.includes(intent.phase))) {
    throw new RecoveryError('invalid_request', {
      reason: 'no_fence',
      detail: 'This restore never stopped a workload, so there is no fence to release. Retry it to finish its clean-up.',
    });
  }
  // Once the fence has been released, the workloads may be running again, so no
  // reconciliation step may move data under them.
  if (intent.fenceState === 'released') {
    if (intent.phase === 'swapped' && intent.outcomeClass === 'cleanup_failed') {
      throw new RecoveryError('invalid_request', {
        reason: 'fence_released',
        detail: 'The fence is already released, but the originals are still in the volume. Retry this restore to remove them.',
      });
    }
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
  if (status === 'swapped' && intent.phase === 'swapped' && intent.targetVolume) {
    // `committed` is terminal, and nothing visits a settled intent again, so it
    // is reached only once the work directory (a full copy of the data this
    // overwrite replaced) is gone. The journal says the swap committed, which is
    // what `cleanup` needs. If it cannot run, the operator's choice to release
    // the fence still stands, but the intent stays `swapped` with the class set,
    // so the next boot or a `retry` finishes the clean-up and the volume stays
    // reserved until then.
    const cleaned = await runSwapStep({
      runner: deps.runner(),
      operationId: `overwrite-resolve-${intent.id}`,
      volumeName: intent.targetVolume,
      intentId: intent.id,
      action: 'cleanup',
    });
    if (!cleaned.ok) {
      console.warn(
        '[Recovery] Fence released on %s, but the originals could not be removed (%s); retry the restore to finish.',
        intent.id,
        cleaned.errorClass ?? 'helper_failed',
      );
      deps.intents.update(intent.id, { outcomeClass: 'cleanup_failed' });
      return { outcome: 'fence_released' };
    }
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

/**
 * Who an overwrite touched: the stacks it recorded at admission and the stacks
 * of the containers its fence owns, plus whether the fence owns one that no
 * stack claims. The live dependents of the volume are not this set, because a
 * stack can drop the volume or be renamed after the fence stopped its containers,
 * and the decisions that start those containers again (resolve, cancel) must be
 * held to the stacks that were actually stopped.
 */
export interface OverwriteIntentScope {
  stacks: string[];
  unowned: boolean;
}

export function overwriteIntentScope(
  intent: Pick<RestoreIntentRecord, 'id' | 'dependentStacks'>,
  fence: Pick<RestoreFenceStore, 'listMembers'>,
): OverwriteIntentScope {
  const stacks = new Set<string>(intent.dependentStacks);
  let unowned = false;
  for (const member of fence.listMembers(intent.id)) {
    if (member.stackName) stacks.add(member.stackName);
    else unowned = true;
  }
  return { stacks: [...stacks].sort(), unowned };
}

/** The paths a preview or a support response may name, relative to the volume. */
export function workDirFor(intentId: string): string {
  return swapIncomingDir(intentId);
}
