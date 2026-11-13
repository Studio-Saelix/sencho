/**
 * The restic adapter's read half, with the helper stubbed.
 *
 * The route suite proves the HTTP contract; this one proves the engine wiring
 * that the routes depend on: the argv and profile a read uses, paging and the
 * early stop it causes, the exit-code map, the short-body guard, and the two
 * runner behaviours a streamed body needs (backpressure really pauses the
 * helper, and an abort that lands before the container starts still stops it).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import type Docker from 'dockerode';
import { ResticEngine } from '../services/recovery/restic/ResticEngine';
import {
  HELPER_PAUSED_TAIL_MS,
  RecoveryHelperRunner,
  type HelperRunSpec,
} from '../services/recovery/restic/helperRunner';
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

describe('ResticEngine.readDirectory', () => {
  const FIRST_PAGE = { offset: 0, pageSize: 500 };

  it('lists one directory through the read profile and the repository alone', async () => {
    const { calls, runner } = runnerReturning((spec) => {
      spec.onStdoutLine?.('{"message_type":"snapshot","struct_type":"snapshot","id":"' + SNAPSHOT + '"}');
      spec.onStdoutLine?.(nodeLine({ name: 'etc', type: 'dir', path: '/data/etc' }));
      spec.onStdoutLine?.(nodeLine({ name: 'a.txt', type: 'file', path: '/data/etc/a.txt', size: 12 }));
      spec.onStdoutLine?.(nodeLine({ name: 'link', type: 'symlink', path: '/data/etc/link' }));
      // A grandchild is not part of this directory's page, whatever restic prints.
      spec.onStdoutLine?.(nodeLine({ name: 'deep', type: 'file', path: '/data/etc/sub/deep', size: 1 }));
      return { exitCode: 0 };
    });

    const result = await engineWith(runner).readDirectory(READ('/etc'), FIRST_PAGE, readContext());
    expect(result.ok).toBe(true);
    if (!result.ok || !result.evidence.found) throw new Error('expected a listing');
    expect(result.evidence.self).toMatchObject({ name: 'etc', path: '/etc', type: 'directory' });
    expect(result.evidence.entries.map((entry) => entry.name)).toEqual(['a.txt', 'link']);
    expect(result.evidence.entries[0]).toMatchObject({ path: '/etc/a.txt', size: 12, downloadable: true });
    expect(result.evidence.entries[1]).toMatchObject({ type: 'symlink', size: null, downloadable: false });
    expect(result.evidence.nextOffset).toBeNull();

    const spec = calls[0];
    expect(spec.profile).toBe('read');
    expect(spec.cmd).toEqual([
      '/restic', '--repo', '/repo', '--no-cache',
      'ls', SNAPSHOT, '/data/etc', '--json', '--no-lock', '--quiet',
    ]);
    expect(spec.mounts).toEqual({ repository: REPOSITORY.locator });
    expect(spec.stdinSecret).toBe('repository-password');
    // A listing has a deadline; a file body does not.
    expect(spec.timeoutMs).toBe(120 * 1000);
  });

  it('maps the point root onto the mount, so no argument can read as a flag', async () => {
    const { calls, runner } = runnerReturning(() => ({ exitCode: 0 }));
    await engineWith(runner).readDirectory(READ('/'), FIRST_PAGE, readContext());
    await engineWith(runner).readDirectory(READ('/-rf'), FIRST_PAGE, readContext());
    // `ls <snapshot> <path>`: the path argument always starts with the mount.
    expect(calls[0].cmd.slice(4, 7)).toEqual(['ls', SNAPSHOT, '/data']);
    expect(calls[1].cmd.slice(4, 7)).toEqual(['ls', SNAPSHOT, '/data/-rf']);
  });

  it('skips to the offset, holds one page, and stops itself on the entry past it', async () => {
    let printed = 0;
    const { calls, runner } = runnerReturning((spec) => {
      spec.onStdoutLine?.(nodeLine({ name: 'big', type: 'dir', path: '/data/big' }));
      for (let index = 0; index < 1_200; index += 1) {
        if (spec.signal?.aborted) break;
        printed += 1;
        const name = `f${String(index).padStart(4, '0')}`;
        spec.onStdoutLine?.(nodeLine({ name, type: 'file', path: `/data/big/${name}`, size: 1 }));
      }
      // The engine aborted the run on purpose, so the helper exits through a
      // signal; the read is still a success.
      return { exitCode: 130, aborted: true };
    });

    const result = await engineWith(runner).readDirectory(READ('/big'), { offset: 500, pageSize: 500 }, readContext());
    if (!result.ok || !result.evidence.found) throw new Error('expected a listing');
    expect(result.evidence.entries).toHaveLength(500);
    expect(result.evidence.entries[0].name).toBe('f0500');
    expect(result.evidence.entries[499].name).toBe('f0999');
    expect(result.evidence.nextOffset).toBe(1_000);
    expect(calls[0].signal?.aborted).toBe(true);
    expect(printed).toBe(1_001);
  });

  it('answers the last page with no next offset', async () => {
    const { runner } = runnerReturning((spec) => {
      spec.onStdoutLine?.(nodeLine({ name: 'big', type: 'dir', path: '/data/big' }));
      for (let index = 0; index < 1_200; index += 1) {
        spec.onStdoutLine?.(nodeLine({ name: `f${index}`, type: 'file', path: `/data/big/f${index}`, size: 1 }));
      }
      return { exitCode: 0 };
    });
    const result = await engineWith(runner).readDirectory(READ('/big'), { offset: 1_000, pageSize: 500 }, readContext());
    if (!result.ok || !result.evidence.found) throw new Error('expected a listing');
    expect(result.evidence.entries).toHaveLength(200);
    expect(result.evidence.nextOffset).toBeNull();
  });

  it('reads one record alone and stops, for a download lookup', async () => {
    const { calls, runner } = runnerReturning((spec) => {
      spec.onStdoutLine?.(nodeLine({ name: 'etc', type: 'dir', path: '/data/etc' }));
      spec.onStdoutLine?.(nodeLine({ name: 'a.txt', type: 'file', path: '/data/etc/a.txt', size: 12 }));
      return { exitCode: 130, aborted: true };
    });
    const result = await engineWith(runner).readDirectory(READ('/etc'), { offset: 0, pageSize: 0 }, readContext());
    expect(result).toEqual({
      ok: true,
      evidence: { found: true, self: expect.objectContaining({ type: 'directory' }), entries: [], nextOffset: null },
    });
    expect(calls[0].signal?.aborted).toBe(true);
  });

  it('answers found: false when the path is not in the snapshot', async () => {
    const { runner } = runnerReturning((spec) => {
      spec.onStdoutLine?.('{"message_type":"snapshot","struct_type":"snapshot"}');
      return { exitCode: 0 };
    });
    expect(await engineWith(runner).readDirectory(READ('/nope'), FIRST_PAGE, readContext()))
      .toEqual({ ok: true, evidence: { found: false } });
  });

  it('fails a listing whose output holds a record it cannot trust, instead of shortening the page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { calls, runner } = runnerReturning((spec) => {
      spec.onStdoutLine?.(nodeLine({ name: 'etc', type: 'dir', path: '/data/etc' }));
      spec.onStdoutLine?.(nodeLine({ name: 'a.txt', type: 'file', path: '/data/etc/a.txt', size: 1 }));
      // A record the line cap cut short.
      spec.onStdoutLine?.('{"name":"b.txt","type":"file","path":"/data/etc/b');
      spec.onStdoutLine?.(nodeLine({ name: 'c.txt', type: 'file', path: '/data/etc/c.txt', size: 1 }));
      return { exitCode: 130, aborted: true };
    });
    expect(await engineWith(runner).readDirectory(READ('/etc'), FIRST_PAGE, readContext()))
      .toEqual({ ok: false, errorClass: 'node_error' });
    expect(calls[0].signal?.aborted).toBe(true);
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/cannot read/);
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
      expect(await engineWith(runner).readDirectory(READ('/'), FIRST_PAGE, readContext())).toEqual({ ok: false, errorClass });
    }
    expect(warn).toHaveBeenCalledTimes(cases.length);
    // The log line is the only place restic's own message survives.
    expect(warn.mock.calls[0].join(' ')).toContain('something specific');
  });

  it('redacts the repository password from the failure log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { runner } = runnerReturning(() => ({
      exitCode: 1,
      stderrTail: 'Fatal: open /repo: permission denied (password repository-password)',
    }));
    await engineWith(runner).readDirectory(READ('/'), FIRST_PAGE, readContext());
    const printed = warn.mock.calls.map((call) => call.join(' ')).join('\n');
    expect(printed).not.toContain('repository-password');
  });

  it('reads a cancelled run as interrupted, not as a failure', async () => {
    const caller = new AbortController();
    const { runner } = runnerReturning(() => {
      caller.abort();
      return { exitCode: 130, aborted: true };
    });
    expect(await engineWith(runner).readDirectory(READ('/'), FIRST_PAGE, readContext(caller.signal)))
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
      READ('/a.txt'),
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
    expect(await engineWith(runner).dumpFile(READ('/a.txt'), 5, () => undefined, readContext()))
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
  // duplex keeps its readable side open at the same time. Only that first close
  // is swallowed, so the test can still end the stream it writes.
  const realEnd = attach.end.bind(attach);
  let stdinClosed = false;
  attach.end = ((...args: unknown[]) => {
    if (!stdinClosed) {
      stdinClosed = true;
      return attach;
    }
    return (realEnd as (...rest: unknown[]) => PassThrough)(...args);
  }) as unknown as PassThrough['end'];
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
        // The route resumes on the response's 'drain'. After the process exits
        // the runner waits for the tail, so the test has to drain too.
        setTimeout(() => control.resume(), 10);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(pause).toHaveBeenCalled();
    // The runner resumes before waiting for the tail, so the second chunk lands.
    await vi.waitFor(() => expect(received.join('')).toBe('firstsecond'));
    expect(resume).toHaveBeenCalled();
    expect(fake.removed).toEqual(['helper']);
  });

  it('settles an aborted run whose sink pauses on every chunk and never resumes', async () => {
    const controller = new AbortController();
    const fake = streamingDocker((attach) => {
      attach.write(Buffer.from('a'));
      // The client went away while the stream was paused for backpressure; the
      // route's sink keeps refusing chunks and nothing will ever resume it.
      controller.abort();
      attach.write(Buffer.from('b'));
      attach.write(Buffer.from('c'));
      attach.end();
    });
    const received: string[] = [];
    const run = realRunner(fake.docker).run({
      profile: 'read',
      operationId: 'op-abort-paused',
      cmd: ['/restic', 'version'],
      mounts: { repository: REPOSITORY.locator },
      signal: controller.signal,
      onStdoutChunk: (chunk, control: ContentChunkControl) => {
        received.push(chunk.toString());
        control.pause();
      },
    });
    const outcome = await Promise.race([
      run.then((result) => ({ settled: true as const, result })),
      new Promise<{ settled: false }>((resolve) => setTimeout(() => resolve({ settled: false }), 3_000)),
    ]);
    expect(outcome.settled).toBe(true);
    if (outcome.settled) expect(outcome.result.aborted).toBe(true);
    expect(fake.removed).toEqual(['helper']);
  }, 10_000);

  it('settles a run whose sink pauses again on the tail after the process exited', async () => {
    const fake = streamingDocker((attach) => {
      attach.write(Buffer.from('a'));
      attach.write(Buffer.from('b'));
      attach.write(Buffer.from('c'));
      attach.end();
    });
    const received: string[] = [];
    const run = realRunner(fake.docker).run({
      profile: 'read',
      operationId: 'op-exit-paused',
      cmd: ['/restic', 'version'],
      mounts: { repository: REPOSITORY.locator },
      onStdoutChunk: (chunk, control: ContentChunkControl) => {
        received.push(chunk.toString());
        control.pause();
      },
    });
    const outcome = await Promise.race([
      run.then(() => 'settled'),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 3_000)),
    ]);
    expect(outcome).toBe('settled');
    // Every byte of the tail reached the sink, so the byte count stays honest.
    expect(received.join('')).toBe('abc');
    expect(fake.removed).toEqual(['helper']);
  }, 10_000);

  it('resumes a paused stream as soon as the run is aborted, so the helper can drain and exit', async () => {
    const controller = new AbortController();
    let flowingAfterAbort: boolean | null = null;
    let pausedBeforeAbort: boolean | null = null;
    const fake = streamingDocker((attach) => {
      attach.write(Buffer.from('a'));
      pausedBeforeAbort = attach.isPaused();
      controller.abort();
      // Read before the process exits: a stream left paused here would block the
      // helper's writes until SIGKILL instead of letting SIGINT end it.
      flowingAfterAbort = !attach.isPaused();
      attach.end();
    });
    await realRunner(fake.docker).run({
      profile: 'read',
      operationId: 'op-abort-resume',
      cmd: ['/restic', 'version'],
      mounts: { repository: REPOSITORY.locator },
      signal: controller.signal,
      onStdoutChunk: (_chunk, control: ContentChunkControl) => control.pause(),
    });
    // The sink really had paused the stream, so the resume is what freed it.
    expect(pausedBeforeAbort).toBe(true);
    expect(flowingAfterAbort).toBe(true);
  });

  it('bounds the wait for a paused tail whose socket never closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const fake = streamingDocker((attach) => {
        attach.write(Buffer.from('a'));
        // The process exits, but the attach socket never ends.
      });
      let settled = false;
      const run = realRunner(fake.docker).run({
        profile: 'read',
        operationId: 'op-tail-bound',
        cmd: ['/restic', 'version'],
        mounts: { repository: REPOSITORY.locator },
        onStdoutChunk: (_chunk, control: ContentChunkControl) => control.pause(),
      }).then((result) => { settled = true; return result; });
      await vi.advanceTimersByTimeAsync(HELPER_PAUSED_TAIL_MS - 1_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      const result = await run;
      expect(result.exitCode).toBe(0);
      expect(fake.removed).toEqual(['helper']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a multi-byte character whole when a frame boundary splits it', async () => {
    const line = Buffer.from(`${JSON.stringify({ name: '\u65e5\u672c\u8a9e', path: '/data/\u65e5\u672c\u8a9e' })}\n`);
    const cut = line.indexOf(Buffer.from('\u672c')) + 1;
    const fake = streamingDocker((attach) => {
      attach.write(line.subarray(0, cut));
      attach.write(line.subarray(cut));
      attach.end();
    });
    const lines: string[] = [];
    await realRunner(fake.docker).run({
      profile: 'read',
      operationId: 'op-utf8',
      cmd: ['/restic', 'version'],
      mounts: { repository: REPOSITORY.locator },
      onStdoutLine: (text) => lines.push(text),
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ name: '\u65e5\u672c\u8a9e', path: '/data/\u65e5\u672c\u8a9e' });
    expect(lines[0]).not.toContain('\ufffd');
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
