/**
 * Shared Compose project context for safe full-stack mutations.
 *
 * Resolves the authored inventory (Git managed-project manifest or live stack
 * discovery), captures/restores generation content through RollbackGenerationStore,
 * and builds the exact Compose invocation used for deploy/update/rollback.
 */
import path from 'path';
import { randomUUID } from 'crypto';
import { ComposeService } from './ComposeService';
import { FileSystemService } from './FileSystemService';
import { buildEffectiveServiceModel } from './effectiveServiceModel';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';
import { resolveRollbackInventory } from './rollbackInventory';
import { RollbackGenerationStore } from './RollbackGenerationStore';
import type {
  RollbackGenerationManifest,
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

    const present = await RollbackGenerationStore.verifyGenerationContent(
      this.nodeId,
      this.stackName,
      generationId,
    );
    if (!present) {
      throw Object.assign(
        new Error('Recovery generation content is missing or incomplete'),
        { code: 'GENERATION_CONTENT_MISSING' },
      );
    }

    const inventory = await resolveRollbackInventory(this.nodeId, this.stackName);
    // The live uncaptured paths travel with the entries: they are the managed
    // inputs this generation cannot hold, and a restore that never saw them
    // would leave a link created after capture in place and read its target.
    return RollbackGenerationStore.restoreGeneration(
      this.nodeId,
      this.stackName,
      generationId,
      [
        ...inventory.entries.map((e) => e.relativePath),
        ...inventory.uncapturedRelativePaths,
      ],
      transactionMeta,
    );
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
