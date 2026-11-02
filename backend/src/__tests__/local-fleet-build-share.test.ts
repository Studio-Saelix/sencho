import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FleetReadTimeoutError } from '../helpers/fleetReadBudget';
import {
  LOCAL_FLEET_BUILD_MAX_AGE_MS,
  LOCAL_FLEET_BUILD_SHARE_TTL_MS,
  LocalFleetBuildShare,
} from '../helpers/localFleetBuildShare';

class Cut extends Error {}

/** A reader that gives up `afterMs` after it starts, the way a deadline does. */
function boundedBy(afterMs: number) {
  return (work: () => Promise<string>): Promise<string> => {
    const build = work();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Cut('deadline')), afterMs);
      build.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error: unknown) => { clearTimeout(timer); reject(error); },
      );
    });
  };
}

/** The deadline the hub reads run under: it throws the budget error, not a bare Error. */
function deadlineAt(afterMs: number) {
  return (work: () => Promise<string>): Promise<string> => {
    const build = work();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new FleetReadTimeoutError(afterMs, 'test read')), afterMs);
      build.then(
        (value) => { clearTimeout(timer); resolve(value); },
        (error: unknown) => { clearTimeout(timer); reject(error); },
      );
    });
  };
}

const unbounded = (work: () => Promise<string>): Promise<string> => work();

function heldBuild(value: string): { start: () => Promise<string>; release: () => void; calls: () => number } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let count = 0;
  return {
    start: () => { count += 1; return gate.then(() => value); },
    release,
    calls: () => count,
  };
}

let share: LocalFleetBuildShare<string>;

beforeEach(() => {
  vi.useFakeTimers();
  share = new LocalFleetBuildShare<string>();
});

afterEach(() => {
  share.clear();
  vi.useRealTimers();
});

describe('LocalFleetBuildShare', () => {
  it('lets a retry that arrives after the read deadline join the still-running build', async () => {
    const build = heldBuild('answer');
    const cut = share.read('k', build.start, boundedBy(25_000)).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(25_000);
    expect(await cut).toBeInstanceOf(Cut);

    // One second past the deadline: the build is 26 s old, older than the finished-answer window.
    await vi.advanceTimersByTimeAsync(1_000);
    const retry = share.read('k', build.start, unbounded);
    build.release();

    expect(await retry).toBe('answer');
    expect(build.calls()).toBe(1);
  });

  it('stops joining a running build exactly at the maximum age', async () => {
    const build = heldBuild('answer');
    const first = share.read('k', build.start, boundedBy(10)).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(LOCAL_FLEET_BUILD_MAX_AGE_MS - 1);
    await first;
    const joined = share.read('k', build.start, unbounded);
    expect(build.calls()).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    const fresh = share.read('k', build.start, unbounded);
    expect(build.calls()).toBe(2);

    build.release();
    await Promise.all([joined, fresh]);
  });

  it('counts the finished-answer window from when the build settled, not when it started', async () => {
    const build = heldBuild('answer');
    const cut = share.read('k', build.start, boundedBy(100)).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(100);
    await cut;

    // The build runs for 24 s, far longer than the 10 s window, then settles.
    await vi.advanceTimersByTimeAsync(24_000);
    build.release();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(LOCAL_FLEET_BUILD_SHARE_TTL_MS - 1);

    expect(await share.read('k', build.start, unbounded)).toBe('answer');
    expect(build.calls()).toBe(1);
  });

  it('drops an unread finished answer once its window passes, without another read', async () => {
    const build = heldBuild('answer');
    const cut = share.read('k', build.start, boundedBy(100)).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(100);
    await cut;
    build.release();
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(LOCAL_FLEET_BUILD_SHARE_TTL_MS);

    expect(vi.getTimerCount()).toBe(0);
    // The next read builds again rather than finding the dropped answer.
    expect(await share.read('k', () => Promise.resolve('new'), unbounded)).toBe('new');
  });

  it('drops a build that never settles at the maximum age, without another read', async () => {
    const cut = share.read('k', () => new Promise<string>(() => {}), boundedBy(100)).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(100);
    await cut;

    await vi.advanceTimersByTimeAsync(LOCAL_FLEET_BUILD_MAX_AGE_MS);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps one build per key, so an unread build of one key never answers another', async () => {
    const a = heldBuild('a');
    const b = heldBuild('b');
    const cutA = share.read('node-1', a.start, boundedBy(100)).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(100);
    await cutA;
    a.release();
    await vi.advanceTimersByTimeAsync(0);

    const other = share.read('node-2', b.start, unbounded);
    b.release();

    expect(await other).toBe('b');
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
  });

  it('builds again for a read after concurrent readers all received the answer', async () => {
    const build = heldBuild('answer');
    const readers = [share.read('k', build.start, unbounded), share.read('k', build.start, unbounded)];
    build.release();
    await Promise.all(readers);

    await share.read('k', () => Promise.resolve('later'), unbounded);
    expect(build.calls()).toBe(1);
    expect(await share.read('k', () => Promise.resolve('again'), unbounded)).toBe('again');
  });

  it('does not replay a build that failed after its reader gave up', async () => {
    let fail!: (error: Error) => void;
    const failing = new Promise<string>((_resolve, reject) => { fail = reject; });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const cut = share.read('k', () => failing, boundedBy(100)).catch((err: unknown) => err);
      await vi.advanceTimersByTimeAsync(100);
      await cut;
      fail(new Error('listing failed'));
      await vi.advanceTimersByTimeAsync(0);

      expect(await share.read('k', () => Promise.resolve('fresh'), unbounded)).toBe('fresh');
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});

describe('LocalFleetBuildShare kept-build mark', () => {
  it('marks a deadline that left its build running as one a retry can join', async () => {
    const build = heldBuild('answer');
    const cut = share.read('k', build.start, deadlineAt(100)).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(100);

    const error = await cut;
    expect(error).toBeInstanceOf(FleetReadTimeoutError);
    expect((error as FleetReadTimeoutError).buildKept).toBe(true);
  });

  it('does not mark a check that timed out before any build was joined', async () => {
    const build = heldBuild('answer');
    const bound = (_work: () => Promise<string>): Promise<string> => Promise.reject(new FleetReadTimeoutError(100, 'ping'));
    const error = await share.read('k', build.start, bound).catch((err: unknown) => err);

    expect((error as FleetReadTimeoutError).buildKept).toBe(false);
    expect(build.calls()).toBe(0);
  });

  it('does not mark a timeout raised by a build that itself failed', async () => {
    let fail!: (error: Error) => void;
    const failing = new Promise<string>((_resolve, reject) => { fail = reject; });
    const read = share.read('k', () => failing, unbounded).catch((err: unknown) => err);
    fail(new FleetReadTimeoutError(50, 'inner call'));

    const error = await read;
    expect(error).toBeInstanceOf(FleetReadTimeoutError);
    expect((error as FleetReadTimeoutError).buildKept).toBe(false);
  });

  it('does not mark a deadline whose build was replaced under the same key', async () => {
    const stale = heldBuild('stale');
    const fresh = heldBuild('fresh');
    const first = share.read('k', stale.start, deadlineAt(LOCAL_FLEET_BUILD_MAX_AGE_MS + 5_000)).catch((err: unknown) => err);
    // The first build ages out of the share, and a newer reader starts its own.
    await vi.advanceTimersByTimeAsync(LOCAL_FLEET_BUILD_MAX_AGE_MS + 1);
    void share.read('k', fresh.start, unbounded);
    expect(fresh.calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);

    const error = await first;
    expect(error).toBeInstanceOf(FleetReadTimeoutError);
    expect((error as FleetReadTimeoutError).buildKept).toBe(false);
  });
});
