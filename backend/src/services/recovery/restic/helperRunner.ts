import type Docker from 'dockerode';
import { Writable } from 'stream';
import { errorMessageForLog } from '../../../utils/safeLog';
import type { RecoveryErrorClass } from '../types';
import { RecoveryError } from '../redaction';
import { RECOVERY_HELPER_RESTIC_PATH } from './helperImage';

/**
 * How a recovery helper runs, and nothing else.
 *
 * Every helper is the same minimal restic image started with one of a fixed set
 * of profiles. The profile, not the caller, decides who the process runs as,
 * which capabilities it has, what it may mount and whether that mount is
 * writable, so a bug in an engine call cannot widen the boundary: the boundary
 * is a constant table in this file.
 *
 * The repository password reaches the container only on attached stdin, through
 * `RESTIC_PASSWORD_FILE=/dev/stdin`. It is never an environment variable, a
 * command argument, a label or a log line, because `docker inspect` shows all of
 * those to anyone who can talk to the daemon.
 *
 * Every container is labelled with this instance's recovery authority and with
 * the process epoch that started it, and it is removed however the run ends.
 * The labels are what let boot remove only a dead process's helpers, and what
 * let the event pipeline tell a helper exit from a workload crash.
 */

export const HELPER_LABEL_AUTHORITY = 'dev.sencho.recovery.helper';
export const HELPER_LABEL_EPOCH = 'dev.sencho.recovery.epoch';
export const HELPER_LABEL_REPOSITORY = 'dev.sencho.recovery.repository';
export const HELPER_LABEL_RESTORE_INTENT = 'dev.sencho.recovery.restore-intent';

/** Where the repository volume is mounted inside a helper. */
export const HELPER_REPOSITORY_MOUNT = '/repo';
/** Where the source volume is mounted for a capture. */
export const HELPER_SOURCE_MOUNT = '/data';
/** Where the restore target is mounted. */
export const HELPER_RESTORE_MOUNT = '/restore';

export type HelperProfile = 'probe' | 'config' | 'init' | 'backup' | 'check' | 'restore' | 'unlock';

/**
 * What a profile allows. `source`/`target` name the extra mount a profile
 * accepts; `repositoryReadOnly` is the repository mount's mode.
 */
export interface HelperProfileSpec {
  /** Always root: the helper is the only process in the container, with no shell. */
  readonly user: string;
  readonly capAdd: readonly string[];
  readonly repositoryReadOnly: boolean;
  readonly needsRepository: boolean;
  readonly source: 'read_only' | null;
  readonly target: 'read_write' | null;
  readonly tmpfs: Readonly<Record<string, string>>;
  readonly pidsLimit: number;
  readonly memoryBytes: number;
  /** Null means no deadline: a capture or a restore runs as long as it runs. */
  readonly timeoutMs: number | null;
}

const GIB = 1024 * 1024 * 1024;

/**
 * restic's scratch space for a capture. A capture stages temporary pack files in
 * `/tmp` before it writes them to the repository, and what it holds at once does
 * not grow with the size of the data: measured at about 70 MiB for a 1.3 GiB
 * source, on 2 and on 10 CPUs. The 64 MiB the other profiles get was not enough
 * and failed with `no space left on device` after a few hundred MB. A capture
 * gets 512 MiB, about seven times that peak, and its memory limit doubles to
 * 2 GiB, because a tmpfs is charged to the container's memory.
 */
const BACKUP_SCRATCH = 'size=512m,mode=1777';

/**
 * The fixed profile table. A test asserts the whole `createContainer` spec for
 * each entry, so any change here is a visible change to the privilege boundary.
 */
export const HELPER_PROFILES: Readonly<Record<HelperProfile, HelperProfileSpec>> = Object.freeze({
  // Reads one directory's device, inode, owner and mode. Only the source root is
  // mounted, and only read-only.
  probe: {
    user: '0:0',
    capAdd: [],
    repositoryReadOnly: true,
    needsRepository: false,
    source: 'read_only',
    target: null,
    tmpfs: { '/tmp': 'size=64m,mode=1777' },
    pidsLimit: 256,
    memoryBytes: GIB,
    timeoutMs: 120_000,
  },
  // `restic cat config --no-lock`: does the repository exist, and does the key open it.
  config: {
    user: '0:0',
    capAdd: [],
    repositoryReadOnly: true,
    needsRepository: true,
    source: null,
    target: null,
    tmpfs: { '/tmp': 'size=64m,mode=1777' },
    pidsLimit: 256,
    memoryBytes: GIB,
    timeoutMs: 120_000,
  },
  init: {
    user: '0:0',
    capAdd: [],
    repositoryReadOnly: false,
    needsRepository: true,
    source: null,
    target: null,
    tmpfs: { '/tmp': 'size=64m,mode=1777' },
    pidsLimit: 256,
    memoryBytes: GIB,
    timeoutMs: 120_000,
  },
  // `DAC_READ_SEARCH` is read and traverse only, needed because application
  // volumes belong to an application user (Postgres, MariaDB) and a root process
  // without it is refused like anyone else. The source mount stays read-only.
  backup: {
    user: '0:0',
    capAdd: ['DAC_READ_SEARCH'],
    repositoryReadOnly: false,
    needsRepository: true,
    source: 'read_only',
    target: null,
    tmpfs: { '/tmp': BACKUP_SCRATCH },
    pidsLimit: 256,
    memoryBytes: 2 * GIB,
    timeoutMs: null,
  },
  check: {
    user: '0:0',
    capAdd: [],
    repositoryReadOnly: true,
    needsRepository: true,
    source: null,
    target: null,
    tmpfs: { '/tmp': 'size=64m,mode=1777' },
    pidsLimit: 256,
    memoryBytes: GIB,
    timeoutMs: null,
  },
  // `--verify` reads restored files back after their ownership is applied, so the
  // profile needs the capability that made them unreadable to a plain root.
  restore: {
    user: '0:0',
    capAdd: ['CHOWN', 'FOWNER', 'FSETID', 'DAC_READ_SEARCH'],
    repositoryReadOnly: true,
    needsRepository: true,
    source: null,
    target: 'read_write',
    tmpfs: { '/tmp': 'size=64m,mode=1777' },
    pidsLimit: 256,
    memoryBytes: GIB,
    timeoutMs: null,
  },
  unlock: {
    user: '0:0',
    capAdd: [],
    repositoryReadOnly: false,
    needsRepository: true,
    source: null,
    target: null,
    tmpfs: { '/tmp': 'size=64m,mode=1777' },
    pidsLimit: 256,
    memoryBytes: GIB,
    timeoutMs: 120_000,
  },
});

/** Volumes a run needs. Names only: a helper never sees a host path or a bind. */
export interface HelperMountSpec {
  repository?: string;
  source?: string;
  target?: string;
}

export interface HelperRunSpec {
  profile: HelperProfile;
  operationId: string;
  /** restic's argv. Never carries a secret. */
  cmd: readonly string[];
  mounts: HelperMountSpec;
  /** Written to stdin and nothing else. */
  stdinSecret?: string;
  signal?: AbortSignal;
  /** Overrides the profile's deadline. */
  timeoutMs?: number;
  /** Called per stdout line, capped at 64 KiB. */
  onStdoutLine?: (line: string) => void;
  /**
   * Called per stderr line, same cap. restic's JSON mode writes progress to stdout
   * and *error items* to stderr, so a parser that only reads stdout sees a
   * capture with unreadable files as clean. The listener decides what is JSON.
   */
  onStderrLine?: (line: string) => void;
}

export interface HelperRunResult {
  exitCode: number | null;
  stderrTail: string;
  aborted: boolean;
  killed: boolean;
}

/** Longest stdout line a listener receives before the rest of that line is dropped. */
export const HELPER_LINE_CAP_BYTES = 64 * 1024;
/** Bytes of stderr kept for the log line. Never returned to a client. */
export const HELPER_STDERR_TAIL_BYTES = 8 * 1024;
/** How long a helper gets after SIGINT before it is killed. */
export const HELPER_ABORT_GRACE_MS = 10_000;
/** How long the attach stream may take to flush after the process exits. */
export const HELPER_STREAM_FLUSH_MS = 1_000;

/** A timer that keeps the event loop free to exit. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export interface HelperContainerInput {
  imageRef: string;
  profile: HelperProfile;
  spec: HelperProfileSpec;
  cmd: readonly string[];
  mounts: HelperMountSpec;
  hostname: string;
  labels: Readonly<Record<string, string>>;
}

export interface HelperMount {
  Type: 'volume';
  Source: string;
  Target: string;
  ReadOnly: boolean;
  VolumeOptions: { NoCopy: true };
}

/**
 * The container spec for one run. Pure, so a test can assert every field of
 * every profile without a daemon.
 */
export function buildHelperContainerConfig(input: HelperContainerInput): {
  config: Record<string, unknown>;
  hostConfig: Record<string, unknown>;
} {
  const { spec } = input;
  const mounts: HelperMount[] = [];
  if (spec.needsRepository) {
    if (!input.mounts.repository) throw new RecoveryError('invalid_request');
    mounts.push({
      Type: 'volume',
      Source: input.mounts.repository,
      Target: HELPER_REPOSITORY_MOUNT,
      ReadOnly: spec.repositoryReadOnly,
      VolumeOptions: { NoCopy: true },
    });
  }
  if (spec.source) {
    mounts.push({
      Type: 'volume',
      Source: requireVolume(input.mounts.source),
      Target: HELPER_SOURCE_MOUNT,
      ReadOnly: true,
      VolumeOptions: { NoCopy: true },
    });
  }
  if (spec.target) {
    mounts.push({
      Type: 'volume',
      Source: requireVolume(input.mounts.target),
      Target: HELPER_RESTORE_MOUNT,
      ReadOnly: false,
      VolumeOptions: { NoCopy: true },
    });
  }

  const hostConfig: Record<string, unknown> = {
    ReadonlyRootfs: true,
    NetworkMode: 'none',
    Privileged: false,
    SecurityOpt: ['no-new-privileges:true'],
    CapDrop: ['ALL'],
    PidsLimit: spec.pidsLimit,
    Memory: spec.memoryBytes,
    Tmpfs: { ...spec.tmpfs },
    Mounts: mounts,
  };
  if (spec.capAdd.length > 0) hostConfig.CapAdd = [...spec.capAdd];

  // The argv is split into an explicit entrypoint and its arguments, so the run
  // never depends on which entrypoint the image happens to carry. The helper image
  // ships restic as its entrypoint, and the probe is a second binary in the same
  // image; naming both here keeps one image serving both without a shell.
  const [entrypoint, ...entrypointArgs] = input.cmd;

  const config: Record<string, unknown> = {
    Image: input.imageRef,
    Entrypoint: entrypoint ? [entrypoint] : [],
    Cmd: entrypointArgs,
    Tty: false,
    User: spec.user,
    WorkingDir: '/',
    Hostname: input.hostname,
    Labels: { ...input.labels },
    // The password file is the container's own stdin; the value is a path.
    Env: ['RESTIC_PASSWORD_FILE=/dev/stdin', 'TMPDIR=/tmp'],
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: true,
    AttachStdin: true,
  };

  return { config, hostConfig };
}

function requireVolume(name: string | undefined): string {
  if (!name) throw new RecoveryError('invalid_request');
  return name;
}

/** `sencho-rh-<operation8>`, the hostname restic records next to its locks. */
export function helperHostname(operationId: string): string {
  return `sencho-rh-${operationId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}`;
}

export interface HelperRunnerDeps {
  docker: Docker;
  authorityId: string;
  processEpoch: string;
  /** The pinned helper reference this build may start. */
  imageRef: string;
  now?: () => number;
  /**
   * The profile table. Production never passes one: the frozen table above is the
   * boundary. A test passes a reduced profile to prove what a weaker capability
   * set can and cannot read.
   */
  profiles?: Readonly<Record<HelperProfile, HelperProfileSpec>>;
}

/** Accumulates stdout as lines, capping each line so a runaway stream cannot grow memory. */
class LineSplitter {
  private buffer = '';
  private discarding = false;

  constructor(private readonly onLine: (line: string) => void) {}

  write(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let index = this.buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (this.discarding) this.discarding = false;
      else this.onLine(line);
      index = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > HELPER_LINE_CAP_BYTES) {
      this.onLine(this.buffer.slice(0, HELPER_LINE_CAP_BYTES));
      this.buffer = '';
      this.discarding = true;
    }
  }

  end(): void {
    if (this.buffer.length > 0 && !this.discarding) this.onLine(this.buffer);
    this.buffer = '';
    this.discarding = false;
  }
}

export class RecoveryHelperRunner {
  constructor(private readonly deps: HelperRunnerDeps) {}

  /** The container id prefix a helper takes, for log correlation only. */
  private hostnameFor(operationId: string): string {
    return helperHostname(operationId);
  }

  async run(request: HelperRunSpec): Promise<HelperRunResult> {
    const spec = (this.deps.profiles ?? HELPER_PROFILES)[request.profile];
    if (!spec) throw new RecoveryError('invalid_request');
    const { config, hostConfig } = buildHelperContainerConfig({
      imageRef: this.deps.imageRef,
      profile: request.profile,
      spec,
      cmd: request.cmd,
      mounts: request.mounts,
      hostname: this.hostnameFor(request.operationId),
      labels: {
        [HELPER_LABEL_AUTHORITY]: this.deps.authorityId,
        [HELPER_LABEL_EPOCH]: this.deps.processEpoch,
      },
    });

    let container: Awaited<ReturnType<Docker['createContainer']>>;
    try {
      container = await this.deps.docker.createContainer({
        ...(config as Parameters<Docker['createContainer']>[0]),
        HostConfig: hostConfig as NonNullable<Parameters<Docker['createContainer']>[0]['HostConfig']>,
      });
    } catch (err) {
      throw new RecoveryError(classForDockerFailure(err));
    }

    let killed = false;
    let aborted = false;
    let timer: NodeJS.Timeout | undefined;
    let graceTimer: NodeJS.Timeout | undefined;

    const kill = async (signal: 'SIGINT' | 'SIGKILL'): Promise<void> => {
      try {
        await container.kill({ signal });
      } catch {
        // The container may have exited between the check and the signal.
      }
    };

    const stdout = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        if (request.onStdoutLine) splitter.write(chunk);
        cb();
      },
    });
    const stderrSplitter = new LineSplitter(request.onStderrLine ?? ((): void => {}));
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    const stderr = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        if (request.onStderrLine) stderrSplitter.write(chunk);
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
        while (stderrBytes > HELPER_STDERR_TAIL_BYTES && stderrChunks.length > 1) {
          const dropped = stderrChunks.shift();
          stderrBytes -= dropped?.length ?? 0;
        }
        cb();
      },
    });
    const splitter = new LineSplitter(request.onStdoutLine ?? ((): void => {}));

    const onAbort = (): void => {
      if (aborted) return;
      aborted = true;
      void kill('SIGINT');
      graceTimer = setTimeout(() => {
        killed = true;
        void kill('SIGKILL');
      }, HELPER_ABORT_GRACE_MS);
      graceTimer.unref?.();
    };

    const runPromise = (async (): Promise<number | null> => {
      const stream = await container.attach({ stream: true, stdin: true, stdout: true, stderr: true, hijack: true });
      const ended = new Promise<void>((resolve) => {
        stream.once('end', () => resolve());
        stream.once('close', () => resolve());
      });
      // dockerode's demuxStream reads the multiplexed header, so stdout and
      // stderr stay separate even though they share one socket.
      this.deps.docker.modem.demuxStream(stream, stdout, stderr);
      await container.start();
      if (request.stdinSecret !== undefined) stream.write(request.stdinSecret);
      // Always close stdin: the helper reads the password from it and then must
      // see EOF, or `cat config` waits forever for more input.
      stream.end();
      const exitInfo = await container.wait();
      // The exit code is the run's result. The stream only carries output that is
      // still being flushed, so a stream that never closes cannot hold the
      // operation open after the process is gone.
      await Promise.race([ended, delay(HELPER_STREAM_FLUSH_MS)]);
      return typeof exitInfo?.StatusCode === 'number' ? exitInfo.StatusCode : null;
    })();

    const deadline = request.timeoutMs ?? spec.timeoutMs;
    if (deadline !== null) {
      timer = setTimeout(() => {
        killed = true;
        void kill('SIGKILL');
      }, deadline);
      timer.unref?.();
    }
    if (request.signal) {
      if (request.signal.aborted) onAbort();
      else request.signal.addEventListener('abort', onAbort, { once: true });
    }

    let exitCode: number | null;
    try {
      exitCode = await runPromise;
      splitter.end();
      stderrSplitter.end();
    } catch (err) {
      console.error('[Recovery] Helper run failed for operation %s:', request.operationId, errorMessageForLog(err));
      throw new RecoveryError(classForDockerFailure(err));
    } finally {
      if (timer) clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      request.signal?.removeEventListener('abort', onAbort);
      try {
        await container.remove({ force: true });
      } catch (err) {
        // A container Docker already removed is not a failure; anything else means
        // a helper may still be running, which the caller's unlock path covers.
        const status = (err as { statusCode?: number }).statusCode;
        if (status !== 404) {
          console.warn('[Recovery] Could not remove helper container for operation %s:', request.operationId, errorMessageForLog(err));
        }
      }
    }

    return {
      exitCode,
      stderrTail: Buffer.concat(stderrChunks).toString('utf8'),
      aborted: aborted || request.signal?.aborted === true,
      killed,
    };
  }

  /**
   * Remove helpers left by another process. A live process's helpers carry this
   * epoch and are never touched; a foreign epoch's helper belongs to a process
   * that is gone, and Docker will not reap it by itself.
   */
  async removeForeignEpochHelpers(): Promise<number> {
    let removed = 0;
    for (const summary of await this.listForeignEpochHelpers()) {
      try {
        await this.deps.docker.getContainer(summary.Id).remove({ force: true });
        removed += 1;
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status !== 404) {
          console.warn('[Recovery] Could not remove a stale helper container:', errorMessageForLog(err));
        }
      }
    }
    return removed;
  }

  /**
   * How many helpers of a previous process still exist. Boot asks after removing
   * them: a helper that could not be removed may still be writing, and nothing
   * that assumes the repository is quiet may run while one is.
   */
  async countForeignEpochHelpers(): Promise<number> {
    return (await this.listForeignEpochHelpers()).length;
  }

  private async listForeignEpochHelpers(): Promise<Array<{ Id: string }>> {
    const filters = { label: [`${HELPER_LABEL_AUTHORITY}=${this.deps.authorityId}`] };
    const listed = await this.deps.docker.listContainers({ all: true, filters });
    return listed.filter((summary) => {
      const epoch = summary.Labels?.[HELPER_LABEL_EPOCH];
      return Boolean(epoch) && epoch !== this.deps.processEpoch;
    });
  }
}

/** A daemon refusal that means the socket proxy or the daemon forbids the call. */
export function classForDockerFailure(err: unknown): RecoveryErrorClass {
  const status = (err as { statusCode?: number }).statusCode;
  const message = (err as { message?: string }).message ?? '';
  if (status === 403 || status === 404) return 'capability_unavailable';
  if (/no such image/i.test(message)) return 'capability_unavailable';
  if (/image.*not found/i.test(message)) return 'capability_unavailable';
  return 'node_error';
}

/**
 * The restic argv prefix every profile shares. `--no-cache` is not an
 * optimization: the container's root filesystem is read-only, so restic's default
 * cache directory cannot be created, and asking for one costs the cache rather
 * than the run.
 */
export function resticCommand(repositoryPath: string, args: readonly string[]): string[] {
  return [RECOVERY_HELPER_RESTIC_PATH, '--repo', repositoryPath, '--no-cache', ...args];
}
