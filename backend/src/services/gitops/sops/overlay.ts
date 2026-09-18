import crypto from 'crypto';
import fs from 'fs';
import { promises as fsPromises } from 'fs';
import path from 'path';
import type { ComposeInputEntry } from '../../../types/gitProjectManifest';
import type { OverlayBinding } from './types';
import { decryptSopsAgeDocument, SopsDecryptError } from './decode';
import { isPathWithinBase } from '../../../utils/validation';

const OVERLAY_ROOT = 'git-secrets';

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

  overlayPath(nodeId: number, stackName: string, operationId: string): string {
    return path.join(this.rootDir(), String(nodeId), stackName, operationId);
  }

  assertBinding(overlayDir: string, binding: OverlayBinding): void {
    const expected = this.overlayPath(binding.nodeId, binding.stackName, binding.operationId);
    const resolved = path.resolve(overlayDir);
    if (resolved !== path.resolve(expected)) {
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
    const overlayDir = this.overlayPath(args.binding.nodeId, args.binding.stackName, args.binding.operationId);
    await this.destroy(args.binding.nodeId, args.binding.stackName, args.binding.operationId);
    await fsPromises.mkdir(overlayDir, { recursive: true, mode: 0o700 });
    await fsPromises.chmod(overlayDir, 0o700);

    await this.copyTree(args.sourceRoot, overlayDir);

    const metaPath = path.join(overlayDir, '.sencho-overlay.json');
    await fsPromises.writeFile(metaPath, JSON.stringify(args.binding), { mode: 0o600 });

    try {
      for (const input of args.inputs) {
        if (input.encryption !== 'sops-age' || !input.materializedPath || !input.sourcePath) continue;
        const rel = input.materializedPath.replace(/\\/g, '/');
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
    const overlayDir = this.overlayPath(nodeId, stackName, operationId);
    await fsPromises.rm(overlayDir, { recursive: true, force: true });
  }

  async sweepStale(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
    const root = this.rootDir();
    if (!fs.existsSync(root)) return 0;
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    const walk = async (dir: string): Promise<void> => {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
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

  private async copyTree(src: string, dest: string): Promise<void> {
    const entries = await fsPromises.readdir(src, { withFileTypes: true });
    await fsPromises.mkdir(dest, { recursive: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        await this.copyTree(srcPath, destPath);
      } else if (entry.isFile()) {
        await fsPromises.copyFile(srcPath, destPath);
        await fsPromises.chmod(destPath, 0o600);
      }
    }
  }
}

export function scrubOverlayPaths(message: string, dataDir: string): string {
  const overlayRoot = path.join(dataDir, OVERLAY_ROOT);
  return message.split(overlayRoot).join('[git-secrets-overlay]');
}

export function newOverlayOperationId(): string {
  return crypto.randomUUID();
}
