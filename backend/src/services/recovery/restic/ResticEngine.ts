import {
  HELPER_RESTORE_MOUNT,
  RecoveryHelperRunner,
  resticCommand,
  type HelperProfile,
  type HelperRunResult,
  type HelperRunSpec,
} from './helperRunner';
import {
  applyBackupLine,
  applyRestoreLine,
  classifyBackupRun,
  classifyRestoreRun,
  helperFailureNote,
  newBackupAccumulator,
  newRestoreAccumulator,
} from './resticOutput';
import { sanitizeForLog } from '../../../utils/safeLog';
import { consistencyFromObservations, type InUseObservation } from '../volumeSources';
import { RECOVERY_CONTRACT_VERSION } from '../types';
import { RECOVERY_WORK_DIR_GLOB } from '../restoreIntents';
import {
  classifyContentRun,
  contentSnapshotPath,
  parentPointPath,
  parseContentLine,
} from './resticContents';
import type {
  BackupEngine,
  ContentChunkSink,
  ContentDump,
  ContentReadContext,
  ContentReadRequest,
  CreatePointRequest,
  EngineExecutionContext,
  EngineProbe,
  EngineResult,
  IntegrityMethod,
  PointCaptureEvidence,
  PointContentReader,
  PointDirectoryRead,
  PointEntry,
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

/**
 * How long one listing may take. A directory read loads the repository index
 * before the first entry, and a repository on a stalled mount would otherwise
 * hold a helper and a response forever. A file body has no total deadline: it
 * moves at the client's pace, and the download route stops one that stops moving.
 */
export const CONTENT_LISTING_TIMEOUT_MS = 120 * 1000;

export class ResticEngine implements BackupEngine, PointContentReader {
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
    // A staged overwrite's work directory holds the replaced data and a copy of the
    // restored data, not the volume's own content. A point that carried one would
    // put it back on restore, and the next overwrite of that volume would refuse it.
    // The pattern is anchored at the volume root and matches only the intent-id
    // shape Sencho creates, so a user's top-level entry with the prefix and any
    // other name is captured like any other data. Restic does not report an
    // excluded path as a skipped one, so the preview tells the operator that a
    // point does not carry the directory.
    const args = ['backup', '/data', '--json', '--host', 'sencho', '--exclude', `/data/${RECOVERY_WORK_DIR_GLOB}`];
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
    if (outcome.status === 'failed') {
      console.warn(
        '[Recovery] Backup helper for operation %s failed with %s, exit %s: %s',
        sanitizeForLog(ctx.operationId),
        outcome.errorClass,
        helperResult.exitCode ?? 'none',
        helperFailureNote(helperResult.stderrTail, [], [this.deps.secret]),
      );
      return { ok: false, errorClass: outcome.errorClass };
    }

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
    const repository = this.deps.repositoryFor(intent.repositoryId);
    if (!repository) return { ok: false, errorClass: 'repository_unavailable' };
    if (!intent.snapshotId) return { ok: false, errorClass: 'invalid_request' };

    let args: string[];
    let profile: Extract<HelperProfile, 'restore' | 'materialize'> = 'restore';
    if (intent.target.mode === 'new_volume') {
      // `snapshot:/data` puts the captured root's contents at the target root,
      // which is the right shape for a volume Sencho created.
      // A point captured before the capture excluded work directories can carry one
      // at its root, which would make the new volume refuse its first overwrite.
      args = ['restore', `${intent.snapshotId}:/data`, '--target', HELPER_RESTORE_MOUNT, '--exclude', `/${RECOVERY_WORK_DIR_GLOB}`];
    } else if (intent.target.mode === 'staged_overwrite') {
      // The whole snapshot, into a work directory inside the live volume. That
      // gives `.../incoming/data/...`, so the captured root's own owner and mode
      // arrive as an ordinary entry the swap can apply to the volume root.
      const workDir = intent.target.workDir;
      if (!/^\.sencho-restore-[0-9a-f-]{36}\/incoming$/.test(workDir)) {
        return { ok: false, errorClass: 'invalid_request' };
      }
      args = [
        'restore', intent.snapshotId, '--target', `${HELPER_RESTORE_MOUNT}/${workDir}`,
        '--exclude', `/data/${RECOVERY_WORK_DIR_GLOB}`,
      ];
      // The live root may belong to the application, which a plain root cannot write.
      profile = 'materialize';
    } else {
      return { ok: false, errorClass: 'invalid_request' };
    }

    const accumulator = newRestoreAccumulator();
    const spec: HelperRunSpec = {
      profile,
      operationId: ctx.operationId,
      // `--no-lock`: the repository mount is read-only and Sencho's repository
      // lock is the mutual exclusion, so restic must not try to write a lock.
      cmd: resticCommand('/repo', [...args, '--verify', '--json', '--no-lock']),
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
    if (outcome.status === 'failed') {
      // The helper container is removed when it exits and the API answers the
      // class only, so this line is the one place the cause survives.
      console.warn(
        '[Recovery] Restore helper (%s) for operation %s failed with %s, exit %s: %s',
        profile,
        sanitizeForLog(ctx.operationId),
        outcome.errorClass,
        result.exitCode ?? 'none',
        helperFailureNote(result.stderrTail, accumulator.sampleErrors, [this.deps.secret]),
      );
      return { ok: false, errorClass: outcome.errorClass };
    }
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

  // --- Point contents -------------------------------------------------------

  /**
   * One directory read of a saved point: the path's own record and one page of
   * its immediate children.
   *
   * `restic ls --json` walks to the requested path and prints the path's own
   * node followed by its immediate children in tree order (sorted by name), so
   * an offset names the same entry on every read of an immutable snapshot. The
   * run skips the first `offset` children without keeping them and stops itself
   * once it has seen one entry past the page, which is how it knows there is a
   * next page. That stop is a SIGINT the classifier reads as success.
   */
  async readDirectory(
    request: ContentReadRequest,
    page: { offset: number; pageSize: number },
    ctx: ContentReadContext,
  ): Promise<EngineResult<PointDirectoryRead>> {
    const repository = this.deps.repositoryFor(request.repositoryId);
    if (!repository) return { ok: false, errorClass: 'repository_unavailable' };
    if (!request.snapshotId) return { ok: false, errorClass: 'invalid_request' };
    const snapshotPath = contentSnapshotPath(request.path);

    const entries: PointEntry[] = [];
    let self: PointEntry | null = null;
    let seen = 0;
    let hasMore = false;
    // Set when the run stops itself: the page is full, the record is all a
    // file, a link or a record-only read needs, or a line could not be trusted.
    let stopped = false;
    let malformed = false;
    const stop = (): void => {
      stopped = true;
      controller.abort();
    };
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort();
    if (ctx.signal.aborted) controller.abort();
    else ctx.signal.addEventListener('abort', onExternalAbort, { once: true });

    let result: HelperRunResult;
    try {
      result = await this.deps.runner.run({
        profile: 'read',
        operationId: ctx.operationId,
        cmd: resticCommand('/repo', ['ls', request.snapshotId, snapshotPath, '--json', '--no-lock', '--quiet']),
        mounts: { repository: repository.locator },
        stdinSecret: this.deps.secret,
        signal: controller.signal,
        timeoutMs: CONTENT_LISTING_TIMEOUT_MS,
        onStdoutLine: (line) => {
          if (stopped) return;
          const parsed = parseContentLine(line);
          if (parsed.kind === 'skip') return;
          if (parsed.kind === 'malformed') {
            malformed = true;
            stop();
            return;
          }
          const entry = parsed.entry;
          if (entry.path === request.path) {
            self = entry;
            if (entry.type !== 'directory' || page.pageSize === 0) stop();
            return;
          }
          if (parentPointPath(entry.path) !== request.path) return;
          seen += 1;
          if (seen <= page.offset) return;
          if (entries.length >= page.pageSize) {
            hasMore = true;
            stop();
            return;
          }
          entries.push(entry);
        },
      });
    } finally {
      ctx.signal.removeEventListener('abort', onExternalAbort);
    }

    const failure = this.contentFailure('list', request, result, ctx.signal, stopped && !ctx.signal.aborted);
    if (failure) return failure;
    if (malformed) {
      // restic printed a record this build cannot read. A page that skipped it
      // would shift every offset after it, so the read fails instead.
      console.warn('[Recovery] Listing of snapshot %s returned a record this build cannot read', sanitizeForLog(request.snapshotId));
      return { ok: false, errorClass: 'node_error' };
    }
    if (!self) return { ok: true, evidence: { found: false } };
    return {
      ok: true,
      evidence: {
        found: true,
        self,
        entries,
        nextOffset: hasMore ? page.offset + page.pageSize : null,
      },
    };
  }

  /**
   * Stream one regular file out of a saved point.
   *
   * The caller sends the headers from the metadata read and then hands the body
   * to its sink. The byte count is checked against what the metadata promised, so
   * a body that stopped early (a missing chunk, a helper killed mid-file) is an
   * integrity failure rather than a short success.
   */
  async dumpFile(
    request: ContentReadRequest,
    expectedBytes: number,
    sink: ContentChunkSink,
    ctx: ContentReadContext,
  ): Promise<EngineResult<ContentDump>> {
    const repository = this.deps.repositoryFor(request.repositoryId);
    if (!repository) return { ok: false, errorClass: 'repository_unavailable' };
    if (!request.snapshotId) return { ok: false, errorClass: 'invalid_request' };
    const snapshotPath = contentSnapshotPath(request.path);

    let bytes = 0;
    const result = await this.deps.runner.run({
      profile: 'read',
      operationId: ctx.operationId,
      cmd: resticCommand('/repo', ['dump', request.snapshotId, snapshotPath, '--no-lock', '--quiet']),
      mounts: { repository: repository.locator },
      stdinSecret: this.deps.secret,
      signal: ctx.signal,
      onStdoutChunk: (chunk, control) => {
        bytes += chunk.length;
        sink(chunk, control);
      },
    });
    const failure = this.contentFailure('dump', request, result, ctx.signal, false);
    if (failure) return failure;
    if (bytes !== expectedBytes) {
      console.warn(
        '[Recovery] Dump of snapshot %s returned %d of %d bytes: %s',
        sanitizeForLog(request.snapshotId),
        bytes,
        expectedBytes,
        helperFailureNote(result.stderrTail, [], [this.deps.secret]),
      );
      return { ok: false, errorClass: 'integrity_mismatch' };
    }
    return { ok: true, evidence: { bytes } };
  }

  /**
   * A read run's exit in Sencho's terms: null when it produced its output.
   *
   * The one place a read failure's cause survives: the helper container is
   * removed when it exits and the API answers a sanitized class, so the
   * node-local log is the only record that tells a missing snapshot from an
   * unreadable repository. It is written here rather than at each call site.
   */
  private contentFailure(
    what: 'list' | 'dump',
    request: ContentReadRequest,
    result: HelperRunResult,
    signal: AbortSignal,
    stoppedEarly: boolean,
  ): EngineResult<never> | null {
    const outcome = classifyContentRun({
      exitCode: result.exitCode,
      aborted: result.aborted,
      killed: result.killed,
      externalAborted: signal.aborted,
      stoppedEarly,
    });
    if (outcome.status === 'ok') return null;
    if (outcome.status === 'cancelled') return { ok: false, errorClass: 'interrupted' };
    console.warn(
      '[Recovery] Content %s for snapshot %s failed with %s, exit %s: %s',
      what,
      sanitizeForLog(request.snapshotId),
      outcome.errorClass,
      result.exitCode ?? 'none',
      helperFailureNote(result.stderrTail, [], [this.deps.secret]),
    );
    return { ok: false, errorClass: outcome.errorClass };
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
