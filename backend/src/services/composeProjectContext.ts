/**
 * Thin Compose project context for safe full-stack updates.
 *
 * Wraps the current authored compose argument path and atomic file backup/restore.
 * When a richer shared Compose project context lands, migrate callers to that type;
 * this module must not become a competing full-manifest resolver.
 */
import path from 'path';
import { randomUUID } from 'crypto';
import { ComposeService } from './ComposeService';
import { FileSystemService } from './FileSystemService';
import { buildEffectiveServiceModel } from './effectiveServiceModel';
import { getErrorMessage } from '../utils/errors';

export type ImageReferenceKind = 'moving_tag' | 'digest_pinned' | 'none';

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
  backupSlotId: string | null;
  toComposeArgs(action: string[]): Promise<string[]>;
  validateForMutation(): Promise<void>;
  backupFromContext(operation: 'update' | 'deployment'): Promise<string>;
  restoreFromContext(): Promise<void>;
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

  async backupFromContext(_operation: 'update' | 'deployment'): Promise<string> {
    await FileSystemService.getInstance(this.nodeId).backupStackFiles(this.stackName);
    const slotId = randomUUID();
    this.backupSlotId = slotId;
    return slotId;
  }

  async restoreFromContext(): Promise<void> {
    await FileSystemService.getInstance(this.nodeId).restoreStackFiles(this.stackName);
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

export function describeContextError(error: unknown): string {
  return getErrorMessage(error, 'Compose project context failed');
}
