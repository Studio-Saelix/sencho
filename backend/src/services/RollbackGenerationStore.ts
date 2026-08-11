/**
 * On-disk content store for authored-project rollback generations.
 *
 * Layout under <DATA_DIR>/backups/<nodeId>/<stackName>/generations/<id>/:
 *   generation.json  - RollbackGenerationManifest (checksums + metadata)
 *   files/           - tree mirroring stack-relative paths (ciphertext when encrypted)
 *
 * The DB row remains the listing / CURRENT pointer authority. This module only
 * owns generation content directories.
 */
import { createHash, randomUUID } from 'crypto';
import { promises as fsPromises } from 'fs';
import path from 'path';
import { CryptoService } from './CryptoService';
import { FileSystemService } from './FileSystemService';
import { isValidStackName } from '../utils/validation';
import {
  ROLLBACK_GENERATION_SCHEMA_VERSION,
  type ResolvedRollbackInventory,
  type RollbackGenerationEntry,
  type RollbackGenerationManifest,
  type RollbackImageIdentity,
  type RollbackOperationKind,
} from '../types/rollbackGeneration';

const GENERATION_JSON = 'generation.json';
const FILES_DIR = 'files';

function getDataDir(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function getBackupBaseDir(): string {
  return path.join(getDataDir(), 'backups');
}

function posixRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\.\//, '');
}

function caseKey(rel: string): string {
  return posixRel(rel).toLowerCase();
}

function assertSafeGenerationId(generationId: string): void {
  if (
    !generationId
    || generationId.includes('..')
    || generationId.includes('/')
    || generationId.includes('\\')
    || path.isAbsolute(generationId)
  ) {
    throw Object.assign(new Error('Invalid generation id'), { code: 'INVALID_GENERATION_ID' });
  }
}

function assertSafeStackName(stackName: string): void {
  if (!isValidStackName(stackName)) {
    throw Object.assign(new Error('Invalid stack name'), { code: 'INVALID_STACK_NAME' });
  }
}

function sha256Of(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export interface CaptureGenerationOpts {
  nodeId: number;
  stackName: string;
  generationId: string;
  inventory: ResolvedRollbackInventory;
  operationKind?: RollbackOperationKind;
  images?: RollbackImageIdentity[];
  lkgHint?: string | null;
  capturedAt?: number;
}

export class RollbackGenerationStore {
  /** <DATA_DIR>/backups/<nodeId>/<stackName>/generations */
  static getGenerationsRoot(nodeId: number, stackName: string): string {
    assertSafeStackName(stackName);
    // Canonical js/path-injection barrier: resolve against a known-safe root
    // then check containment with startsWith. CodeQL does not credit helpers.
    const backupRoot = path.resolve(getBackupBaseDir());
    const root = path.resolve(backupRoot, String(nodeId), stackName, 'generations');
    if (!root.startsWith(backupRoot + path.sep)) {
      throw Object.assign(new Error('Path escapes backup directory'), { code: 'INVALID_PATH' });
    }
    return root;
  }

  /** Final content directory for one generation id. */
  static getGenerationDir(nodeId: number, stackName: string, generationId: string): string {
    assertSafeGenerationId(generationId);
    const gensRoot = this.getGenerationsRoot(nodeId, stackName);
    // Inline barrier at the generation-id join (same form as FileSystemService).
    const gensResolved = path.resolve(gensRoot);
    const genDir = path.resolve(gensResolved, generationId);
    if (!genDir.startsWith(gensResolved + path.sep)) {
      throw Object.assign(new Error('Path escapes generation directory'), { code: 'INVALID_PATH' });
    }
    return genDir;
  }

  /**
   * Stage a new generation under staging-<uuid>, verify checksums, then rename
   * into the final generationId directory. Failures delete only the staging
   * directory and leave prior generations intact.
   */
  static async captureGeneration(opts: CaptureGenerationOpts): Promise<RollbackGenerationManifest> {
    const {
      nodeId,
      stackName,
      generationId,
      inventory,
      operationKind = 'unknown',
      images = [],
      lkgHint = null,
      capturedAt = Date.now(),
    } = opts;

    assertSafeStackName(stackName);
    assertSafeGenerationId(generationId);

    const gensRoot = this.getGenerationsRoot(nodeId, stackName);
    // Inline barrier at the mkdir sink for the generations root.
    const gensResolved = path.resolve(gensRoot);
    const backupRoot = path.resolve(getBackupBaseDir());
    if (!gensResolved.startsWith(backupRoot + path.sep)) {
      throw Object.assign(new Error('Path escapes backup directory'), { code: 'INVALID_PATH' });
    }
    await fsPromises.mkdir(gensResolved, { recursive: true });

    // Inline barrier at the access sink for the final generation directory.
    const finalResolved = path.resolve(gensResolved, generationId);
    if (!finalResolved.startsWith(gensResolved + path.sep)) {
      throw Object.assign(new Error('Path escapes generation directory'), { code: 'INVALID_PATH' });
    }
    const alreadyExists = await fsPromises.access(finalResolved).then(
      () => true,
      (e: NodeJS.ErrnoException) => {
        if (e.code === 'ENOENT') return false;
        throw e;
      },
    );
    if (alreadyExists) {
      throw Object.assign(new Error(`Generation directory already exists: ${generationId}`), {
        code: 'GENERATION_EXISTS',
      });
    }

    const composeBase = path.resolve(FileSystemService.getInstance(nodeId).getBaseDir());
    const stackRoot = path.resolve(composeBase, stackName);
    if (!stackRoot.startsWith(composeBase + path.sep)) {
      throw Object.assign(new Error('Stack name escapes compose directory'), { code: 'INVALID_PATH' });
    }

    const stagingName = `staging-${randomUUID()}`;
    const stagingDir = path.resolve(gensResolved, stagingName);
    if (!stagingDir.startsWith(gensResolved + path.sep)) {
      throw Object.assign(new Error('Path escapes generation directory'), { code: 'INVALID_PATH' });
    }
    const stagingFiles = path.resolve(stagingDir, FILES_DIR);
    if (!stagingFiles.startsWith(stagingDir + path.sep)) {
      throw Object.assign(new Error('Path escapes staging directory'), { code: 'INVALID_PATH' });
    }

    try {
      await fsPromises.mkdir(stagingFiles, { recursive: true });

      const entries: RollbackGenerationEntry[] = [];
      const managedRelativePaths: string[] = [];
      const managedSeen = new Set<string>();
      const filesRoot = path.resolve(stagingFiles);

      for (const inv of inventory.entries) {
        const relativePath = posixRel(inv.relativePath);
        const key = caseKey(relativePath);
        if (!managedSeen.has(key)) {
          managedSeen.add(key);
          managedRelativePaths.push(relativePath);
        }

        if (inv.absolutePath === null) {
          entries.push({
            relativePath,
            dependencyKind: inv.dependencyKind,
            provenance: inv.provenance,
            state: 'tombstoned',
            contentSha256: null,
            sizeBytes: null,
            sensitivity: inv.sensitivity,
            encrypted: false,
          });
          continue;
        }

        // Inline barrier at the realpath / readFile sinks for live stack sources.
        const srcCandidate = path.resolve(stackRoot, relativePath);
        if (!srcCandidate.startsWith(stackRoot + path.sep)) {
          throw new Error(`Inventory path escapes stack root: ${relativePath}`);
        }

        let realPath: string;
        try {
          realPath = await fsPromises.realpath(srcCandidate);
        } catch (e) {
          throw new Error(
            `Could not resolve ${relativePath} for generation capture: ${(e as Error).message}`,
            { cause: e },
          );
        }
        if (!realPath.startsWith(stackRoot + path.sep)) {
          throw Object.assign(
            new Error(`Inventory path escapes stack root via symlink: ${relativePath}`),
            { code: 'SYMLINK_ESCAPE' },
          );
        }

        let plaintext: Buffer;
        try {
          plaintext = await fsPromises.readFile(realPath);
        } catch (e) {
          throw new Error(
            `Could not read ${relativePath} for generation capture: ${(e as Error).message}`,
            { cause: e },
          );
        }

        const contentSha256 = sha256Of(plaintext);
        const encrypt = inv.sensitivity === 'high' || inv.sensitivity === 'medium';
        // Inline barrier at the write / mkdir sinks under the staging files tree.
        const dest = path.resolve(filesRoot, relativePath);
        if (!dest.startsWith(filesRoot + path.sep)) {
          throw Object.assign(new Error('Path escapes staging files directory'), { code: 'INVALID_PATH' });
        }
        const destParent = path.dirname(dest);
        if (!destParent.startsWith(filesRoot + path.sep) && destParent !== filesRoot) {
          throw Object.assign(new Error('Path escapes staging files directory'), { code: 'INVALID_PATH' });
        }
        await fsPromises.mkdir(destParent, { recursive: true });

        if (encrypt) {
          const cipher = CryptoService.getInstance().encrypt(plaintext.toString('base64'));
          await fsPromises.writeFile(dest, cipher, 'utf8');
          if (process.platform !== 'win32') {
            // Inline barrier at the chmod sink on the same dest just written.
            if (!dest.startsWith(filesRoot + path.sep)) {
              throw Object.assign(new Error('Path escapes staging files directory'), { code: 'INVALID_PATH' });
            }
            try {
              await fsPromises.chmod(dest, 0o600);
            } catch (e) {
              console.warn(
                `[RollbackGenerationStore] Could not set 0o600 on ${path.basename(relativePath)}:`,
                (e as Error).message,
              );
            }
          }
        } else {
          await fsPromises.writeFile(dest, plaintext);
        }

        entries.push({
          relativePath,
          dependencyKind: inv.dependencyKind,
          provenance: inv.provenance,
          state: 'present',
          contentSha256,
          sizeBytes: plaintext.length,
          sensitivity: inv.sensitivity,
          encrypted: encrypt,
        });
      }

      managedRelativePaths.sort((a, b) => a.localeCompare(b));

      const manifest: RollbackGenerationManifest = {
        schemaVersion: ROLLBACK_GENERATION_SCHEMA_VERSION,
        capabilityVersion: 1,
        generationId,
        nodeId,
        stackName,
        capturedAt,
        operationKind,
        entries,
        managedRelativePaths,
        invocation: inventory.invocation,
        git: inventory.git,
        priorRecords: {
          appliedDeploySpec: inventory.appliedDeploySpec,
          lkgHint,
        },
        images,
      };

      // Inline barrier at the manifest write sink.
      const stagingResolved = path.resolve(stagingDir);
      const manifestPath = path.resolve(stagingResolved, GENERATION_JSON);
      if (!manifestPath.startsWith(stagingResolved + path.sep)) {
        throw Object.assign(new Error('Path escapes staging directory'), { code: 'INVALID_PATH' });
      }
      await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

      await this.verifyManifestContent(stagingResolved, manifest);

      // Inline barriers at both sides of the rename sink.
      const renameFrom = path.resolve(gensResolved, stagingName);
      const renameTo = path.resolve(gensResolved, generationId);
      if (!renameFrom.startsWith(gensResolved + path.sep) || !renameTo.startsWith(gensResolved + path.sep)) {
        throw Object.assign(new Error('Path escapes generation directory'), { code: 'INVALID_PATH' });
      }
      await fsPromises.rename(renameFrom, renameTo);
      return manifest;
    } catch (e) {
      // Inline barrier at the cleanup rm sink.
      const cleanupRoot = path.resolve(gensResolved);
      const cleanupDir = path.resolve(cleanupRoot, stagingName);
      if (!cleanupDir.startsWith(cleanupRoot + path.sep)) {
        throw e;
      }
      await fsPromises.rm(cleanupDir, { recursive: true, force: true }).catch((cleanupErr) => {
        console.warn(
          '[RollbackGenerationStore] Failed to clean staging directory after capture error:',
          (cleanupErr as Error).message,
        );
      });
      throw e;
    }
  }

  /**
   * Restore a generation into the live stack. Verifies generation.json and
   * content checksums before any live mutation. Writes present entries;
   * deletes live paths that are in managedRelativePaths or liveManagedPaths
   * but not present in the generation (tombstones and post-capture additions
   * inside the managed set). Paths outside both sets are left untouched.
   */
  static async restoreGeneration(
    nodeId: number,
    stackName: string,
    generationId: string,
    liveManagedPaths: string[],
  ): Promise<void> {
    assertSafeStackName(stackName);
    assertSafeGenerationId(generationId);

    const genDir = this.getGenerationDir(nodeId, stackName, generationId);
    const manifest = await this.readAndVerifyGeneration(genDir);

    const presentByKey = new Map<string, RollbackGenerationEntry>();
    for (const entry of manifest.entries) {
      if (entry.state === 'present') presentByKey.set(caseKey(entry.relativePath), entry);
    }

    const deleteRelByKey = new Map<string, string>();
    const considerDelete = (relRaw: string): void => {
      const rel = posixRel(relRaw);
      const key = caseKey(rel);
      if (presentByKey.has(key) || deleteRelByKey.has(key)) return;
      deleteRelByKey.set(key, rel);
    };

    for (const rel of manifest.managedRelativePaths) considerDelete(rel);
    for (const entry of manifest.entries) {
      if (entry.state === 'tombstoned') considerDelete(entry.relativePath);
    }
    for (const rel of liveManagedPaths) considerDelete(rel);

    // Materialize plaintext for every present entry BEFORE mutating the live
    // stack so a decrypt / read failure cannot leave a half-restored tree.
    const restores: Array<{
      relativePath: string;
      content: Buffer;
      sensitivity: RollbackGenerationEntry['sensitivity'];
    }> = [];
    for (const entry of presentByKey.values()) {
      restores.push({
        relativePath: entry.relativePath,
        content: await this.readPresentEntryBytes(genDir, entry),
        sensitivity: entry.sensitivity,
      });
    }

    const fsSvc = FileSystemService.getInstance(nodeId);
    const scope = { protectedEnabled: false as const };

    for (const item of restores) {
      await fsSvc.writeStackFile(stackName, item.relativePath, item.content);
      if (item.sensitivity !== 'high' && item.sensitivity !== 'medium') continue;
      try {
        await fsSvc.chmodStackPath(stackName, item.relativePath, 0o600, scope);
      } catch (e) {
        console.warn(
          '[RollbackGenerationStore] Could not restrict mode on restored entry:',
          (e as Error).message,
        );
      }
    }

    for (const rel of deleteRelByKey.values()) {
      try {
        const kind = await fsSvc.pathKind(stackName, rel, scope);
        if (kind === null) continue;
        await fsSvc.deleteStackPath(stackName, rel, kind === 'directory', scope);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw e;
      }
    }
  }

  /** Remove one generation content directory. Missing dirs are a no-op. */
  static async retireGenerationContent(
    nodeId: number,
    stackName: string,
    generationId: string,
  ): Promise<void> {
    assertSafeStackName(stackName);
    assertSafeGenerationId(generationId);
    const gensRoot = this.getGenerationsRoot(nodeId, stackName);
    // Inline barrier at the retire rm sink.
    const gensResolved = path.resolve(gensRoot);
    const dir = path.resolve(gensResolved, generationId);
    if (!dir.startsWith(gensResolved + path.sep)) {
      throw Object.assign(new Error('Path escapes generation directory'), { code: 'INVALID_PATH' });
    }
    await fsPromises.rm(dir, { recursive: true, force: true });
  }

  /**
   * Verify generation.json exists and every present entry matches its checksum.
   * Returns false on missing or corrupt content; does not throw for expected failures.
   */
  static async verifyGenerationContent(
    nodeId: number,
    stackName: string,
    generationId: string,
  ): Promise<boolean> {
    try {
      assertSafeStackName(stackName);
      assertSafeGenerationId(generationId);
      const genDir = this.getGenerationDir(nodeId, stackName, generationId);
      await this.readAndVerifyGeneration(genDir);
      return true;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (
        code === 'ENOENT'
        || code === 'INVALID_GENERATION_ID'
        || code === 'INVALID_STACK_NAME'
        || code === 'INVALID_PATH'
      ) {
        return false;
      }
      console.warn(
        '[RollbackGenerationStore] verifyGenerationContent failed:',
        (e as Error).message,
      );
      return false;
    }
  }

  private static async readAndVerifyGeneration(genDir: string): Promise<RollbackGenerationManifest> {
    // Inline barrier at the manifest read sink.
    const genResolved = path.resolve(genDir);
    const manifestPath = path.resolve(genResolved, GENERATION_JSON);
    if (!manifestPath.startsWith(genResolved + path.sep)) {
      throw Object.assign(new Error('Path escapes generation directory'), { code: 'INVALID_PATH' });
    }
    let raw: string;
    try {
      raw = await fsPromises.readFile(manifestPath, 'utf8');
    } catch (e) {
      throw new Error(
        `Could not read generation manifest: ${(e as Error).message}`,
        { cause: e },
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error(`Generation manifest is not valid JSON: ${(e as Error).message}`, { cause: e });
    }
    const manifest = parsed as RollbackGenerationManifest;
    if (manifest.schemaVersion !== ROLLBACK_GENERATION_SCHEMA_VERSION) {
      throw new Error(`Unsupported generation schemaVersion ${String(manifest.schemaVersion)}`);
    }
    if (!Array.isArray(manifest.entries) || !Array.isArray(manifest.managedRelativePaths)) {
      throw new Error('Generation manifest is missing entries or managedRelativePaths');
    }
    await this.verifyManifestContent(genResolved, manifest);
    return manifest;
  }

  private static async verifyManifestContent(
    genDir: string,
    manifest: RollbackGenerationManifest,
  ): Promise<void> {
    for (const entry of manifest.entries) {
      if (entry.state !== 'present') continue;
      if (!entry.contentSha256) {
        throw new Error(`Present entry ${entry.relativePath} is missing contentSha256`);
      }
      const buf = await this.readPresentEntryBytes(genDir, entry);
      const hash = sha256Of(buf);
      if (hash !== entry.contentSha256) {
        throw new Error(
          `Checksum mismatch for ${entry.relativePath}: expected ${entry.contentSha256}, got ${hash}`,
        );
      }
      if (entry.sizeBytes !== null && buf.length !== entry.sizeBytes) {
        throw new Error(
          `Size mismatch for ${entry.relativePath}: expected ${entry.sizeBytes}, got ${buf.length}`,
        );
      }
    }
  }

  private static async readPresentEntryBytes(
    genDir: string,
    entry: RollbackGenerationEntry,
  ): Promise<Buffer> {
    // Inline barrier at the content readFile sink.
    const genResolved = path.resolve(genDir);
    const filesRoot = path.resolve(genResolved, FILES_DIR);
    if (!filesRoot.startsWith(genResolved + path.sep)) {
      throw Object.assign(new Error('Path escapes generation directory'), { code: 'INVALID_PATH' });
    }
    const relativePath = posixRel(entry.relativePath);
    const storedPath = path.resolve(filesRoot, relativePath);
    if (!storedPath.startsWith(filesRoot + path.sep)) {
      throw Object.assign(new Error('Path escapes generation files directory'), { code: 'INVALID_PATH' });
    }
    let stored: Buffer;
    try {
      stored = await fsPromises.readFile(storedPath);
    } catch (e) {
      throw new Error(
        `Missing generation content for ${entry.relativePath}: ${(e as Error).message}`,
        { cause: e },
      );
    }
    if (!entry.encrypted) return stored;

    const cipherText = stored.toString('utf8');
    let b64: string;
    try {
      b64 = CryptoService.getInstance().decrypt(cipherText);
    } catch (e) {
      throw new Error(
        `Could not decrypt generation content for ${entry.relativePath}: ${(e as Error).message}`,
        { cause: e },
      );
    }
    return Buffer.from(b64, 'base64');
  }
}

export { getBackupBaseDir, getDataDir };
