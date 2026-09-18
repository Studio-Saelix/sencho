import crypto from 'crypto';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import type { ComposeInputEntry } from '../../../types/gitProjectManifest';
import type { OverlayBinding } from './types';
import { decryptSopsAgeDocument, SopsDecryptError } from './decode';
import { isPathWithinBase, isValidStackName } from '../../../utils/validation';

const OVERLAY_ROOT = 'git-secrets';
const OVERLAY_OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertSafeNodeId(nodeId: number): void {
  if (!Number.isInteger(nodeId) || nodeId <= 0) {
    throw new Error('Invalid overlay node id');
  }
}

function assertSafeOverlayOperationId(operationId: string): void {
  if (!OVERLAY_OPERATION_ID_RE.test(operationId)) {
    throw new Error('Invalid overlay operation id');
  }
}

function assertSafeOverlayStackName(stackName: string): void {
  if (!isValidStackName(stackName)) {
    throw new Error('Invalid overlay stack name');
  }
}

function assertBindingFields(binding: OverlayBinding): void {
  assertSafeNodeId(binding.nodeId);
  assertSafeOverlayStackName(binding.stackName);
  assertSafeOverlayOperationId(binding.operationId);
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
    assertSafeOverlayStackName(stackName);
    assertSafeOverlayOperationId(operationId);
    const root = path.resolve(this.rootDir());
    const overlayDir = path.resolve(root, String(nodeId), stackName, operationId);
    if (!isPathWithinBase(overlayDir, root)) {
      throw new Error('Overlay path escapes the git-secrets root');
    }
    return overlayDir;
  }

  overlayPath(nodeId: number, stackName: string, operationId: string): string {
    return this.resolveOverlayDir(nodeId, stackName, operationId);
  }

  assertBinding(overlayDir: string, binding: OverlayBinding): void {
    assertBindingFields(binding);
    const expected = this.resolveOverlayDir(binding.nodeId, binding.stackName, binding.operationId);
    const resolved = path.resolve(overlayDir);
    const root = path.resolve(this.rootDir());
    if (!isPathWithinBase(resolved, root)) {
      throw new Error('Overlay directory escapes the git-secrets root');
    }
    if (resolved !== expected) {
      throw new Error('Overlay directory does not match the bound operation');
    }
    const metaPath = path.join(resolved, '.sencho-overlay.json');
    if (!fs.existsSync(metaPath)) {
      throw new Error('Overlay metadata is missing');
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as OverlayBinding;
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
    const sourceRoot = path.resolve(args.sourceRoot);
    if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
      throw new Error('Overlay source root is missing');
    }

    await this.destroy(args.binding.nodeId, args.binding.stackName, args.binding.operationId);
    await fsPromises.mkdir(overlayDir, { recursive: true, mode: 0o700 });
    await fsPromises.chmod(overlayDir, 0o700);

    await this.copyTree(sourceRoot, overlayDir);

    const metaPath = path.join(overlayDir, '.sencho-overlay.json');
    await fsPromises.writeFile(metaPath, JSON.stringify(args.binding), { mode: 0o600 });

    try {
      for (const input of args.inputs) {
        if (input.encryption !== 'sops-age' || !input.materializedPath || !input.sourcePath) continue;
        const rel = input.materializedPath.replace(/\\/g, '/');
        if (!rel || rel.includes('\0') || rel.startsWith('/') || rel.includes('..')) {
          throw new Error('Invalid overlay materialized path');
        }
        const target = path.resolve(overlayDir, rel);
        if (!isPathWithinBase(target, overlayDir)) {
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

      return overlayDir;
    } catch (err) {
      await this.destroy(args.binding.nodeId, args.binding.stackName, args.binding.operationId);
      throw err;
    }
  }

  async destroy(nodeId: number, stackName: string, operationId: string): Promise<void> {
    const overlayDir = this.resolveOverlayDir(nodeId, stackName, operationId);
    await fsPromises.rm(overlayDir, { recursive: true, force: true });
  }

  async sweepStale(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
    const root = path.resolve(this.rootDir());
    if (!fs.existsSync(root)) return 0;
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    const walk = async (dir: string): Promise<void> => {
      const resolvedDir = path.resolve(dir);
      if (!isPathWithinBase(resolvedDir, root)) return;
      const entries = await fsPromises.readdir(resolvedDir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(resolvedDir, entry.name);
        if (!isPathWithinBase(full, root)) continue;
        if (entry.isDirectory()) {
          const metaPath = path.join(full, '.sencho-overlay.json');
          if (fs.existsSync(metaPath)) {
            const stat = await fsPromises.stat(full);
            if (stat.mtimeMs < cutoff) {
              await fsPromises.rm(full, { recursive: true, force: true });
              removed += 1;
              continue;
            }
          }
          await walk(full);
        }
      }
    };
    await walk(root);
    return removed;
  }

  private async copyTree(srcRoot: string, destRoot: string): Promise<void> {
    const srcBase = path.resolve(srcRoot);
    const destBase = path.resolve(destRoot);
    if (!isPathWithinBase(destBase, path.resolve(this.rootDir()))) {
      throw new Error('Overlay destination escapes the git-secrets root');
    }

    const copyRecursive = async (src: string, dest: string): Promise<void> => {
      const resolvedSrc = path.resolve(src);
      const resolvedDest = path.resolve(dest);
      if (!isPathWithinBase(resolvedSrc, srcBase)) {
        throw new Error('Overlay source path escapes the source root');
      }
      if (!isPathWithinBase(resolvedDest, destBase)) {
        throw new Error('Overlay destination path escapes the overlay directory');
      }
      const entries = await fsPromises.readdir(resolvedSrc, { withFileTypes: true });
      await fsPromises.mkdir(resolvedDest, { recursive: true });
      for (const entry of entries) {
        const srcPath = path.join(resolvedSrc, entry.name);
        const destPath = path.join(resolvedDest, entry.name);
        if (entry.isDirectory()) {
          await copyRecursive(srcPath, destPath);
        } else if (entry.isFile()) {
          await fsPromises.copyFile(srcPath, destPath);
          await fsPromises.chmod(destPath, 0o600);
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
