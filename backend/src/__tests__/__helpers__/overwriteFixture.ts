import type Docker from 'dockerode';
import type { RecoveryHelperRunner } from '../../services/recovery/restic/helperRunner';
import { HELPER_LABEL_RESTORE_INTENT } from '../../services/recovery/restic/helperRunner';
import type {
  BackupEngine,
  EngineExecutionContext,
  EngineResult,
  PointCaptureEvidence,
  RestoreEvidence,
  RestoreIntent,
} from '../../services/recovery/types';

/**
 * The docker, helper and engine a staged-overwrite case drives.
 *
 * Everything here is a record of what was called, so a test can assert the order
 * a fence has to keep (record, then policy, then stop) rather than only the end
 * state. No case reaches a daemon.
 */

export interface FakeContainer {
  Id: string;
  Names: string[];
  State: 'running' | 'exited';
  Labels: Record<string, string>;
  Mounts: Array<{ Type: string; Name: string }>;
  HostConfig: { RestartPolicy: { Name: string; MaximumRetryCount?: number } };
}

export function container(
  overrides: Partial<FakeContainer> & { Id: string },
): FakeContainer {
  return {
    Names: [`/${overrides.Id}`],
    State: 'running',
    Labels: {},
    Mounts: [],
    HostConfig: { RestartPolicy: { Name: 'always' } },
    ...overrides,
  };
}

export interface FakeDocker {
  docker: Docker;
  /** Every mutation in the order it happened, as `verb:containerId`. */
  calls: string[];
  volumes: Map<string, { labels: Record<string, string>; createdAt: string }>;
  containers: Map<string, FakeContainer>;
  failOn?: (call: string) => Error | null;
}

export function fakeDocker(input: {
  volumes?: Array<{ name: string; labels?: Record<string, string> }>;
  containers?: FakeContainer[];
  /** Docker's volume CreatedAt. Fixed here, because the generation token uses it. */
  createdAt?: string;
} = {}): FakeDocker {
  const startedAt = input.createdAt ?? new Date().toISOString();
  const volumes = new Map<string, { labels: Record<string, string>; createdAt: string }>();
  for (const volume of input.volumes ?? []) {
    volumes.set(volume.name, { labels: volume.labels ?? {}, createdAt: new Date(startedAt).toISOString() });
  }
  const containers = new Map<string, FakeContainer>();
  for (const item of input.containers ?? []) containers.set(item.Id, item);
  const calls: string[] = [];
  const state: FakeDocker = { docker: null as unknown as Docker, calls, volumes, containers };

  const record = (call: string): void => {
    if (state.failOn) {
      const failure = state.failOn(call);
      if (failure) throw failure;
    }
    calls.push(call);
  };

  state.docker = {
    info: async () => ({ ID: 'engine-overwrite' }),
    listVolumes: async () => ({
      Volumes: [...volumes.entries()].map(([name, value]) => ({
        Name: name, Driver: 'local', Labels: value.labels, CreatedAt: value.createdAt,
      })),
    }),
    listContainers: async () => [...containers.values()],
    createVolume: async (spec: { Name: string; Labels?: Record<string, string> }) => {
      record(`createVolume:${spec.Name}`);
      if (!volumes.has(spec.Name)) {
        volumes.set(spec.Name, { labels: spec.Labels ?? {}, createdAt: new Date().toISOString() });
      }
      return { Name: spec.Name };
    },
    getVolume: (name: string) => ({
      inspect: async () => {
        const found = volumes.get(name);
        if (!found) throw Object.assign(new Error('no such volume'), { statusCode: 404 });
        return { Name: name, Driver: 'local', Labels: found.labels, CreatedAt: found.createdAt };
      },
      remove: async () => {
        record(`removeVolume:${name}`);
        if (!volumes.has(name)) throw Object.assign(new Error('no such volume'), { statusCode: 404 });
        volumes.delete(name);
      },
    }),
    getContainer: (id: string) => ({
      inspect: async () => {
        const found = containers.get(id);
        if (!found) throw Object.assign(new Error('no such container'), { statusCode: 404 });
        return {
          Id: found.Id,
          Name: found.Names[0],
          State: { Running: found.State === 'running' },
          HostConfig: found.HostConfig,
          Mounts: found.Mounts,
        };
      },
      update: async (options: { RestartPolicy: { Name: string } }) => {
        record(`update:${id}`);
        const found = containers.get(id);
        if (!found) throw Object.assign(new Error('no such container'), { statusCode: 404 });
        found.HostConfig = { RestartPolicy: options.RestartPolicy };
      },
      stop: async () => {
        record(`stop:${id}`);
        const found = containers.get(id);
        if (!found) throw Object.assign(new Error('no such container'), { statusCode: 404 });
        if (found.State === 'exited') throw Object.assign(new Error('not running'), { statusCode: 304 });
        found.State = 'exited';
      },
      start: async () => {
        record(`start:${id}`);
        const found = containers.get(id);
        if (!found) throw Object.assign(new Error('no such container'), { statusCode: 404 });
        if (found.State === 'running') throw Object.assign(new Error('already started'), { statusCode: 304 });
        found.State = 'running';
      },
    }),
    getImage: () => ({ inspect: async () => ({ Id: 'sha256:helper' }) }),
  } as unknown as Docker;

  return state;
}

/** What one helper run was asked to do, in the order it ran. */
export interface HelperRunRecord {
  profile: string;
  cmd: readonly string[];
  mounts: { repository?: string; source?: string; target?: string };
}

/**
 * A helper that answers the generation probe and every swap action from a
 * scripted table. `swapAnswers` is keyed by action (`prepare`, `commit`, ...).
 * The first entry for an action answers every call to it, unless it is marked
 * `once`: that entry is removed after one call and the next entry for the action
 * answers. An action with no entry left fails with exit 1 and `unscripted`.
 */
export function scriptedHelper(input: {
  swapAnswers?: Array<{
    action: string;
    exitCode: number;
    status?: string;
    stderr?: string;
    /** The step was aborted by a cancel. */
    aborted?: boolean;
    /** A raw first stdout line, such as the probe's `{"error": ...}` refusal. */
    stdoutLine?: string;
    /** Answer one call, then fall through to the next entry for the action, or to the unscripted failure. */
    once?: boolean;
  }>;
  dev?: number;
  ino?: number;
  free?: number;
} = {}): {
  helper: RecoveryHelperRunner;
  runs: HelperRunRecord[];
  probeCount: () => number;
} {
  const runs: HelperRunRecord[] = [];
  const answers = [...(input.swapAnswers ?? [])];
  let probes = 0;
  const helper = {
    run: async (spec: {
      profile: string;
      cmd: readonly string[];
      mounts: { repository?: string; source?: string; target?: string };
      onStdoutLine?: (line: string) => void;
    }) => {
      runs.push({ profile: spec.profile, cmd: spec.cmd, mounts: spec.mounts });
      if (spec.profile === 'probe') {
        probes += 1;
        spec.onStdoutLine?.(JSON.stringify({
          dev: input.dev ?? 63, ino: input.ino ?? 42, uid: 0, gid: 0, mode: 16877, free: input.free ?? 10_000_000,
        }));
        return { exitCode: 0, stderrTail: '', aborted: false, killed: false };
      }
      if (spec.profile === 'swap') {
        const action = spec.cmd[2] ?? '';
        const index = answers.findIndex((item) => item.action === action);
        const answer = answers[index] ?? { action, exitCode: 1, stderr: 'unscripted' };
        if (answer.once) answers.splice(index, 1);
        if (answer.stdoutLine !== undefined) spec.onStdoutLine?.(answer.stdoutLine);
        if (answer.status !== undefined) {
          const report: Record<string, unknown> = { status: answer.status, moved: 0 };
          spec.onStdoutLine?.(JSON.stringify(report));
        }
        return { exitCode: answer.exitCode, stderrTail: answer.stderr ?? '', aborted: answer.aborted === true, killed: false };
      }
      return { exitCode: 1, stderrTail: 'unexpected helper run', aborted: false, killed: false };
    },
    removeForeignEpochHelpers: async () => 0,
    countForeignEpochHelpers: async () => 0,
  } as unknown as RecoveryHelperRunner;
  return { helper, runs, probeCount: () => probes };
}

export interface EngineScript {
  /** Answers for successive restore calls, in order. */
  restores?: Array<() => Promise<EngineResult<RestoreEvidence>>>;
  createPoint?: () => Promise<EngineResult<PointCaptureEvidence>>;
}

export interface EngineRecorder {
  engine: BackupEngine;
  restoreCalls: Array<{ mode: string; workDir: string | null }>;
  createPointCalls: number;
}

export const DEFAULT_CAPTURE: PointCaptureEvidence = {
  snapshotId: 'snapshot-1',
  capture: { fileCount: 3, byteCount: 300, skippedCount: 0 },
  exclusions: [],
  consistency: 'crash_consistent_stopped',
};

export function scriptedEngine(script: EngineScript = {}): EngineRecorder {
  const restores = [...(script.restores ?? [])];
  const restoreCalls: EngineRecorder['restoreCalls'] = [];
  const recorder: EngineRecorder = {
    restoreCalls,
    createPointCalls: 0,
    engine: {
      engineId: 'fake',
      contractVersion: 1,
      storageKinds: ['named_volume'],
      probe: async () => ({ engineId: 'fake', build: 'test', usable: true }),
      createPoint: async () => {
        recorder.createPointCalls += 1;
        if (script.createPoint) return script.createPoint();
        return { ok: true, evidence: DEFAULT_CAPTURE };
      },
      verifyPoint: async () => ({ ok: true, evidence: { result: 'verified' } }),
      restore: async (intent: RestoreIntent, _ctx: EngineExecutionContext) => {
        restoreCalls.push({
          mode: intent.target.mode,
          workDir: intent.target.mode === 'staged_overwrite' ? intent.target.workDir : null,
        });
        const next = restores.shift();
        if (next) return next();
        return { ok: true, evidence: { filesRestored: 4, bytesRestored: 400, verified: true } };
      },
    } as BackupEngine,
  };
  return recorder;
}

/** The labels Docker gives a volume Sencho created for this intent. */
export function intentLabels(intentId: string): Record<string, string> {
  return { [HELPER_LABEL_RESTORE_INTENT]: intentId };
}

/** A promise a test settles by hand, to hold one step of a race open. */
export function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/**
 * Make one container call of a fake Docker wait at `until` before it runs, and
 * say when the call arrived, so a test can act while a start or an inspect is on
 * its way.
 */
export function delayContainerCall(
  fake: FakeDocker,
  call: 'start' | 'inspect',
  containerId: string,
  until: Promise<void>,
  entered: () => void,
): void {
  const getContainer = fake.docker.getContainer.bind(fake.docker);
  (fake.docker as unknown as { getContainer: (id: string) => unknown }).getContainer = (id: string) => {
    const real = getContainer(id) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    if (id !== containerId) return real;
    return { ...real, [call]: async (...args: unknown[]) => { entered(); await until; return real[call](...args); } };
  };
}
