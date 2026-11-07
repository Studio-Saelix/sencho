/**
 * The restic adapter's read half, with the helper stubbed.
 *
 * The route suite proves the HTTP contract; this one proves the engine wiring
 * that the routes depend on: the argv and profile a read uses, the entry cap and
 * the abort it causes, the exit-code map, the short-body guard, and the two
 * runner behaviours a streamed body needs (backpressure really pauses the
 * helper, and an abort that lands before the container starts still stops it).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import type Docker from 'dockerode';
import { ResticEngine } from '../services/recovery/restic/ResticEngine';
import {
  RecoveryHelperRunner,
  type HelperRunSpec,
} from '../services/recovery/restic/helperRunner';
import { MAX_CONTENT_ENTRIES } from '../services/recovery/restic/resticContents';
import type { ContentChunkControl } from '../services/recovery/types';

const IMAGE = 'ghcr.io/studio-saelix/sencho-recovery-helper@sha256:' + 'a'.repeat(64);
const REPOSITORY = { id: 'repo-1', locator: 'sencho-recovery-test-g1' };
const SNAPSHOT = 'b'.repeat(64);

function nodeLine(overrides: Record<string, unknown>): string {
  return JSON.stringify({ message_type: 'node', struct_type: 'node', uid: 0, gid: 0, mode: 420, ...overrides });
}

function runnerReturning(
  handler: (spec: HelperRunSpec) => {
    exitCode: number | null;
    stderrTail?: string;
    aborted?: boolean;
    killed?: boolean;
  },
): { calls: HelperRunSpec[]; runner: RecoveryHelperRunner } {
  const calls: HelperRunSpec[] = [];
  const runner = {
    run: async (spec: HelperRunSpec) => {
      calls.push(spec);
      const result = handler(spec);
      return {
        exitCode: result.exitCode,
        stderrTail: result.stderrTail ?? '',
        aborted: result.aborted ?? false,
        killed: result.killed ?? false,
      };
    },
  } as unknown as RecoveryHelperRunner;
  return { calls, runner };
}

function engineWith(runner: RecoveryHelperRunner): ResticEngine {
  return new ResticEngine({
    runner,
    secret: 'repository-password',
    helperImageRef: IMAGE,
    inspectHelperImage: async () => ({ state: 'present' }),
    parentSnapshot: () => null,
    readGenerationToken: async () => 'token',
    observeInUse: async () => ({ running: false, containers: [] }) as never,
    repositoryFor: () => REPOSITORY,
    runCheck: async () => ({ result: 'verified' }),
  });
}

function readContext(signal = new AbortController().signal) {
  return { operationId: 'read-test', signal };
}

const READ = (path: string) => ({ snapshotId: SNAPSHOT, repositoryId: REPOSITORY.id, path });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ResticEngine.listContents', () => {
  it('lists one directory through the read profile and the repository alone', async () => {
    const { calls, runner } = runnerReturning((spec) => {
      spec.onStdoutLine?.('{"message_type":"snapshot","struct_type":"snapshot","id":"' + SNAPSHOT + '"}');
      spec.onStdoutLine?.(nodeLine({ name: 'etc', type: 'dir', path: '/data/etc' }));
      spec.onStdoutLine?.(nodeLine({ name: 'a.txt', type: 'file', path: '/data/etc/a.txt', size: 12 }));
      spec.onStdoutLine?.(nodeLine({ name: 'link', type: 'symlink', path: '/data/etc/link' }));
      return { exitCode: 0 };
    });

    const result = await engineWith(runner).listContents(READ('etc'), readContext());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence).toMatchObject({ path: 'etc', kind: 'directory', truncated: false });
    expect(result.evidence.entry).toMatchObject({ name: 'etc', type: 'directory' });
    expect(result.evidence.entries.map((entry) => entry.name)).toEqual(['a.txt', 'link']);
    expect(result.evidence.entries[0]).toMatchObject({ path: 'etc/a.txt', size: 12 });
    expect(result.evidence.entries[1]).toMatchObject({ type: 'symlink', size: null });

    const spec = calls[0];
    expect(spec.profile).toBe('read');
    expect(spec.cmd).toEqual([
      '/restic', '--repo', '/repo', '--no-cache',
      'ls', SNAPSHOT, '/data/etc', '--json', '--no-lock', '--quiet',
    ]);
    expect(spec.mounts).toEqual({ repository: REPOSITORY.locator });
    expect(spec.stdinSecret).toBe('repository-password');
    // A listing has a deadline; a file body does not.
    expect(spec.timeoutMs).toBe(10 * 60 * 1000);
  });

  it('stops at the entry cap, aborts the run and reports the listing as truncated', async () => {
    const total = MAX_CONTENT_ENTRIES + 5;
    const { calls, runner } = runnerReturning((spec) => {
      spec.onStdoutLine?.(nodeLine({ name: 'big', type: 'dir', path: '/data/big' }));
      for (let index = 0; index < total; index += 1) {
        spec.onStdoutLine?.(nodeLine({ name: `f${index}`, type: 'file', path: `/data/big/f${index}`, size: 1 }));
      }
      // The engine aborted the run on purpose, so the helper exits through a
      // signal; the read is still a success.
      return { exitCode: 130, aborted: true };
    });

    const result = await engineWith(runner).listContents(READ('big'), readContext());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.evidence.truncated).toBe(true);
    expect(result.evidence.entries).toHaveLength(MAX_CONTENT_ENTRIES);
    expect(calls[0].signal?.aborted).toBe(true);
  });

  it('answers not_found when the path is not in the snapshot', async () => {
    const { runner } = runnerReturning((spec) => {
      spec.onStdoutLine?.('{"message_type":"snapshot","struct_type":"snapshot"}');
      return { exitCode: 0 };
    });
    expect(await engineWith(runner).listContents(READ('nope'), readContext()))
      .toEqual({ ok: false, errorClass: 'not_found' });
  });

  it('maps restic exit codes and logs the cause once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cases: Array<[number, string]> = [
      [10, 'repository_unavailable'],
      [12, 'repository_key_unavailable'],
      [1, 'integrity_mismatch'],
      [2, 'node_error'],
    ];
    for (const [exitCode, errorClass] of cases) {
      const { runner } = runnerReturning(() => ({ exitCode, stderrTail: 'Fatal: something specific' }));
      expect(await engineWith(runner).listContents(READ(''), readContext())).toEqual({ ok: false, errorClass });
    }
    expect(warn).toHaveBeenCalledTimes(cases.length);
    // The log line is the only place restic's own message survives.
    expect(warn.mock.calls[0].join(' ')).toContain('something specific');
  });

  it('reads a cancelled run as interrupted, not as a failure', async () => {
    const { runner } = runnerReturning(() => ({ exitCode: 130, aborted: true }));
    expect(await engineWith(runner).listContents(READ(''), readContext()))
      .toEqual({ ok: false, errorClass: 'interrupted' });
  });
});

describe('ResticEngine.dumpFile', () => {
  it('streams the bytes through the sink and checks the count', async () => {
    const chunks: Buffer[] = [];
    const { calls, runner } = runnerReturning((spec) => {
      spec.onStdoutChunk?.(Buffer.from('alpha'), { pause: () => undefined, resume: () => undefined });
      return { exitCode: 0 };
    });

    const result = await engineWith(runner).dumpFile(
      READ('a.txt'),
      5,
      (chunk) => { chunks.push(chunk); },
      readContext(),
    );
    expect(result).toEqual({ ok: true, evidence: { bytes: 5 } });
    expect(Buffer.concat(chunks).toString()).toBe('alpha');
    expect(calls[0].profile).toBe('read');
    expect(calls[0].cmd).toEqual([
      '/restic', '--repo', '/repo', '--no-cache',
      'dump', SNAPSHOT, '/data/a.txt', '--no-lock', '--quiet',
    ]);
    // A file body has no deadline: it ends when the client leaves.
    expect(calls[0].timeoutMs).toBeUndefined();
  });

  it('answers integrity_mismatch when fewer bytes arrived than the record promised', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { runner } = runnerReturning((spec) => {
      spec.onStdoutChunk?.(Buffer.from('alp'), { pause: () => undefined, resume: () => undefined });
      return { exitCode: 0, stderrTail: 'Load(<data/ab>): does not exist' };
    });
    expect(await engineWith(runner).dumpFile(READ('a.txt'), 5, () => undefined, readContext()))
      .toEqual({ ok: false, errorClass: 'integrity_mismatch' });
    expect(warn.mock.calls[0].join(' ')).toContain('does not exist');
  });
});

// --- The runner's streaming lifecycle ---------------------------------------

interface StreamingDocker {
  docker: Docker;
  killed: string[];
  removed: string[];
  attach: PassThrough;
}

/** A daemon whose attach stream is a real duplex, and whose process exits on cue. */
function streamingDocker(onWait: (attach: PassThrough) => void): StreamingDocker {
  const attach = new PassThrough();
  // The runner closes stdin when the password is written; a real hijacked
  // duplex keeps its readable side open at the same time.
  attach.end = ((): PassThrough => attach) as unknown as PassThrough['end'];
  const killed: string[] = [];
  const removed: string[] = [];
  const container = {
    start: async () => undefined,
    attach: async () => attach,
    wait: async () => {
      onWait(attach);
      return { StatusCode: 0 };
    },
    kill: async ({ signal }: { signal: string }) => { killed.push(signal); },
    remove: async () => { removed.push('helper'); },
  };
  const docker = {
    createContainer: async () => container,
    getContainer: () => ({ remove: async () => undefined }),
    listContainers: async () => [],
    modem: {
      demuxStream: (stream: NodeJS.ReadableStream, stdout: NodeJS.WritableStream) => {
        stream.on('data', (chunk: Buffer) => stdout.write(chunk));
      },
      followProgress: () => undefined,
    },
    getImage: () => ({ inspect: async () => ({}) }),
  };
  return { docker: docker as unknown as Docker, killed, removed, attach };
}

function realRunner(docker: Docker, epoch = 'epoch-1'): RecoveryHelperRunner {
  return new RecoveryHelperRunner({ docker, authorityId: 'authority', processEpoch: epoch, imageRef: IMAGE });
}

describe('the helper runner under a streamed body', () => {
  it('resumes a paused stream once the process exits, so the tail is not lost', async () => {
    const fake = streamingDocker((attach) => {
      attach.write(Buffer.from('first'));
      attach.write(Buffer.from('second'));
      attach.end();
    });
    const pause = vi.spyOn(fake.attach, 'pause');
    const resume = vi.spyOn(fake.attach, 'resume');
    const received: string[] = [];
    let paused = false;

    const result = await realRunner(fake.docker).run({
      profile: 'read',
      operationId: 'op-stream',
      cmd: ['/restic', 'version'],
      mounts: { repository: REPOSITORY.locator },
      onStdoutChunk: (chunk, control: ContentChunkControl) => {
        received.push(chunk.toString());
        if (paused) return;
        paused = true;
        control.pause();
      },
    });

    expect(result.exitCode).toBe(0);
    expect(pause).toHaveBeenCalled();
    // The runner resumes before waiting for the tail, so the second chunk lands.
    await vi.waitFor(() => expect(received.join('')).toBe('firstsecond'));
    expect(resume).toHaveBeenCalled();
    expect(fake.removed).toEqual(['helper']);
  });

  it('kills a helper whose abort arrived before the container started', async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = streamingDocker(() => undefined);
    const container = await fake.docker.createContainer({} as never);
    // Make start land after the abort, the shape a slow daemon produces.
    const originalStart = container.start;
    (container as unknown as { start: () => Promise<void> }).start = async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await originalStart();
    };

    const result = await realRunner(fake.docker).run({
      profile: 'read',
      operationId: 'op-early-abort',
      cmd: ['/restic', 'version'],
      mounts: { repository: REPOSITORY.locator },
      signal: controller.signal,
    });

    expect(result.aborted).toBe(true);
    // The pre-start SIGINT had no process to reach; the kill after start is what
    // stops the helper.
    expect(fake.killed).toContain('SIGKILL');
    expect(fake.removed).toEqual(['helper']);
  }, 20_000);
});
