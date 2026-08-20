/**
 * Shared deployed-stack deletion lifecycle (manual DELETE + Blueprint withdrawLocal).
 *
 * prepared -> (down, optional volume prune, FS delete) -> ready transaction that
 * retires full-stack recovery generations and service_update_recovery rows, then
 * sweeper removes ready tombstone tags/overrides.
 */
import { randomUUID } from 'crypto';
import Docker from 'dockerode';
import fs from 'fs/promises';
import path from 'path';
import {
  DatabaseService,
  type StackUpdateCleanupPendingRow,
} from './DatabaseService';
import { ComposeService } from './ComposeService';
import DockerController from './DockerController';
import { FileSystemService } from './FileSystemService';
import { GitProjectManifestService } from './GitProjectManifestService';
import { NodeRegistry } from './NodeRegistry';
import { MeshService } from './MeshService';
import { NotificationService } from './NotificationService';
import { StackOpLockService, stackOpSkipMessage } from './StackOpLockService';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';
import { isPathWithinBase, isValidStackName } from '../utils/validation';
import {
  BLUEPRINT_MARKER_FILENAME,
  parseBlueprintMarker,
} from '../helpers/blueprintMarker';
import { GitOpsStore } from './gitops/store';
import { GitOpsTransitions } from './gitops/transitions';
import { scrapeRollbackTagsLenient } from './recoveryServicesJson';

/**
 * Directory that may contain recovery override files for a tombstone sweep.
 * Stack-scoped intents are limited to `<composeDir>/<stackName>/`;
 * node-wide intents (null stack) use the whole compose root.
 */
export function overrideDeletionContainmentBase(
  composeDir: string,
  stackName: string | null,
): string | null {
  const resolvedCompose = path.resolve(composeDir);
  if (!stackName) return resolvedCompose;
  if (!isValidStackName(stackName)) return null;
  const stackDir = path.resolve(resolvedCompose, stackName);
  if (!isPathWithinBase(stackDir, resolvedCompose)) return null;
  return stackDir;
}

export interface DeleteDeployedStackInput {
  nodeId: number;
  stackName: string;
  pruneVolumes: boolean;
  actor: string;
  /** When set, deletion requires an on-disk .blueprint.json matching this blueprint ID. */
  requireBlueprintId?: number;
  /** When true, skip acquiring a new lock (caller already holds delete via continuation). */
  continuationIntentId?: string;
}

export type DeleteDeployedStackResult =
  | { ok: true; status: 'deleted' | 'already_absent' }
  | {
      ok: false;
      code: 'lock_conflict' | 'fs_failed' | 'tombstone_failed' | 'db_failed' | 'name_conflict' | 'failed';
      error: string;
      existingAction?: string;
    };

type DirProbe = { kind: 'absent' } | { kind: 'present' } | { kind: 'error'; error: string };
type MarkerProbe =
  | { kind: 'match' }
  | { kind: 'name_conflict'; error: string }
  | { kind: 'failed'; error: string };

function blueprintMarkerMismatchError(stackName: string): string {
  return `Stack "${stackName}" exists without a matching blueprint marker; refusing to withdraw.`;
}

function collectArtifactsFromGenerations(
  generations: Array<{ override_path: string | null; services_json: string }>,
): { tags: string[]; overridePaths: string[] } {
  const tags = new Set<string>();
  const overridePaths = new Set<string>();

  for (const gen of generations) {
    if (gen.override_path) overridePaths.add(gen.override_path);
    for (const tag of scrapeRollbackTagsLenient(gen.services_json)) tags.add(tag);
  }

  return { tags: [...tags], overridePaths: [...overridePaths] };
}

function collectArtifacts(nodeId: number, stackName: string): { tags: string[]; overridePaths: string[] } {
  return collectArtifactsFromGenerations(
    DatabaseService.getInstance().listStackUpdateRecoveryForStack(nodeId, stackName),
  );
}

function parseJsonStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}


async function probeStackDirectory(nodeId: number, stackName: string): Promise<DirProbe> {
  // Canonical js/path-injection barrier inline with the stat sink.
  const baseResolved = path.resolve(FileSystemService.getInstance(nodeId).getBaseDir());
  const safePath = path.resolve(baseResolved, stackName);
  if (!safePath.startsWith(baseResolved + path.sep)) {
    return { kind: 'error', error: 'Invalid stack path' };
  }
  try {
    const stat = await fs.stat(safePath);
    return stat.isDirectory() ? { kind: 'present' } : { kind: 'absent' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'error', error: getErrorMessage(error, 'Failed to access stack directory') };
  }
}

async function probeBlueprintMarkerOwnership(
  nodeId: number,
  stackName: string,
  requireBlueprintId: number,
): Promise<MarkerProbe> {
  // Canonical js/path-injection barrier inline with the read sink.
  const baseResolved = path.resolve(NodeRegistry.getInstance().getComposeDir(nodeId));
  const safePath = path.resolve(baseResolved, stackName, BLUEPRINT_MARKER_FILENAME);
  if (!safePath.startsWith(baseResolved + path.sep)) {
    return { kind: 'failed', error: 'Invalid stack path for blueprint marker' };
  }
  try {
    const content = await fs.readFile(safePath, 'utf-8');
    const marker = parseBlueprintMarker(content);
    if (!marker || marker.blueprintId !== requireBlueprintId) {
      return { kind: 'name_conflict', error: blueprintMarkerMismatchError(stackName) };
    }
    return { kind: 'match' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { kind: 'name_conflict', error: blueprintMarkerMismatchError(stackName) };
    }
    return { kind: 'failed', error: getErrorMessage(error, 'Failed to read blueprint marker') };
  }
}

export class DeployedStackDeletionService {
  private static instance: DeployedStackDeletionService;

  public static getInstance(): DeployedStackDeletionService {
    if (!DeployedStackDeletionService.instance) {
      DeployedStackDeletionService.instance = new DeployedStackDeletionService();
    }
    return DeployedStackDeletionService.instance;
  }

  public assertNoBlockingDeletionIntent(nodeId: number, stackName: string): void {
    if (DatabaseService.getInstance().hasBlockingDeletionIntent(nodeId, stackName)) {
      throw new Error(
        `Stack "${stackName}" has a deletion in progress and cannot be created or mutated until cleanup finishes.`,
      );
    }
  }

  public async deleteDeployedStack(input: DeleteDeployedStackInput): Promise<DeleteDeployedStackResult> {
    const { nodeId, stackName, actor } = input;
    const locks = StackOpLockService.getInstance();

    if (input.continuationIntentId) {
      const cont = locks.tryAcquireDeletionContinuation({
        intentId: input.continuationIntentId,
        nodeId,
        stackName,
      });
      if (!cont.acquired) {
        return {
          ok: false,
          code: 'lock_conflict',
          error: stackOpSkipMessage(stackName, cont.existing.action),
          existingAction: cont.existing.action,
        };
      }
      try {
        return await this.runDeletionBody(input, input.continuationIntentId);
      } finally {
        locks.release(nodeId, stackName);
      }
    }

    const exclusive = await locks.runExclusive(nodeId, stackName, 'delete', actor, async () => {
      return this.runDeletionBody(input);
    });
    if (!exclusive.ran) {
      return {
        ok: false,
        code: 'lock_conflict',
        error: stackOpSkipMessage(stackName, exclusive.existing.action),
        existingAction: exclusive.existing.action,
      };
    }
    return exclusive.result;
  }

  private async runDeletionBody(
    input: DeleteDeployedStackInput,
    existingIntentId?: string,
  ): Promise<DeleteDeployedStackResult> {
    const { nodeId, stackName, pruneVolumes } = input;
    const db = DatabaseService.getInstance();

    // Continuation loads ownership from the persisted intent; first call uses input.
    let requiredBlueprintId: number | null =
      typeof input.requireBlueprintId === 'number' ? input.requireBlueprintId : null;

    if (existingIntentId) {
      const existing = db.getDeletionIntentById(existingIntentId);
      if (!existing || existing.status !== 'prepared') {
        return { ok: false, code: 'tombstone_failed', error: 'Deletion intent is not prepared' };
      }
      if (existing.required_blueprint_id != null) {
        requiredBlueprintId = existing.required_blueprint_id;
      }
    }

    let skipPhysical = false;
    if (requiredBlueprintId != null) {
      const dirProbe = await probeStackDirectory(nodeId, stackName);
      if (dirProbe.kind === 'error') {
        return { ok: false, code: 'failed', error: dirProbe.error };
      }
      if (dirProbe.kind === 'absent') {
        skipPhysical = true;
      } else {
        const ownership = await probeBlueprintMarkerOwnership(nodeId, stackName, requiredBlueprintId);
        if (ownership.kind === 'failed') {
          return { ok: false, code: 'failed', error: ownership.error };
        }
        if (ownership.kind === 'name_conflict') {
          if (existingIntentId) {
            db.updateCleanupPendingStatus(existingIntentId, 'cancelled');
          }
          return { ok: false, code: 'name_conflict', error: ownership.error };
        }
      }
    }

    let intentId = existingIntentId;
    if (!intentId) {
      const { tags, overridePaths } = collectArtifacts(nodeId, stackName);
      const now = Date.now();
      const row: StackUpdateCleanupPendingRow = {
        id: randomUUID(),
        node_id: nodeId,
        stack_name: stackName,
        status: 'prepared',
        target_kind: 'local_socket',
        rollback_tags_json: JSON.stringify(tags),
        override_paths_json: JSON.stringify(overridePaths),
        prune_volumes_requested: pruneVolumes ? 1 : 0,
        required_blueprint_id: requiredBlueprintId,
        created_at: now,
        updated_at: now,
      };
      try {
        db.insertCleanupPending(row);
      } catch (error) {
        return {
          ok: false,
          code: 'tombstone_failed',
          error: getErrorMessage(error, 'Failed to prepare stack deletion'),
        };
      }
      intentId = row.id;
    }

    const intent = db.getDeletionIntentById(intentId);
    if (!intent || intent.status !== 'prepared') {
      return { ok: false, code: 'tombstone_failed', error: 'Deletion intent is not prepared' };
    }

    if (!skipPhysical) {
      try {
        await ComposeService.getInstance(nodeId).downStack(stackName, {
          removeVolumes: intent.prune_volumes_requested === 1,
        });
      } catch (downErr) {
        console.warn(
          '[DeployedStackDeletion] Compose down failed or no-op for %s:',
          sanitizeForLog(stackName),
          downErr,
        );
      }

      if (intent.prune_volumes_requested === 1) {
        try {
          await DockerController.getInstance(nodeId).pruneManagedOnly('volumes', [stackName]);
        } catch (pruneErr) {
          console.warn(
            '[DeployedStackDeletion] Volume prune failed for %s, continuing delete:',
            sanitizeForLog(stackName),
            pruneErr,
          );
        }
      }

      try {
        await FileSystemService.getInstance(nodeId).deleteStack(stackName);
      } catch (fsErr) {
        db.updateCleanupPendingStatus(intentId, 'cancelled');
        return {
          ok: false,
          code: 'fs_failed',
          error: getErrorMessage(fsErr, 'Failed to remove stack files'),
        };
      }
    }

    const finalized = await this.finalizeLogicalDeletion(input, intentId);
    if (!finalized.ok) return finalized;
    return { ok: true, status: skipPhysical ? 'already_absent' : 'deleted' };
  }

  /** Ready transaction, secondary DB/RBAC cleanup, mesh opt-out, sweep, invalidate. */
  /**
   * Commit the deletion and retire the stack's GitOps application together.
   *
   * One transaction, because a deleted stack with a live application would keep
   * claiming a stack name that no longer exists, and would block re-creating it
   * through the unique live-application index. The tombstone is driven from
   * here rather than from inside DatabaseService so the store keeps its
   * transitions, and its history, in one place.
   */
  private commitDeletionReady(intentId: string, nodeId: number, stackName: string): boolean {
    const db = DatabaseService.getInstance();
    return db.getDb().transaction(() => {
      if (!db.commitStackDeletionReadyTransaction(intentId, nodeId, stackName)) return false;
      const app = GitOpsStore.getInstance().getLiveDirectApplication(stackName);
      if (!app) return true;
      const tx = GitOpsTransitions.getInstance();
      const envelope = {
        operationId: intentId,
        actor: 'system:stack-deletion',
        trigger: 'delete',
        at: Date.now(),
      };
      // The files are already gone by the time this runs, and the startup
      // reconciler loops over every prepared intent. A rejected tombstone must
      // fail this one deletion, not throw an opaque driver error out of a
      // deletion that already succeeded on disk, and not abandon the intents
      // that follow it.
      try {
        for (const target of GitOpsStore.getInstance().listTargets(app.id)) {
          if (target.target_status !== 'active') continue;
          tx.targetTombstoned(app.id, target.node_id, envelope);
        }
        tx.applicationTombstoned(app.id, 'deleted', envelope);
      } catch (error) {
        console.error(
          '[GitOps] Could not retire the application for deleted stack %s (application %s):',
          sanitizeForLog(stackName), app.id,
          error instanceof Error ? error.stack ?? error.message : String(error),
        );
        return false;
      }
      // A create that never settled leaves a checkpoint whose application is
      // now gone; drop it so boot recovery does not retry it for ever.
      GitOpsStore.getInstance().deleteCreateCheckpoint(app.id);
      return true;
    })();
  }

  private async finalizeLogicalDeletion(
    input: DeleteDeployedStackInput,
    intentId: string,
  ): Promise<DeleteDeployedStackResult> {
    const { nodeId, stackName } = input;
    const db = DatabaseService.getInstance();

    if (!this.commitDeletionReady(intentId, nodeId, stackName)) {
      return {
        ok: false,
        code: 'db_failed',
        error: 'Failed to commit stack deletion ready transaction',
      };
    }

    try {
      db.clearStackUpdateStatus(nodeId, stackName);
      db.clearStackScanAttempts(nodeId, stackName);
      db.deleteRoleAssignmentsByStack(nodeId, stackName);
      db.deleteGitSource(stackName);
      // R6: the managed-project area must not outlive the stack; failures are
      // logged inside, never fatal to the deletion.
      await GitProjectManifestService.getInstance().deleteManagedArea(stackName);
      db.deleteStackDossier(nodeId, stackName);
      db.deleteStackDriftFindings(nodeId, stackName);
      db.deleteStackExposureIntents(nodeId, stackName);
      db.deleteStackExposure(nodeId, stackName);
      db.deleteStackProjectEnvFiles(nodeId, stackName);
      db.deleteStackScans(nodeId, stackName);
      db.deleteNotificationsForStack(nodeId, stackName);
    } catch (dbErr) {
      console.error(
        '[DeployedStackDeletion] Secondary DB cleanup failed for %s; recovery rows already retired:',
        sanitizeForLog(stackName),
        dbErr,
      );
      return {
        ok: false,
        code: 'db_failed',
        error: getErrorMessage(dbErr, 'Failed to clear stack database state'),
      };
    }

    try {
      await MeshService.getInstance().optOutStack(nodeId, stackName, input.actor);
    } catch (meshErr) {
      console.warn(
        '[DeployedStackDeletion] Mesh opt-out failed for %s:',
        sanitizeForLog(stackName),
        meshErr,
      );
    }

    await this.sweepReadyIntent(intentId);
    NotificationService.getInstance().broadcastEvent({
      type: 'state-invalidate',
      scope: 'notifications',
      action: 'stack-deleted',
      nodeId,
      stackName,
      ts: Date.now(),
    });
    return { ok: true, status: 'deleted' };
  }

  /**
   * Remove rollback tags + override paths for a ready tombstone, then drop the row.
   * When the node row is already gone (local-node delete), pass a preserved local
   * Docker handle and composeDir so we never fall back to a remote default node.
   */
  public async sweepReadyIntent(
    intentId: string,
    opts?: { docker?: Docker; composeDir?: string },
  ): Promise<void> {
    const db = DatabaseService.getInstance();
    const intent = db.getCleanupPending(intentId);
    if (!intent || intent.status !== 'ready') return;
    if (intent.node_id == null) {
      db.deleteCleanupPending(intentId);
      return;
    }

    const tags = parseJsonStringArray(intent.rollback_tags_json);
    const overridePaths = parseJsonStringArray(intent.override_paths_json);

    let docker: Docker;
    if (opts?.docker) {
      docker = opts.docker;
    } else if (db.getNode(intent.node_id)) {
      docker = DockerController.getInstance(intent.node_id).getDocker();
    } else if (intent.target_kind === 'local_socket') {
      // Deleted local node: local_socket tombstones always target the host Docker socket.
      docker = new Docker();
    } else {
      console.warn(
        '[DeployedStackDeletion] Cannot sweep tombstone %s: node gone and target is not local_socket',
        sanitizeForLog(intentId),
      );
      return;
    }

    let incomplete = false;

    for (const tag of tags) {
      try {
        await docker.getImage(tag).remove({ force: true });
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        const message = getErrorMessage(error, 'unknown').toLowerCase();
        if (status === 404 || message.includes('no such image') || message.includes('not found')) {
          continue;
        }
        incomplete = true;
        console.warn(
          '[DeployedStackDeletion] Failed to remove rollback tag %s: %s',
          sanitizeForLog(tag),
          sanitizeForLog(getErrorMessage(error, 'unknown')),
        );
      }
    }

    const baseDir = opts?.composeDir
      ?? (db.getNode(intent.node_id)
        ? FileSystemService.getInstance(intent.node_id).getBaseDir()
        : null);

    const containmentBase = baseDir
      ? overrideDeletionContainmentBase(baseDir, intent.stack_name)
      : null;
    if (baseDir && !containmentBase) {
      incomplete = true;
      console.warn(
        '[DeployedStackDeletion] Refusing override sweep: invalid stack containment for tombstone %s',
        sanitizeForLog(intentId),
      );
    }

    for (const overridePath of overridePaths) {
      try {
        const resolved = path.resolve(overridePath);
        const basename = path.basename(resolved);
        if (!/^\.sencho-recovery-[a-f0-9]+\.yml$/i.test(basename)) {
          incomplete = true;
          console.warn(
            '[DeployedStackDeletion] Refusing to delete non-recovery override: %s',
            sanitizeForLog(overridePath),
          );
          continue;
        }
        if (containmentBase && !isPathWithinBase(resolved, containmentBase)) {
          incomplete = true;
          console.warn(
            '[DeployedStackDeletion] Refusing to delete override outside stack containment: %s',
            sanitizeForLog(overridePath),
          );
          continue;
        }
        if (!baseDir && !path.isAbsolute(resolved)) {
          incomplete = true;
          console.warn(
            '[DeployedStackDeletion] Refusing relative override without compose dir: %s',
            sanitizeForLog(overridePath),
          );
          continue;
        }
        if (!containmentBase && baseDir) {
          incomplete = true;
          continue;
        }
        await fs.unlink(resolved);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          incomplete = true;
          console.warn(
            '[DeployedStackDeletion] Failed to delete override %s: %s',
            sanitizeForLog(overridePath),
            sanitizeForLog(getErrorMessage(error, 'unknown')),
          );
        }
      }
    }

    // Keep the ready tombstone when cleanup is incomplete so startup can retry.
    if (!incomplete) {
      db.deleteCleanupPending(intentId);
    }
  }

  /** Enumerate rollback tags and override paths for every stack recovery on a node. */
  public collectNodeArtifacts(nodeId: number): { tags: string[]; overridePaths: string[] } {
    return collectArtifactsFromGenerations(
      DatabaseService.getInstance().listStackUpdateRecoveryGenerationsForNode(nodeId),
    );
  }

  /**
   * Remove a node and retire the GitOps targets that lived on it, together.
   *
   * The tombstones have to be written while the target rows still exist, and in
   * the same transaction as the delete, or a failure part-way through would
   * leave targets pointing at a node that is gone. Applications are left live:
   * a Direct application still describes a real stack, and a Blueprint one may
   * have targets on other nodes.
   *
   * Returns the Blueprints that lost a target here, so the caller can report
   * what the deletion moved. Read inside the transaction and before the
   * tombstone, because afterwards no active target row remains to trace back to
   * an application. Direct applications contribute nothing: they carry no
   * `blueprint_id`.
   */
  public deleteNodeWithGitOps(
    nodeId: number,
    localCleanup?: { tombstoneId: string; tags: string[]; overridePaths: string[] },
  ): number[] {
    const db = DatabaseService.getInstance();
    return db.getDb().transaction(() => {
      const store = GitOpsStore.getInstance();
      const blueprintIds: number[] = [];
      for (const target of store.listActiveTargetsForNode(nodeId)) {
        const application = store.getApplication(target.application_id);
        if (!application) {
          // No foreign key backs this column and the database runs without
          // cascade, so an orphaned target is possible, and this is the only
          // path that would ever look at one. Collapsing it into the Direct
          // case below would make a referential fault read as the normal
          // outcome. The tombstone still retires the row either way.
          console.error(
            '[DeployedStackDeletion] Orphaned GitOps target on node %s: application %s is missing.',
            sanitizeForLog(nodeId),
            sanitizeForLog(target.application_id),
          );
          continue;
        }
        if (application.blueprint_id !== null) blueprintIds.push(application.blueprint_id);
      }
      GitOpsTransitions.getInstance().tombstoneNodeTargets(nodeId, {
        operationId: localCleanup?.tombstoneId ?? randomUUID(),
        actor: 'system:node-deletion',
        trigger: 'node_delete',
        at: Date.now(),
      });
      db.deleteNode(nodeId, localCleanup);
      return blueprintIds;
    })();
  }

  /**
   * Delete a local-socket node with an atomic ready tombstone, then sweep.
   * Remote node records call DatabaseService.deleteNode without cleanup.
   */
  public async deleteLocalNode(nodeId: number): Promise<number[]> {
    const db = DatabaseService.getInstance();
    const node = db.getNode(nodeId);
    if (!node) throw new Error('Node not found');
    if (node.type !== 'local') {
      return this.deleteNodeWithGitOps(nodeId);
    }
    // Preserve Docker + compose dir before the row disappears so sweep never
    // targets a remote default node.
    const docker = DockerController.getInstance(nodeId).getDocker();
    const composeDir = FileSystemService.getInstance(nodeId).getBaseDir();
    const { tags, overridePaths } = this.collectNodeArtifacts(nodeId);
    const tombstoneId = randomUUID();
    const blueprintIds = this.deleteNodeWithGitOps(nodeId, { tombstoneId, tags, overridePaths });
    NodeRegistry.getInstance().evictConnection(nodeId);
    try {
      await this.sweepReadyIntent(tombstoneId, { docker, composeDir });
    } catch (error) {
      // Node row is already gone; leave the ready tombstone for startup resume.
      console.error(
        '[DeployedStackDeletion] Sweep after local-node delete deferred for tombstone %s: %s',
        sanitizeForLog(tombstoneId),
        sanitizeForLog(getErrorMessage(error, 'unknown')),
      );
    }
    return blueprintIds;
  }

  /**
   * Startup reconciliation: resume prepared intents, complete ready transitions
   * when the directory is already gone, and sweep ready tombstones.
   */
  public async reconcileAtStartup(): Promise<void> {
    const db = DatabaseService.getInstance();
    for (const intent of db.listPreparedCleanupPending()) {
      if (intent.node_id == null || !intent.stack_name) continue;
      const nodeId = intent.node_id;
      const stackName = intent.stack_name;
      const stackDir = path.join(FileSystemService.getInstance(nodeId).getBaseDir(), stackName);
      let dirExists = true;
      try {
        await fs.access(stackDir);
      } catch (accessError) {
        const code = (accessError as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          dirExists = false;
        } else {
          console.warn(
            '[DeployedStackDeletion] Startup access error for %s (not treating as absent): %s',
            sanitizeForLog(stackName),
            sanitizeForLog(getErrorMessage(accessError, 'unknown')),
          );
          continue;
        }
      }

      if (!dirExists) {
        if (!this.commitDeletionReady(intent.id, nodeId, stackName)) {
          console.warn(
            '[DeployedStackDeletion] Startup ready commit failed for %s/%s',
            nodeId,
            sanitizeForLog(stackName),
          );
          continue;
        }
        try {
          await MeshService.getInstance().optOutStack(nodeId, stackName, 'system:startup');
        } catch (meshErr) {
          console.warn(
            '[DeployedStackDeletion] Startup mesh opt-out failed for %s: %s',
            sanitizeForLog(stackName),
            sanitizeForLog(getErrorMessage(meshErr, 'unknown')),
          );
        }
        await this.sweepReadyIntent(intent.id);
        continue;
      }

      if (intent.required_blueprint_id != null) {
        const ownership = await probeBlueprintMarkerOwnership(
          nodeId,
          stackName,
          intent.required_blueprint_id,
        );
        if (ownership.kind === 'name_conflict') {
          db.updateCleanupPendingStatus(intent.id, 'cancelled');
          console.warn(
            '[DeployedStackDeletion] Startup cancelled blueprint deletion for %s: %s',
            sanitizeForLog(stackName),
            sanitizeForLog(ownership.error),
          );
          continue;
        }
        if (ownership.kind === 'failed') {
          console.warn(
            '[DeployedStackDeletion] Startup ownership probe failed for %s (leaving prepared): %s',
            sanitizeForLog(stackName),
            sanitizeForLog(ownership.error),
          );
          continue;
        }
      }

      const result = await this.deleteDeployedStack({
        nodeId,
        stackName,
        pruneVolumes: intent.prune_volumes_requested === 1,
        actor: 'system:startup',
        continuationIntentId: intent.id,
      });
      if (!result.ok) {
        console.warn(
          '[DeployedStackDeletion] Startup resume failed for %s: %s',
          sanitizeForLog(stackName),
          result.error,
        );
      }
    }

    for (const intent of db.listReadyCleanupPending()) {
      if (intent.node_id != null && intent.stack_name) {
        try {
          await MeshService.getInstance().optOutStack(intent.node_id, intent.stack_name, 'system:startup');
        } catch (meshErr) {
          console.warn(
            '[DeployedStackDeletion] Ready-resume mesh opt-out failed for %s: %s',
            sanitizeForLog(intent.stack_name),
            sanitizeForLog(getErrorMessage(meshErr, 'unknown')),
          );
        }
      }
      await this.sweepReadyIntent(intent.id);
    }
  }
}
