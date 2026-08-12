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
  type RollbackRestoreIntent,
  type RollbackRestoreTransactionMeta,
} from '../types/rollbackGeneration';
import { GitProjectManifestService } from './GitProjectManifestService';
import type { GitProjectManifest } from '../types/gitProjectManifest';

const GENERATION_JSON = 'generation.json';
const FILES_DIR = 'files';
const PRE_RESTORE_DIR = 'pre-restore';
const RESTORE_INTENT_FILE = 'restore-intent.json';
const GIT_MANIFEST_SNAPSHOT = 'git-manifest.v1.json';
const PRE_RESTORE_INDEX = 'index.json';
const PRE_RESTORE_BLOBS = 'blobs';

interface PreRestoreIndexEntry {
  relativePath: string;
  state: 'present' | 'absent';
  blobId?: string;
  mode?: number | null;
}

interface PreRestoreIndex {
  version: 1;
  entries: PreRestoreIndexEntry[];
}

function getDataDir(): string {
  return process.env.DATA_DIR || path.join(process.cwd(), 'data');
}

function getBackupBaseDir(): string {
  return path.join(getDataDir(), 'backups');
}

function posixRel(rel: string): string {
  return rel.replace(/\\/g, '/').replace(/^\.\//, '');
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
        if (!managedSeen.has(relativePath)) {
          managedSeen.add(relativePath);
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
            mode: null,
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

        let fileMode: number | null = null;
        try {
          const st = await fsPromises.lstat(realPath);
          if (st.isFile()) fileMode = st.mode & 0o777;
        } catch (e) {
          console.warn(
            `[RollbackGenerationStore] Could not read mode for ${relativePath}:`,
            (e as Error).message,
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
          mode: fileMode,
        });
      }

      managedRelativePaths.sort((a, b) => a.localeCompare(b));

      let gitManifestCaptured = false;
      if (inventory.git) {
        const read = await GitProjectManifestService.getInstance().readManifest(
          stackName,
          inventory.git.repoUrl,
          inventory.git.branch,
        );
        // Never snapshot a corrupt or missing manifesto; restore must not
        // reinstate unvalidated Git state as if it were authoritative.
        if (read !== null && !('corrupt' in read)) {
          // Inline barrier at the manifesto snapshot write sink.
          const snapPath = path.resolve(stagingDir, GIT_MANIFEST_SNAPSHOT);
          if (!snapPath.startsWith(stagingDir + path.sep)) {
            throw Object.assign(new Error('Path escapes staging directory'), { code: 'INVALID_PATH' });
          }
          await fsPromises.writeFile(snapPath, JSON.stringify(read, null, 2), 'utf8');
          gitManifestCaptured = true;
        }
      }

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
          lastAppliedContentHash: inventory.lastAppliedContentHash,
          manifestState: inventory.manifestState,
          manifestGeneration: inventory.manifestGeneration,
          gitManifestCaptured,
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
   * If a prior restore left a durable intent + pre-restore snapshot, revert the
   * live managed set, Git DB projection, and managed manifesto to the
   * pre-restore state. Used by startup reconciliation and failed compensate.
   */
  static async reconcileInterruptedRestore(
    nodeId: number,
    stackName: string,
    generationId: string,
  ): Promise<boolean> {
    assertSafeStackName(stackName);
    assertSafeGenerationId(generationId);
    const genDir = this.getGenerationDir(nodeId, stackName, generationId);
    const genResolved = path.resolve(genDir);
    const intentPath = path.resolve(genResolved, RESTORE_INTENT_FILE);
    if (!intentPath.startsWith(genResolved + path.sep)) return false;
    let intentRaw: string;
    try {
      intentRaw = await fsPromises.readFile(intentPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }

    let intent: RollbackRestoreIntent;
    try {
      intent = JSON.parse(intentRaw) as RollbackRestoreIntent;
    } catch (e) {
      throw new Error(
        `Corrupt restore-intent.json for generation ${generationId}: ${(e as Error).message}`,
        { cause: e },
      );
    }

    await this.revertFromPreRestoreSnapshot(nodeId, stackName, genResolved);
    await this.restoreGitSideStateFromIntent(stackName, intent);
    await fsPromises.rm(intentPath, { force: true });
    return true;
  }

  /**
   * Drop the durable restore intent and pre-restore snapshot after a successful
   * compensation (files restored, policy passed, compose up + probe ok).
   */
  static async commitRestoreTransaction(
    nodeId: number,
    stackName: string,
    generationId: string,
  ): Promise<void> {
    assertSafeStackName(stackName);
    assertSafeGenerationId(generationId);
    const genDir = this.getGenerationDir(nodeId, stackName, generationId);
    const genResolved = path.resolve(genDir);
    const intentPath = path.resolve(genResolved, RESTORE_INTENT_FILE);
    const preRoot = path.resolve(genResolved, PRE_RESTORE_DIR);
    if (intentPath.startsWith(genResolved + path.sep)) {
      await fsPromises.rm(intentPath, { force: true });
    }
    if (preRoot.startsWith(genResolved + path.sep)) {
      await fsPromises.rm(preRoot, { recursive: true, force: true });
    }
  }

  /**
   * Restore a generation into the live stack. Verifies generation.json and
   * content checksums before any live mutation. Writes present entries;
   * deletes live paths that are in managedRelativePaths or liveManagedPaths
   * but not present in the generation (tombstones and post-capture additions
   * inside the managed set). Paths outside both sets are left untouched.
   *
   * Durability: copies the affected live paths into pre-restore/ and writes
   * restore-intent.json (including Git DB + manifesto preimage) before mutation.
   * Failure or restart reverts from that snapshot so a hybrid managed project
   * cannot remain.
   */
  static async restoreGeneration(
    nodeId: number,
    stackName: string,
    generationId: string,
    liveManagedPaths: string[],
    transactionMeta?: RollbackRestoreTransactionMeta,
  ): Promise<RollbackGenerationManifest> {
    assertSafeStackName(stackName);
    assertSafeGenerationId(generationId);

    const genDir = this.getGenerationDir(nodeId, stackName, generationId);
    const genResolved = path.resolve(genDir);
    const manifest = await this.readAndVerifyGeneration(genDir);

    const presentByKey = new Map<string, RollbackGenerationEntry>();
    for (const entry of manifest.entries) {
      if (entry.state === 'present') presentByKey.set(posixRel(entry.relativePath), entry);
    }

    const deleteRelByKey = new Map<string, string>();
    const considerDelete = (relRaw: string): void => {
      const rel = posixRel(relRaw);
      if (presentByKey.has(rel) || deleteRelByKey.has(rel)) return;
      deleteRelByKey.set(rel, rel);
    };

    for (const rel of manifest.managedRelativePaths) considerDelete(rel);
    for (const entry of manifest.entries) {
      if (entry.state === 'tombstoned') considerDelete(entry.relativePath);
    }
    for (const rel of liveManagedPaths) considerDelete(rel);

    const restores: Array<{
      relativePath: string;
      content: Buffer;
      sensitivity: RollbackGenerationEntry['sensitivity'];
      mode: number | null;
    }> = [];
    for (const entry of presentByKey.values()) {
      restores.push({
        relativePath: entry.relativePath,
        content: await this.readPresentEntryBytes(genDir, entry),
        sensitivity: entry.sensitivity,
        mode: entry.mode ?? null,
      });
    }

    const affectedPaths = [
      ...restores.map((r) => r.relativePath),
      ...deleteRelByKey.values(),
    ];

    const fsSvc = FileSystemService.getInstance(nodeId);
    const scope = { protectedEnabled: false as const };

    // Refuse directory-at-file-path collisions before any snapshot or mutation.
    for (const rel of affectedPaths) {
      const kind = await fsSvc.pathKind(stackName, rel, scope);
      if (kind === 'directory') {
        throw Object.assign(
          new Error(
            `Managed path "${rel}" is a directory; refusing restore that would replace or delete it as a file`,
          ),
          { code: 'DIRECTORY_COLLISION' },
        );
      }
    }

    await this.capturePreRestoreSnapshot(nodeId, stackName, genResolved, affectedPaths);
    const intentPath = path.resolve(genResolved, RESTORE_INTENT_FILE);
    if (!intentPath.startsWith(genResolved + path.sep)) {
      throw Object.assign(new Error('Path escapes generation directory'), { code: 'INVALID_PATH' });
    }
    const intent: RollbackRestoreIntent = {
      generationId,
      stackName,
      nodeId,
      paths: affectedPaths,
      at: Date.now(),
    };
    if (transactionMeta) {
      intent.gitSide = {
        gitDbBefore: transactionMeta.gitDbBefore,
        managedManifestBefore: transactionMeta.managedManifestBefore,
      };
    }
    await fsPromises.writeFile(intentPath, JSON.stringify(intent), 'utf8');

    try {
      for (const item of restores) {
        await fsSvc.writeStackFile(stackName, item.relativePath, item.content);
        const sensitive = item.sensitivity === 'high' || item.sensitivity === 'medium';
        // Sensitive content is always owner-only; other files restore captured mode.
        const targetMode = sensitive ? 0o600 : (item.mode ?? null);
        if (targetMode === null || process.platform === 'win32') continue;
        try {
          await fsSvc.chmodStackPath(stackName, item.relativePath, targetMode, scope);
        } catch (e) {
          if (sensitive) {
            throw Object.assign(
              new Error(
                `Could not apply permissions on sensitive restored path "${item.relativePath}": ${(e as Error).message}`,
              ),
              { code: 'RESTORE_CHMOD_FAILED', cause: e },
            );
          }
          console.warn(
            '[RollbackGenerationStore] Could not restore mode on entry:',
            (e as Error).message,
          );
        }
      }

      for (const rel of deleteRelByKey.values()) {
        try {
          const kind = await fsSvc.pathKind(stackName, rel, scope);
          if (kind === null) continue;
          if (kind === 'directory') {
            throw Object.assign(
              new Error(`Managed path "${rel}" is a directory; refusing delete during restore`),
              { code: 'DIRECTORY_COLLISION' },
            );
          }
          await fsSvc.deleteStackPath(stackName, rel, false, scope);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw e;
        }
      }

      // Leave restore-intent.json + pre-restore/ until commitRestoreTransaction
      // so a later policy/compose failure can still revert the managed set.
      return manifest;
    } catch (e) {
      try {
        await this.revertFromPreRestoreSnapshot(nodeId, stackName, genResolved);
        await this.restoreGitSideStateFromIntent(stackName, intent);
        await fsPromises.rm(intentPath, { force: true });
      } catch (revertErr) {
        console.error(
          '[RollbackGenerationStore] Failed to revert interrupted restore:',
          (revertErr as Error).message,
        );
      }
      throw e;
    }
  }

  /** True when restore-intent.json still exists for this generation. */
  static async hasPendingRestoreIntent(
    nodeId: number,
    stackName: string,
    generationId: string,
  ): Promise<boolean> {
    assertSafeStackName(stackName);
    assertSafeGenerationId(generationId);
    const genDir = this.getGenerationDir(nodeId, stackName, generationId);
    const genResolved = path.resolve(genDir);
    const intentPath = path.resolve(genResolved, RESTORE_INTENT_FILE);
    if (!intentPath.startsWith(genResolved + path.sep)) return false;
    try {
      await fsPromises.access(intentPath);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw e;
    }
  }

  /** Restore captured managed manifesto from a generation content directory. */
  static async restoreCapturedGitManifest(
    stackName: string,
    generationDir: string,
    generation: RollbackGenerationManifest,
  ): Promise<void> {
    const genResolved = path.resolve(generationDir);
    const snapPath = path.resolve(genResolved, GIT_MANIFEST_SNAPSHOT);
    const capturedFlag = generation.priorRecords?.gitManifestCaptured;
    const svc = GitProjectManifestService.getInstance();

    // Inline barrier immediately before the read sink (no access-then-read TOCTOU).
    if (!snapPath.startsWith(genResolved + path.sep)) {
      throw Object.assign(new Error('Path escapes generation directory'), { code: 'INVALID_PATH' });
    }

    if (capturedFlag === true) {
      const raw = await fsPromises.readFile(snapPath, 'utf8');
      const parsed = JSON.parse(raw) as GitProjectManifest;
      await svc.writeManifest(stackName, parsed);
      return;
    }

    if (capturedFlag === undefined) {
      // Legacy generations: restore only when a snapshot file is present.
      try {
        const raw = await fsPromises.readFile(snapPath, 'utf8');
        const parsed = JSON.parse(raw) as GitProjectManifest;
        await svc.writeManifest(stackName, parsed);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      return;
    }

    // Explicit first-apply preimage only. Legacy generations without the flag
    // and without a snapshot must not wipe a live manifesto that was never
    // part of the capture contract.
    if (capturedFlag === false && generation.git) {
      await svc.clearManifestFile(stackName);
    }
  }

  private static async restoreGitSideStateFromIntent(
    stackName: string,
    intent: RollbackRestoreIntent,
  ): Promise<void> {
    if (!intent.gitSide) return;

    const { DatabaseService } = await import('./DatabaseService');
    const db = DatabaseService.getInstance();
    const before = intent.gitSide.gitDbBefore;
    if (before) {
      db.setGitSourceAppliedSpec(stackName, before.appliedDeploySpec);
      if (before.lastAppliedCommitSha) {
        db.markGitSourceApplied(
          stackName,
          before.lastAppliedCommitSha,
          before.lastAppliedContentHash || '',
        );
      } else {
        db.clearGitSourceAppliedRevision(stackName);
      }
      db.setGitSourceManifestState(
        stackName,
        before.manifestVersion,
        before.manifestState,
        before.manifestGeneration,
      );
    }

    const svc = GitProjectManifestService.getInstance();
    if (intent.gitSide.managedManifestBefore === null) {
      await svc.clearManifestFile(stackName);
    } else {
      const parsed = JSON.parse(intent.gitSide.managedManifestBefore) as GitProjectManifest;
      await svc.writeManifest(stackName, parsed);
    }
  }

  private static async capturePreRestoreSnapshot(
    nodeId: number,
    stackName: string,
    genResolved: string,
    relativePaths: string[],
  ): Promise<void> {
    const preRoot = path.resolve(genResolved, PRE_RESTORE_DIR);
    if (!preRoot.startsWith(genResolved + path.sep)) {
      throw Object.assign(new Error('Path escapes generation directory'), { code: 'INVALID_PATH' });
    }
    await fsPromises.rm(preRoot, { recursive: true, force: true });
    await fsPromises.mkdir(preRoot, { recursive: true });
    const blobsRoot = path.resolve(preRoot, PRE_RESTORE_BLOBS);
    if (!blobsRoot.startsWith(preRoot + path.sep)) {
      throw Object.assign(new Error('Path escapes generation directory'), { code: 'INVALID_PATH' });
    }
    await fsPromises.mkdir(blobsRoot, { recursive: true });

    const fsSvc = FileSystemService.getInstance(nodeId);
    const composeBase = path.resolve(fsSvc.getBaseDir());
    const stackRoot = path.resolve(composeBase, stackName);
    if (!stackRoot.startsWith(composeBase + path.sep)) {
      throw Object.assign(new Error('Stack name escapes compose directory'), { code: 'INVALID_PATH' });
    }

    const seen = new Set<string>();
    const index: PreRestoreIndex = { version: 1, entries: [] };

    for (const relRaw of relativePaths) {
      const rel = posixRel(relRaw);
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      const srcCandidate = path.resolve(stackRoot, rel);
      if (!srcCandidate.startsWith(stackRoot + path.sep)) continue;
      try {
        const realSrc = await fsPromises.realpath(srcCandidate);
        if (!realSrc.startsWith(stackRoot + path.sep)) continue;
        const st = await fsPromises.lstat(realSrc);
        if (!st.isFile()) {
          throw Object.assign(
            new Error(
              `Managed path "${rel}" is not a regular file; refusing to snapshot it as absent`,
            ),
            { code: 'DIRECTORY_COLLISION' },
          );
        }
        const realForRead = await fsPromises.realpath(srcCandidate);
        if (!realForRead.startsWith(stackRoot + path.sep)) continue;
        const bytes = await fsPromises.readFile(realForRead);
        const blobId = randomUUID();
        const blobPath = path.resolve(blobsRoot, blobId);
        if (!blobPath.startsWith(blobsRoot + path.sep)) continue;
        await fsPromises.writeFile(blobPath, bytes);
        index.entries.push({
          relativePath: rel,
          state: 'present',
          blobId,
          mode: st.mode & 0o777,
        });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          index.entries.push({ relativePath: rel, state: 'absent' });
          continue;
        }
        throw e;
      }
    }

    const indexPath = path.resolve(preRoot, PRE_RESTORE_INDEX);
    if (!indexPath.startsWith(preRoot + path.sep)) {
      throw Object.assign(new Error('Path escapes generation directory'), { code: 'INVALID_PATH' });
    }
    await fsPromises.writeFile(indexPath, JSON.stringify(index), 'utf8');
  }

  private static async revertFromPreRestoreSnapshot(
    nodeId: number,
    stackName: string,
    genResolved: string,
  ): Promise<void> {
    const preRoot = path.resolve(genResolved, PRE_RESTORE_DIR);
    if (!preRoot.startsWith(genResolved + path.sep)) return;
    try {
      await fsPromises.access(preRoot);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }

    const indexPath = path.resolve(preRoot, PRE_RESTORE_INDEX);
    if (!indexPath.startsWith(preRoot + path.sep)) return;

    let index: PreRestoreIndex;
    try {
      const raw = await fsPromises.readFile(indexPath, 'utf8');
      index = JSON.parse(raw) as PreRestoreIndex;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        // Legacy suffix-tombstone snapshots are unsupported after this change.
        throw Object.assign(
          new Error('Pre-restore index missing; cannot safely revert interrupted restore'),
          { code: 'PRE_RESTORE_INDEX_MISSING', cause: e },
        );
      }
      throw e;
    }
    if (!index || index.version !== 1 || !Array.isArray(index.entries)) {
      throw Object.assign(
        new Error('Pre-restore index is malformed'),
        { code: 'PRE_RESTORE_INDEX_INVALID' },
      );
    }

    const blobsRoot = path.resolve(preRoot, PRE_RESTORE_BLOBS);
    const fsSvc = FileSystemService.getInstance(nodeId);
    const scope = { protectedEnabled: false as const };

    for (const entry of index.entries) {
      const rel = posixRel(entry.relativePath);
      if (!rel) continue;
      if (entry.state === 'absent') {
        try {
          const kind = await fsSvc.pathKind(stackName, rel, scope);
          if (kind === null) continue;
          await fsSvc.deleteStackPath(stackName, rel, kind === 'directory', scope);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        continue;
      }
      if (entry.state !== 'present' || !entry.blobId) {
        throw Object.assign(
          new Error(`Pre-restore entry for "${rel}" is incomplete`),
          { code: 'PRE_RESTORE_INDEX_INVALID' },
        );
      }
      const blobPath = this.resolvePreRestoreBlobPath(blobsRoot, entry.blobId);
      const buf = await fsPromises.readFile(blobPath);
      await fsSvc.writeStackFile(stackName, rel, buf);
      if (typeof entry.mode === 'number' && process.platform !== 'win32') {
        try {
          await fsSvc.chmodStackPath(stackName, rel, entry.mode & 0o777, scope);
        } catch (e) {
          throw Object.assign(
            new Error(
              `Could not restore pre-restore permissions on "${rel}": ${(e as Error).message}`,
            ),
            { code: 'RESTORE_CHMOD_FAILED', cause: e },
          );
        }
      }
    }
    await fsPromises.rm(preRoot, { recursive: true, force: true });
  }

  /** Resolve a pre-restore blob id under blobsRoot; rejects traversal. */
  private static resolvePreRestoreBlobPath(blobsRoot: string, blobId: string): string {
    if (blobId.includes('..') || blobId.includes('/') || blobId.includes('\\')) {
      throw Object.assign(new Error('Invalid pre-restore blob id'), { code: 'INVALID_PATH' });
    }
    const blobPath = path.resolve(blobsRoot, blobId);
    if (!blobPath.startsWith(blobsRoot + path.sep)) {
      throw Object.assign(new Error('Path escapes pre-restore blobs'), { code: 'INVALID_PATH' });
    }
    return blobPath;
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
