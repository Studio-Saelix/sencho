import crypto from 'crypto';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import type { ComposeInputEntry } from '../../../types/gitProjectManifest';
import type { OverlayBinding } from './types';
import { decryptSopsAgeDocument, SopsDecryptError } from './decode';
import { isValidRelativeStackPath, isValidStackName } from '../../../utils/validation';
import { NodeRegistry } from '../../NodeRegistry';

const OVERLAY_ROOT = 'git-secrets';
const OVERLAY_OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertSafeNodeId(nodeId: number): void {
  if (!Number.isInteger(nodeId) || nodeId <= 0) {
    throw new Error('Invalid overlay node id');
  }
}

function validatedStackSegment(stackName: string): string {
  const safe = path.basename(stackName);
  if (safe !== stackName || !isValidStackName(safe)) {
    throw new Error('Invalid overlay stack name');
  }
  return safe;
}

function validatedOperationSegment(operationId: string): string {
  const safe = path.basename(operationId);
  if (safe !== operationId || !OVERLAY_OPERATION_ID_RE.test(safe)) {
    throw new Error('Invalid overlay operation id');
  }
  return safe;
}

function assertBindingFields(binding: OverlayBinding): void {
  assertSafeNodeId(binding.nodeId);
  validatedStackSegment(binding.stackName);
  validatedOperationSegment(binding.operationId);
}

export class GitOpsDecryptOverlay {
  private static instance: GitOpsDecryptOverlay | null = null;

  static getInstance(): GitOpsDecryptOverlay {
    if (!this.instance) this.instance = new GitOpsDecryptOverlay();
    return this.instance;
  }

  static resetForTests(): void {
    GitOpsDecryptOverlay.instance = null;
  }

  private rootDir(): string {
    return path.join(process.env.DATA_DIR || path.join(process.cwd(), 'data'), OVERLAY_ROOT);
  }

  private resolveOverlayDir(nodeId: number, stackName: string, operationId: string): string {
    assertSafeNodeId(nodeId);
    const safeStack = validatedStackSegment(stackName);
    const safeOperationId = validatedOperationSegment(operationId);
    const secretsRoot = path.resolve(this.rootDir());
    const overlayDir = path.resolve(secretsRoot, String(nodeId), safeStack, safeOperationId);
    // Inline js/path-injection barrier at every caller before a filesystem sink.
    if (!overlayDir.startsWith(secretsRoot + path.sep)) {
      throw new Error('Overlay path escapes the git-secrets root');
    }
    return overlayDir;
  }

  private resolveAllowedSourceRoot(nodeId: number, stackName: string, sourceRootArg: string): string {
    assertSafeNodeId(nodeId);
    const safeStack = validatedStackSegment(stackName);
    const requested = path.resolve(sourceRootArg);
    const composeStackRoot = path.resolve(NodeRegistry.getInstance().getComposeDir(nodeId), safeStack);
    const dataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
    const managedStackRoot = path.resolve(dataDir, 'git-managed', String(nodeId), safeStack);
    for (const base of [composeStackRoot, managedStackRoot]) {
      if (requested === base || requested.startsWith(base + path.sep)) {
        return requested;
      }
    }
    throw new Error('Overlay source root is not an allowed stack tree');
  }

  overlayPath(nodeId: number, stackName: string, operationId: string): string {
    return this.resolveOverlayDir(nodeId, stackName, operationId);
  }

  assertBinding(overlayDir: string, binding: OverlayBinding): void {
    assertBindingFields(binding);
    const expected = this.resolveOverlayDir(binding.nodeId, binding.stackName, binding.operationId);
    const resolved = path.resolve(overlayDir);
    const secretsRoot = path.resolve(this.rootDir());
    if (!resolved.startsWith(secretsRoot + path.sep)) {
      throw new Error('Overlay directory escapes the git-secrets root');
    }
    if (resolved !== expected) {
      throw new Error('Overlay directory does not match the bound operation');
    }
    const metaPath = path.join(resolved, '.sencho-overlay.json');
    const metaResolved = path.resolve(metaPath);
    if (!metaResolved.startsWith(resolved + path.sep)) {
      throw new Error('Overlay metadata path escapes the overlay directory');
    }
    if (!fs.existsSync(metaResolved)) {
      throw new Error('Overlay metadata is missing');
    }
    const meta = JSON.parse(fs.readFileSync(metaResolved, 'utf8')) as OverlayBinding;
    if (
      meta.applicationId !== binding.applicationId
      || meta.commitSha !== binding.commitSha
      || meta.generationId !== binding.generationId
      || meta.operationId !== binding.operationId
      || meta.stackName !== binding.stackName
      || meta.nodeId !== binding.nodeId
    ) {
      throw new Error('Overlay binding mismatch');
    }
  }

  async buildFromTree(args: {
    sourceRoot: string;
    binding: OverlayBinding;
    inputs: ComposeInputEntry[];
    identityByRecipient: Map<string, string>;
  }): Promise<string> {
    assertBindingFields(args.binding);
    const overlayDir = this.resolveOverlayDir(
      args.binding.nodeId,
      args.binding.stackName,
      args.binding.operationId,
    );
    const sourceRoot = this.resolveAllowedSourceRoot(
      args.binding.nodeId,
      args.binding.stackName,
      args.sourceRoot,
    );
    if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
      throw new Error('Overlay source root is missing');
    }

    await this.destroy(args.binding.nodeId, args.binding.stackName, args.binding.operationId);

    const secretsRoot = path.resolve(this.rootDir());
    const overlayResolved = path.resolve(overlayDir);
    if (!overlayResolved.startsWith(secretsRoot + path.sep)) {
      throw new Error('Overlay path escapes the git-secrets root');
    }
    await fsPromises.mkdir(overlayResolved, { recursive: true, mode: 0o700 });
    await fsPromises.chmod(overlayResolved, 0o700);

    await this.copyTree(sourceRoot, overlayResolved);

    const metaPath = path.join(overlayResolved, '.sencho-overlay.json');
    const metaResolved = path.resolve(metaPath);
    if (!metaResolved.startsWith(overlayResolved + path.sep)) {
      throw new Error('Overlay metadata path escapes the overlay directory');
    }
    await fsPromises.writeFile(metaResolved, JSON.stringify({
      applicationId: args.binding.applicationId,
      commitSha: args.binding.commitSha,
      generationId: args.binding.generationId,
      operationId: validatedOperationSegment(args.binding.operationId),
      stackName: validatedStackSegment(args.binding.stackName),
      nodeId: args.binding.nodeId,
    } satisfies OverlayBinding), { mode: 0o600 });

    try {
      for (const input of args.inputs) {
        if (input.encryption !== 'sops-age' || !input.materializedPath || !input.sourcePath) continue;
        const rel = input.materializedPath.replace(/\\/g, '/');
        if (!isValidRelativeStackPath(rel)) {
          throw new Error('Invalid overlay materialized path');
        }
        const target = path.resolve(overlayResolved, rel);
        if (!target.startsWith(overlayResolved + path.sep)) {
          throw new Error('Invalid overlay materialized path');
        }
        const ciphertext = await fsPromises.readFile(target, 'utf8');
        const recipients = input.sopsRecipients ?? [];
        let decrypted: string | null = null;
        let lastErr: unknown = null;
        for (const recipient of recipients) {
          const identity = args.identityByRecipient.get(recipient);
          if (!identity) continue;
          try {
            decrypted = await decryptSopsAgeDocument(ciphertext, identity);
            break;
          } catch (err) {
            lastErr = err;
          }
        }
        if (decrypted === null) {
          if (lastErr instanceof SopsDecryptError) throw lastErr;
          throw new SopsDecryptError('wrong_identity', 'No age identity matches the encrypted input');
        }
        await fsPromises.writeFile(target, decrypted, { mode: 0o600 });
      }

      return overlayResolved;
    } catch (err) {
      await this.destroy(args.binding.nodeId, args.binding.stackName, args.binding.operationId);
      throw err;
    }
  }

  async destroy(nodeId: number, stackName: string, operationId: string): Promise<void> {
    const overlayDir = this.resolveOverlayDir(nodeId, stackName, operationId);
    const secretsRoot = path.resolve(this.rootDir());
    const overlayResolved = path.resolve(overlayDir);
    if (!overlayResolved.startsWith(secretsRoot + path.sep)) {
      throw new Error('Overlay path escapes the git-secrets root');
    }
    await fsPromises.rm(overlayResolved, { recursive: true, force: true });
  }

  async sweepStale(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
    const secretsRoot = path.resolve(this.rootDir());
    if (!fs.existsSync(secretsRoot)) return 0;
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    const walk = async (dir: string): Promise<void> => {
      const resolvedDir = path.resolve(dir);
      if (!resolvedDir.startsWith(secretsRoot + path.sep) && resolvedDir !== secretsRoot) return;
      const entries = await fsPromises.readdir(resolvedDir, { withFileTypes: true });
      for (const entry of entries) {
        const safeName = path.basename(entry.name);
        if (safeName !== entry.name) continue;
        const full = path.join(resolvedDir, safeName);
        const fullResolved = path.resolve(full);
        if (!fullResolved.startsWith(secretsRoot + path.sep)) continue;
        if (entry.isDirectory()) {
          const metaPath = path.join(fullResolved, '.sencho-overlay.json');
          const metaResolved = path.resolve(metaPath);
          if (metaResolved.startsWith(fullResolved + path.sep) && fs.existsSync(metaResolved)) {
            const stat = await fsPromises.stat(fullResolved);
            if (stat.mtimeMs < cutoff) {
              await fsPromises.rm(fullResolved, { recursive: true, force: true });
              removed += 1;
              continue;
            }
          }
          await walk(fullResolved);
        }
      }
    };
    await walk(secretsRoot);
    return removed;
  }

  private async copyTree(srcRoot: string, destRoot: string): Promise<void> {
    const srcBase = path.resolve(srcRoot);
    const destBase = path.resolve(destRoot);
    const secretsRoot = path.resolve(this.rootDir());
    if (!destBase.startsWith(secretsRoot + path.sep)) {
      throw new Error('Overlay destination escapes the git-secrets root');
    }

    const copyRecursive = async (src: string, dest: string): Promise<void> => {
      const resolvedSrc = path.resolve(src);
      const resolvedDest = path.resolve(dest);
      if (!resolvedSrc.startsWith(srcBase + path.sep) && resolvedSrc !== srcBase) {
        throw new Error('Overlay source path escapes the source root');
      }
      if (!resolvedDest.startsWith(destBase + path.sep) && resolvedDest !== destBase) {
        throw new Error('Overlay destination path escapes the overlay directory');
      }
      const entries = await fsPromises.readdir(resolvedSrc, { withFileTypes: true });
      await fsPromises.mkdir(resolvedDest, { recursive: true });
      for (const entry of entries) {
        const safeName = path.basename(entry.name);
        if (safeName !== entry.name) continue;
        const srcPath = path.join(resolvedSrc, safeName);
        const destPath = path.join(resolvedDest, safeName);
        const srcResolved = path.resolve(srcPath);
        const destResolved = path.resolve(destPath);
        if (!srcResolved.startsWith(srcBase + path.sep) && srcResolved !== srcBase) continue;
        if (!destResolved.startsWith(destBase + path.sep)) continue;
        if (entry.isDirectory()) {
          await copyRecursive(srcResolved, destResolved);
        } else if (entry.isFile()) {
          await fsPromises.copyFile(srcResolved, destResolved);
          await fsPromises.chmod(destResolved, 0o600);
        }
      }
    };

    await copyRecursive(srcBase, destBase);
  }
}

export function scrubOverlayPaths(message: string, dataDir: string): string {
  const overlayRoot = path.join(dataDir, OVERLAY_ROOT);
  return message.split(overlayRoot).join('[git-secrets-overlay]');
}

export function newOverlayOperationId(): string {
  return crypto.randomUUID();
}
