import {
  RecoveryHelperRunner,
  resticCommand,
  type HelperRunSpec,
} from './helperRunner';
import {
  applyBackupLine,
  applyRestoreLine,
  classifyBackupRun,
  classifyRestoreRun,
  newBackupAccumulator,
  newRestoreAccumulator,
} from './resticOutput';
import { consistencyFromObservations, type InUseObservation } from '../volumeSources';
import { RECOVERY_CONTRACT_VERSION } from '../types';
import type {
  BackupEngine,
  CreatePointRequest,
  EngineExecutionContext,
  EngineProbe,
  EngineResult,
  IntegrityMethod,
  PointCaptureEvidence,
  RecoveryPoint,
  RestoreEvidence,
  RestoreIntent,
  StorageKind,
} from '../types';

/**
 * The restic adapter: the first `BackupEngine`, and the only thing that knows
 * restic exists.
 *
 * It runs entirely on the node that owns the data, through the hardened helper
 * profiles, and it keeps no state of its own: the repository, the points and the
 * locks are the foundation's records. Every dependency is injected, so a test can
 * build an engine with a reduced profile or a stubbed helper runner.
 *
 * Consistency is decided here, before the caller finalizes the point, because the
 * label describes what was observed while the bytes were read. It is a statement
 * about what Sencho saw, never a claim that the application flushed anything.
 */
/** The engine id stamped on every point this adapter captures. */
export const RESTIC_ENGINE_ID = 'restic';

export class ResticEngine implements BackupEngine {
  readonly engineId = RESTIC_ENGINE_ID;
  readonly contractVersion = RECOVERY_CONTRACT_VERSION;
  readonly storageKinds: readonly StorageKind[] = ['named_volume'];

  constructor(private readonly deps: ResticEngineDeps) {}

  async probe(): Promise<EngineProbe> {
    const state = await this.deps.inspectHelperImage();
    return {
      engineId: this.engineId,
      build: this.deps.helperImageRef,
      usable: state.state === 'present',
    };
  }

  async createPoint(
    request: CreatePointRequest,
    ctx: EngineExecutionContext,
  ): Promise<EngineResult<PointCaptureEvidence>> {
    // A path point is not part of this slice; refuse rather than capture the root
    // and call it a path.
    if (request.kind !== 'root') return { ok: false, errorClass: 'invalid_request' };
    if (request.storage.kind !== 'named_volume') return { ok: false, errorClass: 'invalid_request' };

    const repositoryVolume = request.repository.locator;
    const sourceVolume = request.storage.locator;
    const pointId = ctx.pointId;
    if (!pointId) return { ok: false, errorClass: 'internal' };

    const before = await this.observeInUse(sourceVolume);
    const tags = [
      `sencho-storage=${request.storage.storageKey.slice(0, 16)}`,
      `sencho-gen=${request.storage.generation}`,
      `sencho-point=${pointId}`,
    ];

    const accumulator = newBackupAccumulator();
    const args = ['backup', '/data', '--json', '--host', 'sencho'];
    for (const tag of tags) args.push('--tag', tag);
    const parent = this.deps.parentSnapshot(request.storage, request.repository.id);
    if (parent) args.push('--parent', parent);
    const helperResult = await this.deps.runner.run({
      profile: 'backup',
      operationId: ctx.operationId,
      cmd: resticCommand('/repo', args),
      mounts: { repository: repositoryVolume, source: sourceVolume },
      stdinSecret: this.deps.secret,
      signal: ctx.signal,
      onStdoutLine: (line) => {
        applyBackupLine(accumulator, line);
        ctx.onProgress({
          operationId: ctx.operationId,
          phase: 'transferring',
          filesDone: accumulator.filesDone,
          bytesDone: accumulator.bytesDone,
          bytesTotal: accumulator.bytesTotal,
        });
      },
      // restic writes its `message_type: error` items to stderr even in JSON mode.
      onStderrLine: (line) => applyBackupLine(accumulator, line),
    });

    const outcome = classifyBackupRun({
      exitCode: helperResult.exitCode,
      aborted: helperResult.aborted,
      killed: helperResult.killed,
      accumulator,
      stderrTail: helperResult.stderrTail,
    });
    if (outcome.status === 'cancelled') return { ok: false, errorClass: 'interrupted' };
    if (outcome.status === 'failed') return { ok: false, errorClass: outcome.errorClass };

    // The generation token is re-read after the capture: a volume recreated
    // while it was being read gives a point that describes bytes that no longer
    // exist, and it must not be labelled with the generation the caller saw.
    let token: string;
    try {
      token = await this.deps.readGenerationToken(sourceVolume);
    } catch {
      return { ok: false, errorClass: 'identity_unknown' };
    }
    if (token !== request.storage.generationToken) return { ok: false, errorClass: 'identity_unknown' };

    const after = await this.observeInUse(sourceVolume);
    const summary = accumulator.summary;
    if (!summary || summary.snapshotId === '') return { ok: false, errorClass: 'internal' };

    return {
      ok: true,
      evidence: {
        snapshotId: summary.snapshotId,
        capture: {
          fileCount: summary.filesProcessed,
          byteCount: summary.bytesProcessed,
          skippedCount: accumulator.skippedCount,
        },
        exclusions: accumulator.exclusions,
        consistency: consistencyFromObservations(before, after),
      },
    };
  }

  async verifyPoint(
    point: Extract<RecoveryPoint, { status: 'succeeded' | 'partial' }>,
    method: IntegrityMethod,
    ctx: EngineExecutionContext,
  ): Promise<EngineResult<{ result: 'verified' | 'mismatch' }>> {
    if (!point.snapshotId) return { ok: false, errorClass: 'invalid_request' };
    const repository = this.deps.repositoryFor(point.repositoryId);
    if (!repository) return { ok: false, errorClass: 'repository_unavailable' };
    const outcome = await this.deps.runCheck(repository.locator, method, ctx);
    if (outcome.result === 'error') return { ok: false, errorClass: outcome.errorClass };
    return { ok: true, evidence: { result: outcome.result } };
  }

  async restore(intent: RestoreIntent, ctx: EngineExecutionContext): Promise<EngineResult<RestoreEvidence>> {
    if (intent.target.mode !== 'new_volume') return { ok: false, errorClass: 'invalid_request' };
    const repository = this.deps.repositoryFor(intent.repositoryId);
    if (!repository) return { ok: false, errorClass: 'repository_unavailable' };
    if (!intent.snapshotId) return { ok: false, errorClass: 'invalid_request' };

    const accumulator = newRestoreAccumulator();
    const spec: HelperRunSpec = {
      profile: 'restore',
      operationId: ctx.operationId,
      // `--no-lock`: the repository mount is read-only and Sencho's repository
      // lock is the mutual exclusion, so restic must not try to write a lock.
      cmd: resticCommand('/repo', [
        'restore', `${intent.snapshotId}:/data`,
        '--target', '/restore',
        '--verify',
        '--json',
        '--no-lock',
      ]),
      mounts: { repository: repository.locator, target: intent.target.volumeName },
      stdinSecret: this.deps.secret,
      signal: ctx.signal,
      onStdoutLine: (line) => {
        applyRestoreLine(accumulator, line);
        ctx.onProgress({
          operationId: ctx.operationId,
          phase: 'transferring',
          filesDone: accumulator.filesRestored,
          bytesDone: accumulator.bytesRestored,
          bytesTotal: null,
        });
      },
      onStderrLine: (line) => applyRestoreLine(accumulator, line),
    };
    const result = await this.deps.runner.run(spec);
    const outcome = classifyRestoreRun({
      exitCode: result.exitCode,
      aborted: result.aborted,
      killed: result.killed,
      accumulator,
      stderrTail: result.stderrTail,
    });
    if (outcome.status === 'cancelled') return { ok: false, errorClass: 'interrupted' };
    if (outcome.status === 'failed') return { ok: false, errorClass: outcome.errorClass };
    return {
      ok: true,
      evidence: {
        filesRestored: accumulator.filesRestored,
        bytesRestored: accumulator.bytesRestored,
        verified: outcome.status === 'restored',
        xattrWarnings: outcome.status === 'partial' ? outcome.xattrWarnings : 0,
      },
    };
  }

  private async observeInUse(volumeName: string): Promise<InUseObservation | null> {
    try {
      return await this.deps.observeInUse(volumeName);
    } catch {
      // An in-use check that could not run makes the consistency label unknown.
      return null;
    }
  }
}

export interface ResticEngineDeps {
  runner: RecoveryHelperRunner;
  /** The decrypted repository password, for this run only. */
  secret: string;
  helperImageRef: string;
  inspectHelperImage: () => Promise<{ state: 'present' | 'missing' | 'unavailable' }>;
  /** The newest complete snapshot of this storage generation in this repository. */
  parentSnapshot: (storage: { id: string; storageKey: string; generation: number }, repositoryId: string) => string | null;
  readGenerationToken: (volumeName: string) => Promise<string>;
  observeInUse: (volumeName: string) => Promise<InUseObservation>;
  repositoryFor: (repositoryId: string) => { id: string; locator: string } | null;
  runCheck: (
    repositoryVolume: string,
    method: IntegrityMethod,
    ctx: EngineExecutionContext,
  ) => Promise<{ result: 'verified' | 'mismatch' } | { result: 'error'; errorClass: import('../types').RecoveryErrorClass }>;
}

export type { RecoveryHelperRunner };
