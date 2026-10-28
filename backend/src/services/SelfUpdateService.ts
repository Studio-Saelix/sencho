import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import DockerController from './DockerController';
import { DatabaseService } from './DatabaseService';
import { disableCapability } from './CapabilityRegistry';
import { resolveDockerEndpointProvider, type DockerEndpointContainer } from './DockerEndpointProvider';
import { isDebugEnabled } from '../utils/debug';
import { getErrorMessage } from '../utils/errors';
import {
  ENDPOINT_PROVIDER_HELPER_MAX_LIFETIME_MS,
  ENDPOINT_PROVIDER_STAGE_TIMEOUT_MS,
  HELPER_DATA_DIR,
  HELPER_SOCKET_PATH,
  PROVIDER_ACK_SECONDS,
  PROVIDER_READY_SECONDS,
  endpointProviderHelperName,
  type ProviderReplaceMode,
  type ProviderReplacePlan,
  type StageResult,
} from '../helpers/endpointProviderReplace';
import {
  buildTargetImageRef,
  isRepinBlocked,
  isValidImageRef,
  patchComposeServiceImage,
  resolveServiceImageFromContents,
  type ImagePinKind,
  type ResolvedComposeImage,
} from '../helpers/selfUpdateCompose';

export {
  ENDPOINT_PROVIDER_HELPER_MAX_LIFETIME_MS,
  ENDPOINT_PROVIDER_STAGE_TIMEOUT_MS,
  PROVIDER_ACK_SECONDS,
  PROVIDER_READY_SECONDS,
};

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

/** Ceiling for pulling the Sencho image before an endpoint replacement stages. */
export const SELF_UPDATE_PULL_TIMEOUT_MS = 5 * 60_000;

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
  // --no-deps: only Sencho is recreated, never a dependency Compose would
  // otherwise restart with it (such as the proxy carrying the Docker API).
  const recreate = ['docker compose', ...fFlags.map(shQuote), 'up -d --no-deps --force-recreate', shQuote(serviceName), `2>${stderrTmp}`].join(' ');
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
  /** Compose project label of Sencho's own container. */
  project: string | null;
  /** Image ID of the running container, so a helper runs exactly this build. */
  runningImageId: string | null;
}

/**
 * Whether Fleet Update and Reapply can also recreate the container that
 * carries this node's Docker API. `none` means Sencho does not reach Docker
 * through a container; `unavailable` names the provider when known and why it
 * cannot be replaced from here.
 */
export type EndpointProviderOption =
  | { state: 'none' }
  | { state: 'available'; service: string; containerName: string; project: string | null; providerOnly: boolean }
  | { state: 'unavailable'; service: string | null; reason: string };

/** A replacement Sencho can run: the option plus what the helper needs. */
interface ReplaceableProvider {
  provider: DockerEndpointContainer & { service: string; socketBindSource: string };
}

/**
 * Build the `docker run` argv for the Docker endpoint replacement helper. It
 * mounts the host socket the provider itself mounts (never a guessed path), so
 * the helper keeps its own connection while the provider is recreated, and runs
 * the image of the running Sencho by ID so the helper script is the one this
 * process shipped with. `replace` runs detached: an attached client would
 * stream through the provider being replaced and die with it.
 */
export function buildEndpointProviderHelperArgs(input: {
  mode: 'stage' | 'replace';
  operationId: string;
  socketSource: string;
  workingDir: string;
  dataDirHost: string;
  hostBindMounts: ReadonlyArray<HostMount>;
  imageId: string;
  composeWritable: boolean;
  /**
   * Keys Docker copies from the CLI environment into the helper, so `docker
   * compose` interpolates the authored project as Sencho would. The values stay
   * in this process's environment and never reach the command line.
   */
  envKeys: ReadonlyArray<string>;
  /** Application uid/gid that must read the helper's marker and outcome files. */
  handoffOwner: { uid: number; gid: number } | null;
}): string[] {
  const { mode, operationId, socketSource, workingDir, dataDirHost, hostBindMounts, imageId, composeWritable, envKeys, handoffOwner } = input;
  const ownerArgs = handoffOwner
    ? ['-e', `SENCHO_HANDOFF_UID=${handoffOwner.uid}`, '-e', `SENCHO_HANDOFF_GID=${handoffOwner.gid}`]
    : [];
  const mountArgs: string[] = [
    '-v', `${socketSource}:${HELPER_SOCKET_PATH}`,
    '-v', `${workingDir}:${workingDir}:${composeWritable ? 'rw' : 'ro'}`,
    '-v', `${dataDirHost}:${HELPER_DATA_DIR}:rw`,
  ];
  const alreadyMounted = new Set([socketSource, workingDir, dataDirHost]);
  for (const { source } of hostBindMounts) {
    if (alreadyMounted.has(source) || source.startsWith(workingDir + '/')) continue;
    alreadyMounted.add(source);
    mountArgs.push('-v', `${source}:${source}:ro`);
  }
  return [
    // The detached phase is created first and started separately: a create that
    // reported an error can still have made the container, but a created
    // container cannot mutate anything until it is started.
    mode === 'replace' ? 'create' : 'run',
    '--rm',
    ...(mode === 'replace' ? ['--name', endpointProviderHelperName(operationId)] : []),
    '--user', 'root',
    '--label', 'io.sencho.helper=endpoint-provider',
    // The operation id lets a lost `docker run` answer be classified against a
    // helper that really exists, so an ambiguous start never releases the claim
    // while a helper can still mutate the endpoint.
    '--label', `io.sencho.operation=${operationId}`,
    // The Sencho image's HEALTHCHECK probes a server the helper never starts;
    // over a run of minutes it would report the helper unhealthy and alert.
    '--no-healthcheck',
    ...envKeys.flatMap(key => ['-e', key]),
    '-e', `DOCKER_HOST=unix://${HELPER_SOCKET_PATH}`,
    ...ownerArgs,
    '--entrypoint', 'node',
    ...mountArgs,
    '-w', workingDir,
    imageId,
    '/app/dist/endpointProviderHelper.js', mode, operationId,
  ];
}

/**
 * This process's uid/gid, passed to the root helper so the marker and outcome
 * it writes are readable when Sencho runs as `SENCHO_USER`. Null on a platform
 * without process ids; the helper then leaves the files root-owned.
 */
function processHandoffOwner(): { uid: number; gid: number } | null {
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') return null;
  return { uid: process.getuid(), gid: process.getgid() };
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
  ctx: Pick<ComposeContext, 'workingDir' | 'imageName' | 'dataDirHost' | 'hostBindMounts'> & {
    repinWritable?: boolean;
    /** Compose interpolation inputs copied from this process by key, never by value. */
    envKeys?: ReadonlyArray<string>;
  },
  composeCmd: string,
): string[] {
  const { workingDir, imageName, dataDirHost, hostBindMounts, repinWritable, envKeys = [] } = ctx;
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
    ...envKeys.flatMap(key => ['-e', key]),
    ...mountArgs,
    '-w', workingDir,
    imageName,
    '-c', composeCmd,
  ];
}

/**
 * Build the argv for a throwaway helper that runs `docker compose … config`
 * against the host compose project. Reuses the recreate helper's mount layout
 * (socket + working dir + host binds) without mounting /app/data, since
 * validation is read-only. Pure and exported for unit testing.
 */
export function buildComposeConfigValidateArgs(
  ctx: Pick<ComposeContext, 'workingDir' | 'imageName' | 'hostBindMounts'> & {
    configFiles: string;
    /** The same Compose interpolation inputs the staging and replacement helpers receive. */
    envKeys?: ReadonlyArray<string>;
  },
): string[] {
  const { workingDir, imageName, hostBindMounts, configFiles, envKeys } = ctx;
  const fFlags = configFiles.split(',').flatMap(f => {
    const trimmed = f.trim();
    return trimmed ? ['-f', trimmed] : [];
  });
  const composeCmd = ['docker compose', ...fFlags.map(shQuote), 'config'].join(' ');
  return buildSelfUpdateRunArgs(
    { workingDir, imageName, dataDirHost: null, hostBindMounts, envKeys },
    composeCmd,
  );
}

/** What the operation layer passes to run a Docker endpoint replacement. */
export interface EndpointProviderRequest {
  operationId: string;
  /** The service the operator confirmed; a different provider at run time is refused. */
  service: string;
  /**
   * `provider` replaces only the endpoint container and leaves Sencho running;
   * `stack` also recreates Sencho. Image updates always recreate Sencho.
   */
  scope: 'provider' | 'stack';
  /** Sencho-side directory holding the handoff files; the helper sees it under /app/data. */
  handoffDir: string;
  planFile: string;
}

const STAGE_UNREADABLE = 'The staging helper returned no readable result.';

export function parseStageResult(stdout: string): StageResult {
  try {
    const parsed = JSON.parse(stdout.trim()) as Partial<StageResult> & { message?: unknown; providerImage?: unknown; previousImageId?: unknown; previousImageRef?: unknown };
    if (parsed.ok === true && typeof parsed.providerImage === 'string' && typeof parsed.previousImageId === 'string') {
      return {
        ok: true,
        providerImage: parsed.providerImage,
        previousImageId: parsed.previousImageId,
        previousImageRef: typeof parsed.previousImageRef === 'string' ? parsed.previousImageRef : null,
      };
    }
    if (parsed.ok === false && typeof parsed.message === 'string') return { ok: false, message: parsed.message };
  } catch {
    // Fall through: not the helper's JSON.
  }
  return { ok: false, message: STAGE_UNREADABLE };
}

class SelfUpdateService {
  private static instance: SelfUpdateService;
  private canSelfUpdate = false;
  private composeContext: ComposeContext | null = null;
  private lastUpdateError: string | null = null;
  private lastUpdateErrorCode: string | null = null;
  /** Stashed when the helper exits before any onceHelperExit listener is registered. */
  private pendingHelperExitError: string | undefined = undefined;
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

      this.composeContext = {
        workingDir, configFiles, serviceName, imageName, dataDirHost, hostBindMounts,
        project: labels['com.docker.compose.project'] || null,
        runningImageId: typeof info.Image === 'string' && info.Image ? info.Image : null,
      };
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

  /** Bounded code for the last failure, for the public meta endpoint; null when there is none. */
  getLastErrorCode(): string | null {
    if (!this.getLastError()) return null;
    return this.lastUpdateErrorCode ?? 'update_failed';
  }

  /** Records a failure reported after the helper ran (the endpoint replacement outcome). */
  recordUpdateFailure(message: string, code: string): void {
    this.lastUpdateError = message;
    this.lastUpdateErrorCode = code;
  }

  /** Register a one-shot listener for the helper container's execFile callback. */
  onceHelperExit(listener: (error: string | null) => void): void {
    if (this.pendingHelperExitError !== undefined) {
      const error = this.pendingHelperExitError;
      this.pendingHelperExitError = undefined;
      queueMicrotask(() => {
        try {
          listener(error);
        } catch (listenerError) {
          console.error('[SelfUpdate] Helper exit listener failed:', listenerError);
        }
      });
      return;
    }
    this.helperExitListeners.push(listener);
  }

  /** Clears the stored update error (call after reading it). */
  clearLastError(): void {
    this.lastUpdateError = null;
    this.lastUpdateErrorCode = null;
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

  getComposeProject(): string | null {
    return this.composeContext?.project ?? null;
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
    /** Also recreate the Docker endpoint provider, through the replacement helper. */
    endpointProvider?: EndpointProviderRequest;
  }): Promise<void> {
    if (!this.composeContext) return;
    const env = {
      ...this.buildEnv(),
      ...(options?.dockerConfigPath ? { DOCKER_CONFIG: options.dockerConfigPath } : {}),
    };
    this.clearLastError();
    this.pendingHelperExitError = undefined;

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
      await execFileAsync('docker', ['pull', pullRef], { env, timeout: SELF_UPDATE_PULL_TIMEOUT_MS });
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

    if (options?.endpointProvider) {
      await this.runEndpointProviderReplacement(env, options.endpointProvider, 'update', composeCopy ?? null);
      return;
    }
    this.spawnHelper(env, this.helperEnvKeys(env), composeCopy, options?.successMarkerFile, options?.successMarkerContent);
  }

  /**
   * Recreate the Sencho service from the exact current on-disk Compose project
   * without pulling or rewriting the image reference. Used by Fleet "Reapply
   * configuration". Validates the authored compose via a throwaway helper
   * before the last-breath recreate so invalid config fails before shutdown.
   */
  async triggerComposeReapply(options?: {
    successMarkerFile?: string;
    successMarkerContent?: string;
    /** Also recreate the Docker endpoint provider, through the replacement helper. */
    endpointProvider?: EndpointProviderRequest;
  }): Promise<void> {
    if (!this.composeContext) return;
    const env = this.buildEnv();
    this.clearLastError();
    this.pendingHelperExitError = undefined;

    try { fs.unlinkSync(UPDATE_ERROR_FILE); } catch { /* absent is the steady state */ }
    try { fs.unlinkSync(STAGED_PATCH_FILE); } catch { /* absent is the steady state */ }

    const { workingDir, configFiles, imageName, hostBindMounts } = this.composeContext;
    // The validation helper must interpolate the authored project with the same
    // process values the staging and replacement helpers receive. Otherwise a
    // required variable is refused before anything runs, and a defaulted one is
    // validated against a different effective configuration.
    const envKeys = this.helperEnvKeys(env);
    console.log('[SelfUpdate] Validating compose configuration before reapply...');
    try {
      await execFileAsync(
        'docker',
        buildComposeConfigValidateArgs({ workingDir, imageName, hostBindMounts, configFiles, envKeys }),
        { env, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      );
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string })?.stderr?.toString().trim();
      const stdout = (error as { stdout?: Buffer | string })?.stdout?.toString().trim();
      const detail = stderr || stdout || (error as Error).message || 'Compose configuration validation failed.';
      if (options?.endpointProvider) {
        this.refuseEndpointProviderReplacement(`Nothing was stopped. ${detail}`);
      } else {
        this.lastUpdateError = detail;
        console.error('[SelfUpdate] Compose reapply validation failed:', this.lastUpdateError);
      }
      return;
    }

    // No Sencho pull and no compose rewrite: the authored image ref is authoritative.
    // Skip dangling-image prune (nothing was pulled).
    if (options?.endpointProvider) {
      await this.runEndpointProviderReplacement(env, options.endpointProvider, 'reapply', null);
      return;
    }
    this.spawnHelper(env, envKeys, undefined, options?.successMarkerFile, options?.successMarkerContent, false);
  }

  /** Whether Update and Reapply can also recreate the container carrying this node's Docker API. */
  async getEndpointProviderOption(): Promise<EndpointProviderOption> {
    const result = await this.resolveReplaceableProvider();
    if ('state' in result) return result;
    return {
      state: 'available',
      service: result.provider.service,
      containerName: result.provider.containerName,
      project: result.provider.project,
      // This build can recreate the endpoint on its own; the flag lets the hub
      // withhold the option from nodes that cannot.
      providerOnly: true,
    };
  }

  /**
   * The endpoint provider, when it can be replaced from here. It must be a
   * service of Sencho's own Compose project (an unrelated proxy is not
   * Sencho's to recreate), mount the host Docker socket the helper will use,
   * and the data directory must be mounted for the helper's handoff files.
   */
  private async resolveReplaceableProvider(): Promise<ReplaceableProvider | Exclude<EndpointProviderOption, { state: 'available' }>> {
    let resolved;
    try {
      resolved = await resolveDockerEndpointProvider();
    } catch (error) {
      return { state: 'unavailable', service: null, reason: `Sencho could not identify the container carrying its Docker connection (${getErrorMessage(error, 'lookup failed')}).` };
    }
    if (resolved.state === 'none') return { state: 'none' };
    if (resolved.state === 'unresolved') return { state: 'unavailable', service: null, reason: resolved.reason };
    const provider = resolved.provider;
    const name = provider.service ?? provider.containerName;
    const unavailable = (reason: string) => ({ state: 'unavailable' as const, service: provider.service, reason });
    const ctx = this.composeContext;
    if (!this.canSelfUpdate || !ctx) return unavailable('Self-update is unavailable on this instance.');
    if (!provider.service || !provider.project || provider.project !== ctx.project || provider.workingDir !== ctx.workingDir) {
      return unavailable(`"${name}" carries Sencho's Docker connection but is not a service of Sencho's own Compose project, so Update and Reapply cannot recreate it. Recreate it from its own project on the host.`);
    }
    if (provider.service === ctx.serviceName) return unavailable('The Docker endpoint resolves to Sencho itself.');
    if (!provider.socketBindSource || !provider.socketBindSource.startsWith('/')) {
      return unavailable(`"${name}" does not bind-mount the host Docker socket, so the replacement helper has no direct Docker connection to use while it is recreated.`);
    }
    if (!ctx.dataDirHost) return unavailable('The Sencho data directory is not mounted, so the replacement helper cannot report its outcome.');
    if (!ctx.runningImageId) return unavailable('Sencho could not determine the image it is running.');
    return { provider: { ...provider, service: provider.service, socketBindSource: provider.socketBindSource } };
  }

  /** Records a pre-cutover refusal with a bounded code for /api/meta. */
  private refuseEndpointProviderReplacement(message: string): void {
    this.lastUpdateError = message;
    // A bounded code for /api/meta: Fleet cannot safely receive the free text,
    // but it must not reduce every pre-cutover refusal to "update_failed".
    this.lastUpdateErrorCode = 'endpoint_provider_refused';
    console.error('[SelfUpdate] Docker endpoint replacement refused:', message);
  }

  /**
   * Environment keys Docker copies from this process into the helper, so
   * Compose interpolation sees the same values Sencho would. The values stay in
   * the CLI's environment and never reach the command line. Runtime-only keys
   * are left out so the helper keeps its image defaults, and the project name
   * and files stay the ones in the plan.
   */
  private helperEnvKeys(env: NodeJS.ProcessEnv): string[] {
    const runtimeOnly = new Set([
      'HOME', 'PATH', 'HOSTNAME', 'PWD', 'SHLVL', '_', 'TERM',
      'DOCKER_HOST', 'DOCKER_CONFIG', 'SENCHO_HANDOFF_UID', 'SENCHO_HANDOFF_GID',
      'COMPOSE_FILE', 'COMPOSE_PROJECT_NAME',
    ]);
    return Object.entries(env)
      .filter(([key, value]) => !runtimeOnly.has(key)
        && /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
        && typeof value === 'string')
      .map(([key]) => key);
  }

  /**
   * Stage, then hand over to the detached replacement helper. Every refusal
   * lands in lastUpdateError before anything stops. After a successful spawn
   * the helper's outcome file is the only verdict (ImageOperationService
   * watches it). A `stack`-scope replacement recreates this process part way
   * through; a `provider`-scope one leaves it running to answer the helper.
   */
  private async runEndpointProviderReplacement(
    env: NodeJS.ProcessEnv,
    request: EndpointProviderRequest,
    mode: ProviderReplaceMode,
    composeCopy: ComposeCopy | null,
  ): Promise<void> {
    const ctx = this.composeContext;
    const replaceable = await this.resolveReplaceableProvider();
    if (!ctx || 'state' in replaceable) {
      this.refuseEndpointProviderReplacement('state' in replaceable && replaceable.state === 'unavailable'
        ? replaceable.reason
        : 'Sencho no longer reaches Docker through a container, so there is no Docker endpoint to recreate.');
      return;
    }
    const { provider } = replaceable;
    if (provider.service !== request.service) {
      this.refuseEndpointProviderReplacement(`The Docker endpoint changed from "${request.service}" to "${provider.service}" since the operation started. Run it again.`);
      return;
    }
    if (request.scope === 'provider' && mode === 'update') {
      this.refuseEndpointProviderReplacement('An image update recreates Sencho, so it cannot replace only the Docker endpoint. Use Reapply.');
      return;
    }
    const plan: ProviderReplacePlan = {
      schemaVersion: 1,
      operationId: request.operationId,
      mode,
      scope: request.scope,
      project: ctx.project!,
      workingDir: ctx.workingDir,
      configFiles: ctx.configFiles.split(',').map(file => file.trim()).filter(Boolean),
      providerService: provider.service,
      senchoService: ctx.serviceName,
      providerContainerId: provider.containerId,
      composeCopy,
      pruneOnUpdate: mode === 'update' && DatabaseService.getInstance().getGlobalSettings()['prune_on_update'] === '1',
      providerReadySeconds: PROVIDER_READY_SECONDS,
      ackSeconds: PROVIDER_ACK_SECONDS,
    };

    try {
      fs.mkdirSync(request.handoffDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(request.planFile, JSON.stringify(plan), { mode: 0o600 });
    } catch (error) {
      this.refuseEndpointProviderReplacement(`Could not write the replacement plan to the data directory (${getErrorMessage(error, 'write failed')}).`);
      return;
    }

    const helperInput = {
      operationId: request.operationId,
      socketSource: provider.socketBindSource,
      workingDir: ctx.workingDir,
      dataDirHost: ctx.dataDirHost!,
      hostBindMounts: ctx.hostBindMounts,
      imageId: ctx.runningImageId!,
      composeWritable: composeCopy !== null,
      envKeys: this.helperEnvKeys(env),
      // The helper runs as root; the app may run as SENCHO_USER, so its
      // marker and outcome files must be handed back to this process's uid.
      handoffOwner: processHandoffOwner(),
    };

    console.log(`[SelfUpdate] Staging replacement of the Docker endpoint "${provider.service}"...`);
    let staged: StageResult;
    try {
      const { stdout } = await execFileAsync('docker', buildEndpointProviderHelperArgs({ ...helperInput, mode: 'stage', composeWritable: false }), {
        env, timeout: ENDPOINT_PROVIDER_STAGE_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024,
      });
      staged = parseStageResult(stdout);
    } catch (error) {
      const stdout = (error as { stdout?: Buffer | string })?.stdout?.toString() ?? '';
      const stderr = (error as { stderr?: Buffer | string })?.stderr?.toString().trim();
      const parsed = parseStageResult(stdout);
      staged = parsed.ok
        ? { ok: false, message: stderr || getErrorMessage(error, 'The staging helper failed.') }
        : (parsed.message === STAGE_UNREADABLE && stderr ? { ok: false, message: stderr } : parsed);
    }
    if (!staged.ok) {
      this.refuseEndpointProviderReplacement(`Nothing was stopped. ${staged.message}`);
      return;
    }
    console.log(`[SelfUpdate] Staged ${staged.providerImage} for "${provider.service}" (previous image ${staged.previousImageId}); spawning the replacement helper (last breath)`);

    const helperName = endpointProviderHelperName(request.operationId);
    let createError: unknown = null;
    try {
      await execFileAsync('docker', buildEndpointProviderHelperArgs({ ...helperInput, mode: 'replace' }), { env, timeout: 60_000 });
    } catch (error) {
      createError = error;
      // `docker create` does not start anything. If it made the container before
      // its answer was lost, that container is still inert. Only a reliable
      // "no such container" lets the claim go; otherwise the start below (or
      // the outcome watcher) decides.
      const state = await this.replacementHelperState(helperName, env);
      if (state === 'absent') {
        this.refuseReplacementHelperStart(createError);
        return;
      }
      console.warn(
        '[SelfUpdate] The replacement helper create was not confirmed; inspecting its container:',
        getErrorMessage(error, 'docker create failed'),
      );
    }
    try {
      await execFileAsync('docker', ['start', helperName], { env, timeout: 30_000 });
    } catch (error) {
      // A container that is still `created` never ran, so it cannot have
      // mutated the endpoint. Anything else may be running: the watcher decides.
      const state = await this.replacementHelperState(helperName, env);
      if (state === 'created') {
        await execFileAsync('docker', ['rm', '-f', helperName], { env, timeout: 15_000 }).catch(() => undefined);
        this.refuseReplacementHelperStart(error);
        return;
      }
      console.warn(
        '[SelfUpdate] The replacement helper start was not confirmed; waiting for its outcome:',
        getErrorMessage(error, 'docker start failed'),
      );
    }
  }

  /** Records a helper that provably never ran as a pre-cutover refusal. */
  private refuseReplacementHelperStart(error: unknown): void {
    const stderr = (error as { stderr?: Buffer | string })?.stderr?.toString().trim();
    this.refuseEndpointProviderReplacement(
      `Nothing was stopped. The replacement helper could not start: ${stderr || getErrorMessage(error, 'docker create failed')}`,
    );
  }

  /**
   * The helper container's state by its deterministic name, or `absent` when
   * Docker says it does not exist. `unknown` is never treated as a refusal.
   */
  private async replacementHelperState(name: string, env: NodeJS.ProcessEnv): Promise<string> {
    try {
      const { stdout } = await execFileAsync('docker', [
        'inspect', '--format', '{{.State.Status}}', name,
      ], { env, timeout: 15_000, maxBuffer: 1024 * 1024 });
      return stdout.trim() || 'unknown';
    } catch (error) {
      const stderr = (error as { stderr?: Buffer | string })?.stderr?.toString() ?? '';
      if (/no such (object|container)/i.test(stderr) || /not found/i.test(stderr)) return 'absent';
      console.warn('[SelfUpdate] Could not read the replacement helper state:', getErrorMessage(error, 'docker inspect failed'));
      return 'unknown';
    }
  }

  /**
   * Spawn the "last breath" helper container that recreates Sencho (and, when a
   * repin is staged, copies the rewritten compose file onto the host first).
   * Runs attached (no -d): if the recreate fails before it kills us, execFile's
   * callback receives the helper's exit code and stderr directly.
   */
  private spawnHelper(
    env: NodeJS.ProcessEnv,
    envKeys: ReadonlyArray<string>,
    composeCopy?: ComposeCopy,
    successMarkerFile?: string,
    successMarkerContent?: string,
    pruneOnUpdateOverride?: boolean,
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
    const pruneOnUpdate = pruneOnUpdateOverride ?? (
      DatabaseService.getInstance().getGlobalSettings()['prune_on_update'] === '1'
    );
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
    const args = buildSelfUpdateRunArgs({ workingDir, imageName, dataDirHost, hostBindMounts, repinWritable: !!composeCopy, envKeys }, composeCmd);

    // Callback may never fire on success (we die mid-call during recreate);
    // that is fine because the restart itself is the success signal.
    // Surviving a clean helper exit means recreate did not take over this process.
    execFile('docker', args, { env }, (err, _stdout, stderr) => {
      if (err) {
        const stderrText = stderr?.toString().trim();
        this.lastUpdateError = stderrText || err.message || 'Helper container failed';
        console.error('[SelfUpdate] Helper container failed:', this.lastUpdateError);
      } else if (!this.lastUpdateError) {
        this.lastUpdateError = 'Helper container exited without restarting Sencho';
        console.error('[SelfUpdate] Helper container exited cleanly without restarting Sencho');
      }
      const listeners = this.helperExitListeners.splice(0);
      if (listeners.length === 0) {
        this.pendingHelperExitError = this.lastUpdateError!;
        return;
      }
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
