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
import { constants as fsConstants, promises as fsPromises } from 'fs';
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
import type { GitProjectManifest, InputSensitivity } from '../types/gitProjectManifest';

const GENERATION_JSON = 'generation.json';
const FILES_DIR = 'files';
const PRE_RESTORE_DIR = 'pre-restore';
const RESTORE_INTENT_FILE = 'restore-intent.json';
const GIT_MANIFEST_SNAPSHOT = 'git-manifest.v1.json';
const PRE_RESTORE_INDEX = 'index.json';
const PRE_RESTORE_BLOBS = 'blobs';

interface PreRestoreIndexEntry {
  relativePath: string;
  state: 'present' | 'absent' | 'link';
  blobId?: string;
  mode?: number | null;
  encrypted?: boolean;
  /**
   * Raw readlink value, for state 'link' (a managed path only unlinked, so the
   * link is all there is to put back) and for a 'present' entry whose path was
   * a link the write followed, so a revert can put that link back too.
   */
  linkTarget?: string;
}

interface PreRestoreIndex {
  version: 1;
  entries: PreRestoreIndexEntry[];
}

/**
 * The lexical stack root, and the physical one a realpath'd file is compared
 * against. Every stage that reads or writes generation content resolves the
 * live file physically, so they all need the real root: a symlinked COMPOSE_DIR
 * keeps each file exactly where its name claims while the physical path differs
 * from the lexical root. A stack directory that links elsewhere stays refused,
 * because the real root is the compose root plus the stack name rather than the
 * link target.
 */
async function resolveStackRoots(nodeId: number, stackName: string): Promise<{ lexical: string; real: string }> {
  const composeBase = path.resolve(FileSystemService.getInstance(nodeId).getBaseDir());
  const lexical = path.resolve(composeBase, stackName);
  if (!lexical.startsWith(composeBase + path.sep)) {
    throw Object.assign(new Error('Stack name escapes compose directory'), { code: 'INVALID_PATH' });
  }
  try {
    return { lexical, real: path.join(await fsPromises.realpath(composeBase), stackName) };
  } catch (e) {
    // A compose root that is not there holds nothing to resolve through. Startup
    // reconciliation runs this against a directory an operator may have removed
    // since the restore was interrupted, and must answer "missing" rather than
    // throw before it can look.
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    return { lexical, real: lexical };
  }
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

function shouldEncryptPreRestore(sensitivity: InputSensitivity | undefined): boolean {
  // Unknown sensitivity is encrypted fail-closed; only explicit low stays plaintext.
  return sensitivity !== 'low';
}

async function chmodPrivate(target: string, mode: number): Promise<void> {
  if (process.platform === 'win32') return;
  await fsPromises.chmod(target, mode);
}

async function mkdirPrivate(dir: string): Promise<void> {
  await fsPromises.mkdir(dir, { recursive: true, mode: 0o700 });
  await chmodPrivate(dir, 0o700);
}

async function writePrivate(target: string, data: string | Buffer): Promise<void> {
  await fsPromises.writeFile(target, data);
  await chmodPrivate(target, 0o600);
}

/**
 * The bytes and permission bits of one snapshot source, read through the
 * descriptor the caller already opened after its containment check. Stat and
 * read share that descriptor, so a path swapped between the two calls cannot
 * give the metadata of one file and the bytes of another. A non-regular file is
 * refused before any read, so a device or a fifo can never be read as content.
 */
async function readSnapshotBytes(
  fh: import('fs/promises').FileHandle,
  rel: string,
): Promise<{ bytes: Buffer; mode: number }> {
  const st = await fh.stat();
  if (!st.isFile()) {
    throw Object.assign(
      new Error(`Managed path "${rel}" is not a regular file; refusing to snapshot it as absent`),
      { code: 'DIRECTORY_COLLISION' },
    );
  }
  return { bytes: await fh.readFile(), mode: st.mode & 0o777 };
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

    const { lexical: stackRoot, real: realStackRoot } = await resolveStackRoots(nodeId, stackName);

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
        if (!realPath.startsWith(realStackRoot + path.sep)) {
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
        uncapturedRelativePaths: [...inventory.uncapturedRelativePaths],
        uncapturedInputs: [...inventory.uncapturedInputs],
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
   * Persist finalized runtime image identity on an already-captured generation.
   * Capture writes files first; image inspect happens after, so the manifest
   * images array is patched in place once IDs, digests, and platform are known.
   */
  static async attachImages(
    nodeId: number,
    stackName: string,
    generationId: string,
    images: RollbackImageIdentity[],
  ): Promise<void> {
    assertSafeStackName(stackName);
    assertSafeGenerationId(generationId);
    const genDir = this.getGenerationDir(nodeId, stackName, generationId);
    const genResolved = path.resolve(genDir);
    const manifest = await this.readAndVerifyGeneration(genResolved);
    const seen = new Set<string>();
    for (const image of images) {
      const name = image.serviceName.trim();
      if (!name) {
        throw Object.assign(
          new Error('Recovery image identity is missing a service name'),
          { code: 'INVALID_IMAGE_IDENTITY' },
        );
      }
      if (seen.has(name)) {
        throw Object.assign(
          new Error(`Duplicate recovery image identity for service "${name}"`),
          { code: 'INVALID_IMAGE_IDENTITY' },
        );
      }
      seen.add(name);
      if (image.platform !== null && image.platform.trim() === '') {
        throw Object.assign(
          new Error(`Empty platform for service "${name}"`),
          { code: 'INVALID_IMAGE_IDENTITY' },
        );
      }
    }
    manifest.images = images;
    const manifestPath = path.resolve(genResolved, GENERATION_JSON);
    if (!manifestPath.startsWith(genResolved + path.sep)) {
      throw Object.assign(new Error('Path escapes generation directory'), { code: 'INVALID_PATH' });
    }
    await fsPromises.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    await this.readAndVerifyGeneration(genResolved);
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
   * inside the managed set). Paths outside both sets are left untouched, and
   * so are the manifest's uncapturedRelativePaths even when a caller lists them.
   *
   * A generation that recorded any uncaptured input deletes nothing from the
   * caller's live discovery. An uncaptured input can name a file the generation
   * never held, at any path, and its name is no proof of ownership: a shared
   * include can pull in a local override, and an interpolated include can name a
   * conventional compose file, so deleting a live file because its basename
   * looks like a Compose layer can remove a required dependency. Recovery stays
   * exact without that deletion because the generation pins the layers it
   * captured, and an explicit `-f` list suppresses both discovery and the
   * implicit override merge. A generation with no uncaptured input may still
   * delete the caller's live discovery set, because it holds every input its
   * project declared.
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

    // Paths left out at capture (links that escaped the stack, dangled, or
    // pointed at a non-file) were never part of the generation. A real file
    // there now is the operator's, so it is not stale managed content to remove,
    // even when the caller's live discovery lists it.
    const uncapturedKeys = new Set((manifest.uncapturedRelativePaths ?? []).map(posixRel));
    const deleteRelByKey = new Map<string, string>();
    const considerDelete = (relRaw: string): void => {
      const rel = posixRel(relRaw);
      if (presentByKey.has(rel) || deleteRelByKey.has(rel) || uncapturedKeys.has(rel)) return;
      deleteRelByKey.set(rel, rel);
    };

    for (const rel of manifest.managedRelativePaths) considerDelete(rel);
    for (const entry of manifest.entries) {
      if (entry.state === 'tombstoned') considerDelete(entry.relativePath);
    }
    // A partial generation cannot say what its uncaptured inputs resolved to,
    // so a file that appeared since capture may be one of them: an env file a
    // ${VAR} path now names, or a local override an external include extends
    // from. A Compose basename is no proof of ownership, so a generation that
    // recorded any uncaptured input keeps every unrecorded live file. Recovery
    // still runs the captured project: the generation pins the layers it
    // selected, and an explicit -f list suppresses Compose's own discovery and
    // the implicit override merge.
    if ((manifest.uncapturedInputs ?? []).length === 0) {
      for (const rel of liveManagedPaths) considerDelete(rel);
    }

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

    const restorablePaths = restores.map((r) => r.relativePath);
    const affectedPaths = [...restorablePaths, ...deleteRelByKey.values()];

    const fsSvc = FileSystemService.getInstance(nodeId);
    const scope = { protectedEnabled: false as const };

    // Refuse directory-at-file-path collisions before any snapshot or mutation.
    // A path being written is followed, because the write itself follows it and
    // has to stay inside the stack. A path only being deleted is observed on the
    // leaf, so a managed path that has become a link is judged as a link: the
    // delete removes the link and never reaches a target outside the stack.
    for (const rel of restorablePaths) {
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
    for (const rel of deleteRelByKey.values()) {
      const kind = await fsSvc.observeStackPath(stackName, rel, scope);
      if (kind === 'directory') {
        throw Object.assign(
          new Error(
            `Managed path "${rel}" is a directory; refusing restore that would replace or delete it as a file`,
          ),
          { code: 'DIRECTORY_COLLISION' },
        );
      }
    }

    const sensitivityByPath = new Map(
      manifest.entries.map((entry) => [posixRel(entry.relativePath), entry.sensitivity]),
    );
    await this.capturePreRestoreSnapshot(
      nodeId,
      stackName,
      genResolved,
      affectedPaths,
      new Set(restorablePaths.map(posixRel)),
      sensitivityByPath,
    );
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
          const kind = await fsSvc.observeStackPath(stackName, rel, scope);
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
        // The live files may now be a mix of the generation and the
        // pre-restore snapshot. Carry that fact with the original failure so
        // the caller cannot classify it as a refusal that moved nothing.
        if (typeof e === 'object' && e !== null) {
          Object.assign(e, { restoreRevertFailed: true });
        }
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

  private static async recreateManagedSymlink(
    nodeId: number,
    stackName: string,
    rel: string,
    linkTarget: string,
  ): Promise<void> {
    // The lexical check cannot see that a parent directory was replaced by a
    // link since the snapshot, which would put the new link outside the stack,
    // and a check that ran after mkdir would already have written through it.
    const { lexical: stackRoot } = await this.assertManagedParentContained(nodeId, stackName, rel);
    const linkPath = path.resolve(stackRoot, posixRel(rel));
    // Inline barrier at the symlink sink: the path being created is contained
    // against the stack root. linkTarget is the operator's own value and is
    // intentionally not resolved, because restoring a link means restoring the
    // link, and nothing is written through it.
    if (!linkPath.startsWith(stackRoot + path.sep)) {
      throw Object.assign(new Error('Path escapes stack root'), { code: 'INVALID_PATH' });
    }
    await fsPromises.mkdir(path.dirname(linkPath), { recursive: true });
    await fsPromises.symlink(linkTarget, linkPath);
  }

  /**
   * Put a managed path back to the link the snapshot recorded, when it no longer
   * is that link. A missing leaf is created; a link that now points elsewhere is
   * unlinked (removing a link never touches its target) and recreated. A regular
   * file or directory is left in place: the caller still writes the preimage
   * over it, as it does for any managed path that is no longer a link, and
   * removing the operator's own entry is not a revert's job.
   */
  private static async restoreManagedLinkShape(
    nodeId: number,
    stackName: string,
    rel: string,
    linkTarget: string,
  ): Promise<void> {
    // Containment first: a parent directory replaced by a link out of the stack
    // would otherwise be unlinked or written through before the check below ran.
    const roots = await this.assertManagedParentContained(nodeId, stackName, rel);
    const liveKind = await this.lstatManagedPath(nodeId, stackName, rel);
    if (liveKind === 'symlink') {
      const linkPath = path.resolve(roots.lexical, posixRel(rel));
      if (await fsPromises.readlink(linkPath) === linkTarget) return;
      await fsPromises.unlink(linkPath);
    } else if (liveKind !== 'missing') {
      return;
    }
    await this.recreateManagedSymlink(nodeId, stackName, rel, linkTarget);
  }

  /**
   * Confirm that every existing directory above `rel` still resolves inside the
   * real stack root, before anything is created or unlinked under it. Resolving
   * the nearest existing ancestor is what catches a parent directory that was
   * replaced by a link out of the stack while the process was down; a check that
   * ran only after `mkdir` would already have written through it.
   */
  private static async assertManagedParentContained(
    nodeId: number,
    stackName: string,
    rel: string,
  ): Promise<{ lexical: string; real: string }> {
    const roots = await resolveStackRoots(nodeId, stackName);
    const target = path.resolve(roots.lexical, posixRel(rel));
    if (!target.startsWith(roots.lexical + path.sep)) {
      throw Object.assign(new Error('Path escapes stack root'), { code: 'INVALID_PATH' });
    }
    let existing = path.dirname(target);
    for (;;) {
      let real: string;
      try {
        real = await fsPromises.realpath(existing);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        const next = path.dirname(existing);
        if (next === existing) {
          throw Object.assign(new Error('Path escapes stack root'), { code: 'SYMLINK_ESCAPE' });
        }
        existing = next;
        continue;
      }
      if (real !== roots.real && !real.startsWith(roots.real + path.sep)) {
        throw Object.assign(new Error('Symlink escapes stack root'), { code: 'SYMLINK_ESCAPE' });
      }
      return roots;
    }
  }

  private static async lstatManagedPath(
    nodeId: number,
    stackName: string,
    rel: string,
  ): Promise<'missing' | 'file' | 'directory' | 'symlink' | 'other'> {
    const { lexical: stackRoot } = await resolveStackRoots(nodeId, stackName);
    const candidate = path.resolve(stackRoot, posixRel(rel));
    if (!candidate.startsWith(stackRoot + path.sep)) {
      throw Object.assign(new Error('Path escapes stack root'), { code: 'INVALID_PATH' });
    }
    try {
      const st = await fsPromises.lstat(candidate);
      if (st.isSymbolicLink()) return 'symlink';
      if (st.isDirectory()) return 'directory';
      if (st.isFile()) return 'file';
      return 'other';
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw e;
    }
  }

  private static async capturePreRestoreSnapshot(
    nodeId: number,
    stackName: string,
    genResolved: string,
    relativePaths: string[],
    writtenPaths: ReadonlySet<string>,
    sensitivityByPath: Map<string, InputSensitivity>,
  ): Promise<void> {
    const preRoot = path.resolve(genResolved, PRE_RESTORE_DIR);
    if (!preRoot.startsWith(genResolved + path.sep)) {
      throw Object.assign(new Error('Path escapes generation directory'), { code: 'INVALID_PATH' });
    }
    await fsPromises.rm(preRoot, { recursive: true, force: true });
    await mkdirPrivate(preRoot);
    const blobsRoot = path.resolve(preRoot, PRE_RESTORE_BLOBS);
    if (!blobsRoot.startsWith(preRoot + path.sep)) {
      throw Object.assign(new Error('Path escapes generation directory'), { code: 'INVALID_PATH' });
    }
    await mkdirPrivate(blobsRoot);

    const { lexical: stackRoot, real: realStackRoot } = await resolveStackRoots(nodeId, stackName);

    const seen = new Set<string>();
    const index: PreRestoreIndex = { version: 1, entries: [] };

    for (const relRaw of relativePaths) {
      const rel = posixRel(relRaw);
      if (!rel || seen.has(rel)) continue;
      seen.add(rel);
      const sensitivity = sensitivityByPath.get(rel);
      const srcCandidate = path.resolve(stackRoot, rel);
      if (!srcCandidate.startsWith(stackRoot + path.sep)) continue;
      try {
        const leafStat = await fsPromises.lstat(srcCandidate);
        const leafIsLink = leafStat.isSymbolicLink();
        // A path restore only deletes is unlinked as a leaf, so the link is the
        // whole preimage. A path restore writes is followed by that write, so
        // what the write mutates is the target's bytes and the target is the
        // preimage: snapshotting only the link would lose them, leaving a
        // failed restore with an untracked mutation and nothing to revert to.
        const linkTarget = leafIsLink ? await fsPromises.readlink(srcCandidate) : undefined;
        if (leafIsLink && !writtenPaths.has(rel)) {
          index.entries.push({ relativePath: rel, state: 'link', linkTarget });
          continue;
        }
        const realSrc = await fsPromises.realpath(srcCandidate);
        if (!realSrc.startsWith(realStackRoot + path.sep)) continue;
        // Refuse a fifo, device, or directory before opening it. A blocking
        // open of a fifo waits for a writer and never reaches the descriptor
        // check. Stat does not block. O_NONBLOCK covers a fifo swapped in
        // between this stat and the open; the descriptor check still rejects it.
        const srcStat = await fsPromises.stat(realSrc);
        if (!srcStat.isFile()) {
          throw Object.assign(
            new Error(`Managed path "${rel}" is not a regular file; refusing to snapshot it as absent`),
            { code: 'DIRECTORY_COLLISION' },
          );
        }
        const fh = await fsPromises.open(realSrc, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
        try {
          const { bytes, mode } = await readSnapshotBytes(fh, rel);
          const blobId = randomUUID();
          const blobPath = path.resolve(blobsRoot, blobId);
          if (!blobPath.startsWith(blobsRoot + path.sep)) continue;
          const encrypted = shouldEncryptPreRestore(sensitivity) && bytes.length > 0;
          if (encrypted) {
            const crypto = CryptoService.getInstance();
            const cipher = crypto.encrypt(bytes.toString('base64'));
            if (!crypto.isEncrypted(cipher)) {
              throw new Error(`Could not encrypt pre-restore content for ${rel}`);
            }
            await writePrivate(blobPath, cipher);
          } else {
            await writePrivate(blobPath, bytes);
          }
          index.entries.push({
            relativePath: rel,
            state: 'present',
            blobId,
            mode,
            encrypted,
            linkTarget,
          });
        } finally {
          await fh.close();
        }
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
    await writePrivate(indexPath, JSON.stringify(index));
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
      if (entry.state === 'link') {
        // Recreate the link exactly as it was. The target is deliberately not
        // resolved or checked: it is the operator's own, may sit outside the
        // stack, and restore never wrote through it.
        if (typeof entry.linkTarget !== 'string' || entry.linkTarget === '') {
          throw Object.assign(
            new Error(`Pre-restore link entry for "${rel}" has no target`),
            { code: 'PRE_RESTORE_INDEX_INVALID' },
          );
        }
        const liveKind = await this.lstatManagedPath(nodeId, stackName, rel);
        if (liveKind === 'missing') {
          await this.recreateManagedSymlink(nodeId, stackName, rel, entry.linkTarget);
        }
        continue;
      }
      if (entry.state === 'absent') {
        const liveKind = await this.lstatManagedPath(nodeId, stackName, rel);
        if (liveKind === 'missing') continue;
        if (liveKind !== 'file') {
          throw Object.assign(
            new Error(
              `Managed path "${rel}" is a ${liveKind}; refusing to delete it while reverting an absent-file preimage`,
            ),
            { code: 'DIRECTORY_COLLISION' },
          );
        }
        try {
          await fsSvc.deleteStackPath(stackName, rel, false, scope);
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
      let buf = await fsPromises.readFile(blobPath);
      if (entry.encrypted === true) {
        const cipherText = buf.toString('utf8');
        const crypto = CryptoService.getInstance();
        if (!crypto.isEncrypted(cipherText)) {
          throw new Error(`Pre-restore content for ${rel} is marked encrypted but is not ciphertext`);
        }
        try {
          buf = Buffer.from(crypto.decrypt(cipherText), 'base64');
        } catch (e) {
          throw new Error(
            `Could not decrypt pre-restore content for ${rel}: ${(e as Error).message}`,
            { cause: e },
          );
        }
      }
      // The snapshot recorded this path as a link, so the write below has to go
      // through it to reach the target whose bytes it restores. Put that link
      // back first: if it is gone, or now points somewhere else, writing would
      // drop the bytes in a plain file or through the operator's replacement
      // link, and leave the target the restore actually changed untouched.
      if (typeof entry.linkTarget === 'string' && entry.linkTarget !== '') {
        await this.restoreManagedLinkShape(nodeId, stackName, rel, entry.linkTarget);
      }
      await fsSvc.writeStackFile(stackName, rel, buf);
      // The mode is the target's, and chmodStackPath deliberately refuses to
      // follow a link (so a file-explorer click on a link never mutates a file
      // with a different name). The bytes are back, which is what the revert
      // exists for, so leave the mode rather than abort the whole revert and
      // leave a half-applied restore behind.
      if (typeof entry.mode === 'number' && entry.linkTarget === undefined && process.platform !== 'win32') {
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
    for (const field of [manifest.uncapturedRelativePaths, manifest.uncapturedInputs]) {
      if (field !== undefined && !(Array.isArray(field) && field.every((v) => typeof v === 'string'))) {
        throw new Error('Generation manifest has a malformed uncaptured list');
      }
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

  /** Read and verify a generation manifest by node/stack/id, the safe public reader. */
  static async readVerifiedGeneration(
    nodeId: number,
    stackName: string,
    generationId: string,
  ): Promise<RollbackGenerationManifest> {
    assertSafeStackName(stackName);
    assertSafeGenerationId(generationId);
    const genDir = this.getGenerationDir(nodeId, stackName, generationId);
    const genResolved = path.resolve(genDir);
    return this.readAndVerifyGeneration(genResolved);
  }

  /**
   * Copy present generation compose/project files into destDir for registry-delivery
   * preparation. Preserves stack-relative paths under destDir.
   */
  static async copyPresentFilesToDir(
    nodeId: number,
    stackName: string,
    generationId: string,
    destDir: string,
  ): Promise<void> {
    assertSafeStackName(stackName);
    assertSafeGenerationId(generationId);
    const genDir = this.getGenerationDir(nodeId, stackName, generationId);
    const manifest = await this.readAndVerifyGeneration(genDir);
    await mkdirPrivate(destDir);
    for (const entry of manifest.entries) {
      if (entry.state !== 'present') continue;
      const rel = posixRel(entry.relativePath);
      const dest = path.resolve(destDir, rel);
      const destRoot = path.resolve(destDir);
      if (!dest.startsWith(destRoot + path.sep) && dest !== destRoot) {
        throw Object.assign(new Error('Path escapes restore staging directory'), { code: 'INVALID_PATH' });
      }
      await mkdirPrivate(path.dirname(dest));
      const content = await this.readPresentEntryBytes(genDir, entry);
      await writePrivate(dest, content);
    }
  }
}

export { getBackupBaseDir, getDataDir };
