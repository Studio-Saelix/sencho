/**
 * Shared Compose project context for safe full-stack mutations.
 *
 * Resolves the authored inventory (Git managed-project manifest or live stack
 * discovery), captures/restores generation content through RollbackGenerationStore,
 * and builds the exact Compose invocation used for deploy/update/rollback.
 */
import path from 'path';
import { promises as fsPromises } from 'fs';
import { randomUUID } from 'crypto';
import { ComposeService } from './ComposeService';
import { FileSystemService } from './FileSystemService';
import { buildEffectiveServiceModel } from './effectiveServiceModel';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';
import { lexicalComposePath } from '../utils/authoredComposeArgs';
import {
  isApplicationDataKind,
  recoveryInvocationEnvFiles,
  resolveRollbackInventory,
} from './rollbackInventory';
import { RollbackGenerationStore } from './RollbackGenerationStore';
import type {
  RollbackGenerationManifest,
  RollbackInvocationRecord,
  RollbackOperationKind,
  RollbackRestoreTransactionMeta,
} from '../types/rollbackGeneration';

export type ImageReferenceKind = 'moving_tag' | 'digest_pinned' | 'none';

export type BackupOperation = RollbackOperationKind;

const DIGEST_PIN_PATTERN = /@sha256:[a-f0-9]{64}$/i;

export function classifyReferenceKind(declaredImageRef: string | null): ImageReferenceKind {
  if (!declaredImageRef) return 'none';
  if (DIGEST_PIN_PATTERN.test(declaredImageRef)) return 'digest_pinned';
  return 'moving_tag';
}

async function requireRenderableModel(nodeId: number, stackName: string) {
  const model = await buildEffectiveServiceModel(nodeId, stackName);
  if (!model.renderable) {
    throw new Error(model.error || 'Effective Compose model failed to render');
  }
  return model;
}

export interface ComposeProjectContext {
  readonly nodeId: number;
  readonly stackName: string;
  readonly stackDir: string;
  /** Generation id used as content-store key and backup_slot_id on the DB row. */
  backupSlotId: string | null;
  toComposeArgs(action: string[]): Promise<string[]>;
  validateForMutation(): Promise<void>;
  /**
   * Capture a staged generation. Throws ROLLBACK_COVERAGE_UNAVAILABLE (message
   * prefixed "Rollback coverage is unavailable: ") before writing any generation
   * content when the inventory has a coverage refusal. Inputs the inventory lists
   * as uncaptured do not refuse: the generation holds everything else, records
   * them, and a log line names them.
   */
  backupFromContext(operation: BackupOperation): Promise<string>;
  restoreFromContext(
    transactionMeta?: RollbackRestoreTransactionMeta,
  ): Promise<RollbackGenerationManifest | void>;
  resolveServiceImageMap(): Promise<Map<string, string | null>>;
}

class AuthoredComposeProjectContext implements ComposeProjectContext {
  backupSlotId: string | null = null;

  constructor(
    readonly nodeId: number,
    readonly stackName: string,
    readonly stackDir: string,
  ) {}

  async toComposeArgs(action: string[]): Promise<string[]> {
    return ComposeService.getInstance(this.nodeId).buildAuthoredComposeArgs(this.stackName, action);
  }

  async validateForMutation(): Promise<void> {
    await ComposeService.getInstance(this.nodeId).validateStackForMutation(this.stackName);
    await requireRenderableModel(this.nodeId, this.stackName);
  }

  async backupFromContext(operation: BackupOperation): Promise<string> {
    const inventory = await resolveRollbackInventory(this.nodeId, this.stackName);
    if (inventory.coverageRefusal !== null) {
      throw Object.assign(
        new Error(`Rollback coverage is unavailable: ${inventory.coverageRefusal}`),
        { code: 'ROLLBACK_COVERAGE_UNAVAILABLE' },
      );
    }
    // Do not refresh the legacy single-slot backup. Clearing that reused slot
    // would destroy a pre-migration recovery point if a later capture step fails.

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: this.nodeId,
      stackName: this.stackName,
      generationId,
      inventory,
      operationKind: operation,
    });
    if (inventory.uncapturedInputs.length > 0) {
      console.warn(
        `[ComposeProjectContext] Recovery generation ${generationId} for ${sanitizeForLog(this.stackName)} is partial, a rollback uses the current content of these inputs: ${sanitizeForLog(inventory.uncapturedInputs.join('; '))}`,
      );
    }
    this.backupSlotId = generationId;
    return generationId;
  }

  async restoreFromContext(
    transactionMeta?: RollbackRestoreTransactionMeta,
  ): Promise<RollbackGenerationManifest | void> {
    const generationId = this.backupSlotId;
    if (!generationId) {
      // Legacy pre-migration restore: only when no generation id is bound.
      await FileSystemService.getInstance(this.nodeId).restoreStackFiles(this.stackName);
      return;
    }

    const generation = await this.loadGeneration(generationId);
    // Recovery launches the generation's own invocation, so the env files it
    // reads are the ones that can make the run unusable. A live selection those
    // files replace is not an input of this rollback.
    await this.assertRecoveryEnvInputs(generation.invocation);

    const inventory = await resolveRollbackInventory(this.nodeId, this.stackName);
    // The live managed paths travel with the entries: they are the inputs this
    // generation cannot hold or no longer holds, and a restore that never saw
    // them would leave a link created after capture in place and read its
    // target. Application data and build inputs are not managed paths, so
    // neither their omissions nor their live entries travel: a path any live
    // input declares as application data never becomes a cleanup candidate,
    // even when another input also uses it as a managed file, and a data file
    // or link that appears after capture survives the restore. A captured
    // entry at such a path is still a held file the restore writes back.
    const applicationData = new Set(inventory.applicationDataPaths);
    return RollbackGenerationStore.restoreGeneration(
      this.nodeId,
      this.stackName,
      generationId,
      [
        ...inventory.entries
          .filter((entry) => !applicationData.has(entry.relativePath)
            && !isApplicationDataKind(entry.dependencyKind))
          .map((entry) => entry.relativePath),
        ...inventory.uncapturedRelativePaths.filter((rel) => !applicationData.has(rel)),
      ],
      transactionMeta,
      // A generation captured before it recorded dynamic application-data
      // sources still gets the safe behaviour: if the live project has one, the
      // resolved path is unknown and restore must delete nothing. A refused
      // live inventory clears its application-data records too, so it cannot
      // establish which live paths are safe to delete either. An unusable live
      // interpolation selection leaves the same gap even when the generation's
      // own invocation never reads it: the live project is not fully known, so
      // nothing unrecorded is deleted on that evidence.
      inventory.dynamicApplicationDataSources.length > 0
        || inventory.coverageRefusal !== null
        || inventory.recoveryRefusal !== null,
      // A selected COMPOSE_FILE layer or an outside include/extends source was
      // never parsed for declarations, so the live project cannot prove any
      // path is disposable even when the stored generation was complete. The
      // restore deletes nothing; the generation still restores its own files.
      inventory.unparsedComposeSources.length > 0,
      // A path the live project uses for application data is never a cleanup
      // candidate, even when the generation carries a tombstone for the same
      // name from a managed role it held at capture. A directory bind extends
      // that rule to everything beneath it.
      inventory.applicationDataPaths,
      inventory.applicationDataPathPrefixes,
    );
  }

  /**
   * The generation with every held byte verified, or the one
   * GENERATION_CONTENT_MISSING contract callers already handle: a restore that
   * cannot trust the bytes never writes them.
   */
  private async loadGeneration(generationId: string): Promise<RollbackGenerationManifest> {
    try {
      return await RollbackGenerationStore.readVerifiedGeneration(
        this.nodeId,
        this.stackName,
        generationId,
      );
    } catch (cause) {
      throw Object.assign(
        new Error('Recovery generation content is missing or incomplete', { cause }),
        { code: 'GENERATION_CONTENT_MISSING' },
      );
    }
  }

  /**
   * Refuse before any project file moves when an env file the stored invocation
   * reads for interpolation is not a regular file: Compose would wait on a FIFO
   * or fail on a directory instead of naming the input, and a restore that moved
   * the project first would leave it written but unlaunchable. The check stats
   * the target Compose opens, which follows a link and never blocks on a FIFO or
   * a socket, so a link out of the compose root to one is refused here too. A
   * missing file is an ordinary run Compose reports itself, and a
   * stored-invocation path outside the compose root is refused by the captured
   * invocation validation before Compose starts.
   */
  private async assertRecoveryEnvInputs(invocation: RollbackInvocationRecord): Promise<void> {
    const base = path.resolve(FileSystemService.getInstance(this.nodeId).getBaseDir());
    const projectEnv = path.resolve(this.stackDir, '.env');
    for (const input of recoveryInvocationEnvFiles(invocation, this.stackDir)) {
      // A captured spelling may sit under a linked compose root's physical
      // path. Map it onto the lexical root the same way the inventory does.
      let checkPath: string;
      try {
        checkPath = await lexicalComposePath(this.nodeId, input.absolutePath);
      } catch {
        checkPath = input.absolutePath;
      }
      // Inline barrier at the stat sink: a stored-invocation path is only
      // classified inside the compose root. A path COMPOSE_ENV_FILES named is
      // the operator's own environment value, the same one handed to the child,
      // and Compose reads it wherever it points, so the spawn guard classifies
      // that one outside the root too.
      const target = path.resolve(checkPath);
      if (!input.fromProcessEnv && !target.startsWith(base + path.sep)) continue;
      let stats;
      try {
        stats = await fsPromises.stat(target);
      } catch {
        // A file this reader cannot inspect is left to the recovery run and to
        // Compose, which both name what they cannot open.
        continue;
      }
      if (stats.isFile()) continue;
      const named = target === projectEnv
        ? 'The project .env'
        : `The env file ${path.basename(target)}`;
      throw Object.assign(
        new Error(`${named} is not a regular file, so Compose cannot read it for interpolation`),
        { code: 'NOT_A_FILE' },
      );
    }
  }

  async resolveServiceImageMap(): Promise<Map<string, string | null>> {
    const model = await requireRenderableModel(this.nodeId, this.stackName);
    const map = new Map<string, string | null>();
    for (const svc of model.services) {
      map.set(svc.name, svc.declaredImage);
    }
    return map;
  }
}

export async function resolveComposeProjectContext(
  nodeId: number,
  stackName: string,
): Promise<ComposeProjectContext> {
  const stackDir = path.join(FileSystemService.getInstance(nodeId).getBaseDir(), stackName);
  return new AuthoredComposeProjectContext(nodeId, stackName, stackDir);
}

/** Bind an existing generation id onto a fresh context for restore. */
export async function resolveComposeProjectContextForGeneration(
  nodeId: number,
  stackName: string,
  generationId: string,
): Promise<ComposeProjectContext> {
  const ctx = await resolveComposeProjectContext(nodeId, stackName);
  ctx.backupSlotId = generationId;
  return ctx;
}

export function describeContextError(error: unknown): string {
  return getErrorMessage(error, 'Compose project context failed');
}
