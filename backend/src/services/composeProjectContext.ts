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
import { resolveRollbackInventory } from './rollbackInventory';
import { RollbackGenerationStore } from './RollbackGenerationStore';
import type { RollbackGenerationManifest, RollbackOperationKind } from '../types/rollbackGeneration';

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
   * Capture a staged generation. When exactCoverage is required and inventory
   * refuses it, throws before writing any generation content.
   */
  backupFromContext(operation: BackupOperation): Promise<string>;
  restoreFromContext(): Promise<RollbackGenerationManifest | void>;
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
    if (!inventory.exactCoverage) {
      throw Object.assign(
        new Error(
          inventory.coverageRefusal
            || 'Exact authored-project rollback coverage is unavailable for this stack',
        ),
        { code: 'ROLLBACK_COVERAGE_UNAVAILABLE' },
      );
    }

    // Also refresh the legacy single-slot backup for read-compat during migration.
    try {
      await FileSystemService.getInstance(this.nodeId).backupStackFiles(this.stackName);
    } catch (e) {
      console.warn(
        `[ComposeProjectContext] Legacy backup slot refresh failed for ${this.stackName}:`,
        getErrorMessage(e, 'unknown'),
      );
    }

    const generationId = randomUUID();
    await RollbackGenerationStore.captureGeneration({
      nodeId: this.nodeId,
      stackName: this.stackName,
      generationId,
      inventory,
      operationKind: operation,
    });
    this.backupSlotId = generationId;
    return generationId;
  }

  async restoreFromContext(): Promise<RollbackGenerationManifest | void> {
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
    return RollbackGenerationStore.restoreGeneration(
      this.nodeId,
      this.stackName,
      generationId,
      inventory.entries.map((e) => e.relativePath),
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
