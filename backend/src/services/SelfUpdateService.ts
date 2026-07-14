import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import DockerController from './DockerController';
import { DatabaseService } from './DatabaseService';
import { disableCapability } from './CapabilityRegistry';
import { isDebugEnabled } from '../utils/debug';
import {
  buildTargetImageRef,
  isRepinBlocked,
  isValidImageRef,
  patchComposeServiceImage,
  resolveServiceImageFromContents,
  type ImagePinKind,
  type ResolvedComposeImage,
} from '../helpers/selfUpdateCompose';

const execFileAsync = promisify(execFile);

// Error file written by the helper container on a failed compose recreate.
// Must live under /app/data so both the helper (via host-path bind mount) and
// the NEW gateway process (which always mounts /app/data) can reach it.
const UPDATE_ERROR_FILE = '/app/data/.sencho-update-error';

// Rewritten compose file the main process stages under /app/data for the helper
// to copy onto the host compose file. Uses the same /app/data handoff as the
// error file because the main process cannot reach the compose working dir.
const STAGED_PATCH_FILE = '/app/data/.sencho-compose-patch';

// Cap how long a cached pin classification is served to status/meta callers.
// Update DECISIONS always read fresh (fresh: true), so this only bounds how
// stale a displayed pin kind can be after a live compose edit.
const PIN_CACHE_TTL_MS = 5 * 60 * 1000;

// Operator-facing block reasons. Deliberately generic: no host paths, compose
// contents, or registry/repository names (this text can reach the UI).
const UPDATE_BLOCKED_REASON =
  'This install pins the Sencho image to a digest or a value Fleet cannot resolve, so it cannot repin automatically. Change the image tag in your compose file, then update again.';
const UPDATE_READ_FAILED_REASON =
  'Could not read the Sencho compose file to determine how its image is pinned. Confirm the update helper can reach the compose directory, then try again.';

interface HostMount {
  source: string;
  destination: string;
}

/** Narrow projection of the Dockerode mount entry we actually consume. */
export type DockerMount = {
  Type: 'bind' | 'volume' | 'tmpfs' | 'npipe' | 'cluster' | 'image';
  Source: string;
  Destination: string;
};

/** Pin classification exposed to callers (status/meta), without file contents. */
export interface PinInfo {
  pinKind: ImagePinKind;
  composeImageRef: string;
  filePath: string;
}

/** Outcome of the pre-update check the route layer runs before responding. */
export type SelfUpdatePreflight = { ok: true } | { ok: false; reason: string };

/** A staged compose rewrite the helper copies onto the host before recreate. */
export interface ComposeCopy {
  stagedPath: string;
  targetPath: string;
}

/**
 * Find the host-side path Docker resolved for /app/data, regardless of whether
 * the operator declared a bind or a named volume. The helper container uses
 * this path to mount /app/data:rw so it can write UPDATE_ERROR_FILE when a
 * compose recreate fails before the gateway can persist the error itself.
 */
export function findDataDirHost(mounts: ReadonlyArray<DockerMount>): string | null {
  const match = mounts.find(m =>
    m.Destination === '/app/data' &&
    (m.Type === 'bind' || m.Type === 'volume') &&
    !!m.Source,
  );
  return match?.Source ?? null;
}

// POSIX single-quote escaping. serviceName and the compose config paths in
// fFlags come from Docker Compose labels on Sencho's own container, so a label
// carrying shell metacharacters must not be able to break out of the command
// sequence (the exit-code capture, error-file write, and prune guard).
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the argv for a one-shot helper that reads a single compose config file
 * from the host. The main process cannot open the compose working dir, so it
 * mounts it read-only into a throwaway container and cats the file out. Pure and
 * exported for unit testing. The path is a discrete argv element handed to
 * execFile (no shell), so a path with shell metacharacters stays inert.
 */
export function buildComposeReadArgs(workingDir: string, imageName: string, configFilePath: string): string[] {
  return [
    'run', '--rm',
    '--user', 'root',
    '--entrypoint', 'cat',
    '-v', `${workingDir}:${workingDir}:ro`,
    '-w', workingDir,
    imageName,
    configFilePath,
  ];
}

/**
 * Build the shell command the helper container runs to recreate Sencho. Kept as
 * a pure, exported function so the prune-on-update and repin-copy branches are
 * unit-testable.
 *
 * Label-derived inputs (serviceName, the fFlags config paths) and the repin copy
 * paths are shell-quoted so they cannot alter the command structure. When a
 * composeCopy is present the rewritten compose file is copied onto the host
 * BEFORE the recreate; a failed copy aborts before recreate so a half-applied
 * update never runs. The recreate writes the error file only on failure; the
 * optional dangling prune runs only on success, so the branches never overlap.
 */
export function buildSelfUpdateComposeCmd(
  fFlags: string[],
  serviceName: string,
  stderrTmp: string,
  errorFile: string,
  pruneOnUpdate: boolean,
  composeCopy?: ComposeCopy,
  successMarkerFile?: string,
  successMarkerContent = '{"ok":true}',
): string {
  const recreate = ['docker compose', ...fFlags.map(shQuote), 'up -d --force-recreate', shQuote(serviceName), `2>${stderrTmp}`].join(' ');
  const copyStep = composeCopy
    ? [`cp ${shQuote(composeCopy.stagedPath)} ${shQuote(composeCopy.targetPath)} 2>${stderrTmp} || { { echo "exit=1"; echo "Failed to write the updated compose file"; cat ${stderrTmp}; } > ${errorFile} 2>/dev/null; exit 1; }`]
    : [];
  return [
    'sleep 3',
    ...copyStep,
    recreate,
    'ec=$?',
    `if [ $ec -ne 0 ]; then { echo "exit=$ec"; cat ${stderrTmp}; } > ${errorFile} 2>/dev/null; fi`,
    ...(pruneOnUpdate
      ? [`if [ $ec -eq 0 ]; then docker image prune -f >/dev/null 2>&1 || true; fi`]
      : []),
    ...(successMarkerFile
      ? [`if [ $ec -eq 0 ]; then printf %s ${shQuote(successMarkerContent)} > ${shQuote(successMarkerFile)}; fi`]
      : []),
    `cat ${stderrTmp} >&2 2>/dev/null`,
    'exit $ec',
  ].join('; ');
}

interface ComposeContext {
  workingDir: string;
  configFiles: string;
  serviceName: string;
  imageName: string;
  dataDirHost: string | null;
  hostBindMounts: HostMount[];
}

/**
 * Build the `docker run` argv for the self-update helper container. Pure and
 * exported so the mount construction is unit-testable alongside the compose
 * command it carries.
 *
 * workingDir, dataDirHost, and the host bind-mount sources are operator-set
 * paths (compose labels / container mounts). They are placed as discrete argv
 * elements and handed to execFile, which spawns docker with no shell, so a path
 * carrying shell metacharacters stays inert data and never reaches a shell.
 *
 * workingDir is mounted read-only unless `repinWritable` is set, which happens
 * only for a semver repin that must copy the rewritten compose file onto the
 * host. Limiting :rw to that case keeps the helper's host write scope minimal.
 */
export function buildSelfUpdateRunArgs(
  ctx: Pick<ComposeContext, 'workingDir' | 'imageName' | 'dataDirHost' | 'hostBindMounts'> & { repinWritable?: boolean },
  composeCmd: string,
): string[] {
  const { workingDir, imageName, dataDirHost, hostBindMounts, repinWritable } = ctx;
  const mountArgs: string[] = [
    '-v', '/var/run/docker.sock:/var/run/docker.sock',
    '-v', `${workingDir}:${workingDir}:${repinWritable ? 'rw' : 'ro'}`,
  ];
  if (dataDirHost) {
    mountArgs.push('-v', `${dataDirHost}:/app/data:rw`);
  }
  const alreadyMounted = new Set([
    '/var/run/docker.sock', workingDir, ...(dataDirHost ? [dataDirHost] : []),
  ]);
  for (const { source } of hostBindMounts) {
    if (alreadyMounted.has(source) || source.startsWith(workingDir + '/')) continue;
    mountArgs.push('-v', `${source}:${source}:ro`);
  }
  return [
    'run', '--rm',
    '--user', 'root',
    '--entrypoint', 'sh',
    ...mountArgs,
    '-w', workingDir,
    imageName,
    '-c', composeCmd,
  ];
}

class SelfUpdateService {
  private static instance: SelfUpdateService;
  private canSelfUpdate = false;
  private composeContext: ComposeContext | null = null;
  private lastUpdateError: string | null = null;
  private helperExitListeners: Array<(error: string | null) => void> = [];
  private pinCache: { info: ResolvedComposeImage | null; at: number } | null = null;

  public static getInstance(): SelfUpdateService {
    if (!SelfUpdateService.instance) {
      SelfUpdateService.instance = new SelfUpdateService();
    }
    return SelfUpdateService.instance;
  }

  async initialize(): Promise<void> {
    const hostname = process.env.HOSTNAME;
    if (!hostname) {
      console.log('[SelfUpdate] HOSTNAME not set - self-update unavailable (not running in Docker?)');
      disableCapability('self-update');
      return;
    }

    try {
      const docker = DockerController.getInstance().getDocker();
      const container = docker.getContainer(hostname);
      const info = await container.inspect();
      const labels = info.Config?.Labels ?? {};

      const workingDir = labels['com.docker.compose.project.working_dir'];
      const configFiles = labels['com.docker.compose.project.config_files'];
      const serviceName = labels['com.docker.compose.service'];

      if (!workingDir || !configFiles || !serviceName) {
        console.log('[SelfUpdate] Container lacks Docker Compose labels - self-update unavailable');
        disableCapability('self-update');
        return;
      }

      // Verify docker compose CLI is available inside the container.
      // execFileAsync (not Sync) so the parallel boot-task block in
      // bootstrap/startup.ts can actually run TrivyService and DockerEventManager
      // concurrently instead of waiting on a 5s blocking spawn here.
      try {
        await execFileAsync('docker', ['compose', 'version'], { timeout: 5000 });
      } catch {
        console.log('[SelfUpdate] docker compose CLI not available in container');
        disableCapability('self-update');
        return;
      }

      // Read the container's own image name for the legacy (no target) pull and
      // as a fallback ref. It is captured once here and can go stale if the
      // compose file is edited later, so update decisions resolve the compose
      // image fresh instead of trusting this value.
      const imageName = info.Config?.Image;
      if (!imageName) {
        console.log('[SelfUpdate] Could not determine container image name');
        disableCapability('self-update');
        return;
      }

      // Collect all host bind mounts so the helper container can forward them.
      // This lets docker compose resolve env_file, configs, secrets, and any
      // other host-path references that live outside the compose working dir.
      const rawMounts = (info.Mounts ?? []) as DockerMount[];
      const hostBindMounts: HostMount[] = rawMounts
        .filter(m => m.Type === 'bind' && m.Source && m.Destination)
        .map(m => ({ source: m.Source, destination: m.Destination }));

      const dataDirHost = findDataDirHost(rawMounts);
      if (!dataDirHost) {
        console.log('[SelfUpdate] /app/data mount not found - update error recovery and compose repin will be unavailable');
      }

      this.composeContext = { workingDir, configFiles, serviceName, imageName, dataDirHost, hostBindMounts };
      this.canSelfUpdate = true;
      console.log(`[SelfUpdate] Ready - service="${serviceName}" image="${imageName}" in ${workingDir}`);

      // Warm the pin-info cache in the background for diagnostics and the first
      // status/meta read. This is never a source of truth for an update
      // decision, which always resolves fresh.
      void this.resolveComposeImage(true)
        .then(resolved => {
          if (resolved) console.log(`[SelfUpdate] Compose image pin: ${resolved.imageRef} (${resolved.pinKind})`);
        })
        .catch(() => { /* diagnostic only */ });

      // Surface any error from a previous failed update attempt (persisted by
      // the helper container) so the new process can report it to the user.
      this.recoverPreviousError();
    } catch (error) {
      console.log('[SelfUpdate] Could not inspect own container - self-update unavailable:', (error as Error).message);
      disableCapability('self-update');
    }
  }

  isAvailable(): boolean {
    return this.canSelfUpdate;
  }

  /** Returns the error message from the last failed update attempt, or null. */
  getLastError(): string | null {
    return this.lastUpdateError;
  }

  /** Register a one-shot listener for the helper container's execFile callback. */
  onceHelperExit(listener: (error: string | null) => void): void {
    this.helperExitListeners.push(listener);
  }

  /** Clears the stored update error (call after reading it). */
  clearLastError(): void {
    this.lastUpdateError = null;
  }

  /**
   * Classify how this instance's compose image is pinned. Serves a short-lived
   * cache to frequent status/meta callers; pass `{ fresh: true }` for update
   * decisions so a live compose edit is always reflected. Returns null when
   * self-update is unavailable or the compose file could not be read.
   */
  async getPinInfo(opts?: { fresh?: boolean; cacheOnly?: boolean }): Promise<PinInfo | null> {
    const resolved = await this.resolveComposeImage(opts?.fresh ?? false, opts?.cacheOnly ?? false);
    if (!resolved) return null;
    return { pinKind: resolved.pinKind, composeImageRef: resolved.imageRef, filePath: resolved.filePath };
  }

  /** Fresh compose image resolution for guarded image-channel operations. */
  async getResolvedComposeImageForUpdate(): Promise<ResolvedComposeImage | null> {
    return this.resolveComposeImage(true);
  }

  getComposeServiceName(): string | null {
    return this.composeContext?.serviceName ?? null;
  }

  /**
   * Preflight the route layer runs before responding, so a blocked update fails
   * fast with a 409 instead of returning 202 and stalling the reconnect overlay.
   * A missing target version is the legacy pull-current path and makes no repin
   * decision. A digest/unknown pin (or an unreadable compose file) is blocked.
   */
  async canSelfUpdateTarget(targetVersion?: string): Promise<SelfUpdatePreflight> {
    if (!this.canSelfUpdate) {
      return { ok: false, reason: 'Self-update is unavailable on this instance.' };
    }
    if (!targetVersion) return { ok: true };
    const info = await this.getPinInfo({ fresh: true });
    if (!info) return { ok: false, reason: UPDATE_READ_FAILED_REASON };
    if (isRepinBlocked(info.pinKind)) {
      return { ok: false, reason: UPDATE_BLOCKED_REASON };
    }
    return { ok: true };
  }

  /** Resolve the compose-declared service image fresh from the host, or from a
   *  short-lived cache. Reads each config file via a throwaway cat container. */
  private async resolveComposeImage(fresh: boolean, cacheOnly = false): Promise<ResolvedComposeImage | null> {
    if (!this.composeContext) return null;
    const now = Date.now();
    if (!fresh && this.pinCache && now - this.pinCache.at < PIN_CACHE_TTL_MS) {
      return this.pinCache.info;
    }
    if (cacheOnly) return null;
    const { workingDir, configFiles, serviceName, imageName } = this.composeContext;
    const env = this.buildEnv();
    const debug = isDebugEnabled();
    const files: { filePath: string; content: string }[] = [];
    for (const raw of configFiles.split(',')) {
      const filePath = raw.trim();
      if (!filePath) continue;
      try {
        const { stdout } = await execFileAsync('docker', buildComposeReadArgs(workingDir, imageName, filePath), {
          env,
          timeout: 30_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        files.push({ filePath, content: stdout });
      } catch (error) {
        if (debug) console.debug('[SelfUpdate:debug] Could not read compose file', filePath, (error as Error).message);
      }
    }
    const info = resolveServiceImageFromContents(files, serviceName);
    this.pinCache = { info, at: now };
    return info;
  }

  private buildEnv(): NodeJS.ProcessEnv {
    return { ...process.env, PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' };
  }

  /** Surfaces any error the helper container persisted before the previous
   *  gateway process died, then deletes the file. */
  private recoverPreviousError(): void {
    try {
      const content = fs.readFileSync(UPDATE_ERROR_FILE, 'utf8').trim();
      if (content) {
        this.lastUpdateError = content;
        console.error('[SelfUpdate] Recovered error from previous update attempt:', content);
      }
      fs.unlinkSync(UPDATE_ERROR_FILE);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error('[SelfUpdate] Failed to recover previous update error:', (error as Error).message);
      }
    }
  }

  /**
   * Pull the target image, then (for a semver pin) rewrite the compose tag and
   * recreate. Pull happens BEFORE any compose mutation, so a failed pull leaves
   * the compose file untouched. `targetVersion` comes from the Fleet compare
   * target; when omitted this keeps the legacy behavior of pulling the running
   * image and recreating from the on-disk compose.
   */
  async triggerUpdate(options?: {
    targetVersion?: string;
    targetImageRef?: string;
    dockerConfigPath?: string;
    successMarkerFile?: string;
    successMarkerContent?: string;
  }): Promise<void> {
    if (!this.composeContext) return;
    const env = {
      ...this.buildEnv(),
      ...(options?.dockerConfigPath ? { DOCKER_CONFIG: options.dockerConfigPath } : {}),
    };
    this.lastUpdateError = null;

    try { fs.unlinkSync(UPDATE_ERROR_FILE); } catch { /* absent is the steady state */ }
    try { fs.unlinkSync(STAGED_PATCH_FILE); } catch { /* absent is the steady state */ }

    const { imageName, serviceName, dataDirHost } = this.composeContext;
    const targetVersion = options?.targetVersion;
    const targetImageRef = options?.targetImageRef;

    let pullRef = imageName;
    let repin: { resolved: ResolvedComposeImage; ref: string } | null = null;

    if (targetVersion || targetImageRef) {
      const resolved = await this.resolveComposeImage(true);
      const pinKind = resolved?.pinKind ?? 'unknown';
      // Defense in depth: the route preflight already rejected these, but the
      // compose file could change between preflight and this last-breath call.
      if (!resolved || (!targetImageRef && isRepinBlocked(pinKind))) {
        this.lastUpdateError = resolved ? UPDATE_BLOCKED_REASON : UPDATE_READ_FAILED_REASON;
        console.error('[SelfUpdate] Update blocked:', this.lastUpdateError);
        return;
      }
      pullRef = targetImageRef ?? (pinKind === 'semver'
        ? buildTargetImageRef(resolved.imageRef, targetVersion!)
        : resolved.imageRef);
      if (!isValidImageRef(pullRef)) {
        this.lastUpdateError = 'Aborting update: the computed image reference is invalid.';
        console.error('[SelfUpdate] Update blocked:', this.lastUpdateError, pullRef);
        return;
      }
      if (pinKind === 'semver' || targetImageRef) {
        if (!dataDirHost) {
          this.lastUpdateError =
            'Cannot rewrite the pinned compose image: the data directory needed for the update handoff is not mounted. Change the image tag manually and update again.';
          console.error('[SelfUpdate] Repin blocked:', this.lastUpdateError);
          return;
        }
        repin = { resolved, ref: pullRef };
      }
    }

    // Pull FIRST so the compose file is never mutated for an image we could not
    // fetch. A sync execFileSync would block the event loop and let the overlay
    // see a false "online" between the pull finishing and the restart.
    const debug = isDebugEnabled();
    const pullStart = Date.now();
    console.log(`[SelfUpdate] Pulling image: ${pullRef}...`);
    if (debug) console.debug('[SelfUpdate:debug] Pull context:', { targetVersion: targetVersion ?? null, repin: !!repin });
    try {
      await execFileAsync('docker', ['pull', pullRef], { env, timeout: 300_000 });
      if (debug) console.debug('[SelfUpdate:debug] Pull completed in', Math.round((Date.now() - pullStart) / 1000) + 's');
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string })?.stderr?.toString().trim();
      this.lastUpdateError = stderr || (error as Error).message;
      console.error('[SelfUpdate] Pull failed:', this.lastUpdateError);
      return;
    }

    // Rewrite the pinned tag only after a confirmed pull (semver only). The
    // rewrite is staged under /app/data; the helper copies it onto the host
    // compose file just before recreate.
    let composeCopy: ComposeCopy | undefined;
    if (repin) {
      try {
        const patched = patchComposeServiceImage(repin.resolved.fileContent, serviceName, repin.ref);
        fs.writeFileSync(STAGED_PATCH_FILE, patched, 'utf8');
        composeCopy = { stagedPath: STAGED_PATCH_FILE, targetPath: repin.resolved.filePath };
        console.log(`[SelfUpdate] Repinning "${serviceName}" image to ${repin.ref}`);
      } catch (error) {
        this.lastUpdateError =
          `Pulled ${repin.ref} but could not rewrite the compose image tag (${(error as Error).message}). Change the tag manually and update again.`;
        console.error('[SelfUpdate] Repin failed:', this.lastUpdateError);
        return;
      }
    }

    this.spawnHelper(env, composeCopy, options?.successMarkerFile, options?.successMarkerContent);
  }

  /**
   * Spawn the "last breath" helper container that recreates Sencho (and, when a
   * repin is staged, copies the rewritten compose file onto the host first).
   * Runs attached (no -d): if the recreate fails before it kills us, execFile's
   * callback receives the helper's exit code and stderr directly.
   */
  private spawnHelper(
    env: NodeJS.ProcessEnv,
    composeCopy?: ComposeCopy,
    successMarkerFile?: string,
    successMarkerContent?: string,
  ): void {
    if (!this.composeContext) return;
    const { workingDir, configFiles, serviceName, imageName, dataDirHost, hostBindMounts } = this.composeContext;

    console.log('[SelfUpdate] Spawning updater container... (last breath)');
    if (isDebugEnabled()) console.debug('[SelfUpdate:debug] Helper context:', { workingDir, serviceName, dataDirHost, repin: !!composeCopy, mountCount: hostBindMounts.length });
    const fFlags = configFiles.split(',').flatMap(f => ['-f', f.trim()]);

    // On failure, persist exit code + stderr to UPDATE_ERROR_FILE (host-mounted)
    // so the NEW gateway can read it after restart if we die mid-execution.
    // Opt-out (default ON): after a clean recreate, prune the dangling image
    // layers the pull orphaned. Read fresh so this node honors its own setting.
    const stderrTmp = '/tmp/_sencho_err';
    const pruneOnUpdate =
      DatabaseService.getInstance().getGlobalSettings()['prune_on_update'] === '1';
    const composeCmd = buildSelfUpdateComposeCmd(
      fFlags,
      serviceName,
      stderrTmp,
      UPDATE_ERROR_FILE,
      pruneOnUpdate,
      composeCopy,
      successMarkerFile,
      successMarkerContent,
    );
    const args = buildSelfUpdateRunArgs({ workingDir, imageName, dataDirHost, hostBindMounts, repinWritable: !!composeCopy }, composeCmd);

    // Callback may never fire on success (we die mid-call during recreate);
    // that is fine because the restart itself is the success signal.
    execFile('docker', args, { env }, (err, _stdout, stderr) => {
      if (err) {
        const stderrText = stderr?.toString().trim();
        this.lastUpdateError = stderrText || err.message || 'Helper container failed';
        console.error('[SelfUpdate] Helper container failed:', this.lastUpdateError);
      }
      const listeners = this.helperExitListeners.splice(0);
      for (const listener of listeners) {
        try {
          listener(this.lastUpdateError);
        } catch (listenerError) {
          console.error('[SelfUpdate] Helper exit listener failed:', listenerError);
        }
      }
    });
    // No code after this point is guaranteed to run: the helper recreates this container.
  }
}

export default SelfUpdateService;
