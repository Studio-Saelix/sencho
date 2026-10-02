/**
 * The bounded reuse of a "did not answer" reachability verdict
 * (`probeSilentNodeIds`, services/gitops/portfolioAggregator.ts).
 *
 * The portfolio list, the application detail panel, and the stack drift panel
 * all read reachability about the same nodes, and a node that does not answer
 * costs the whole probe budget each time it is asked. What is pinned here:
 *
 *   - a dark verdict is reused inside a window strictly shorter than the probe
 *     budget, so repeated reads pay one round trip;
 *   - readers that overlap share one probe, because a verdict is only written
 *     once a probe settles and a dark node spends the whole budget settling;
 *   - sharing one leg is what orders the two writers, so a dark verdict cannot
 *     land after a newer answer;
 *   - a node that came back is seen back as soon as the window has passed, and
 *     never stranded as unreachable;
 *   - a reachable verdict is never reused, so nothing can be reported as up
 *     after it went dark;
 *   - a leg this build could not read is not remembered as a dark node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheService } from '../services/CacheService';
import {
  probeSilentNodeIds,
  REACHABILITY_VERDICT_TTL_MS,
  REMOTE_PROBE_TIMEOUT_MS,
  resetReachabilityProbesForTests,
} from '../services/gitops/portfolioAggregator';

type ProbeResult = unknown[] | null | 'unsupported';

/** Just past the reuse window, so the verdict is expired without guessing at it. */
const AFTER_THE_WINDOW_MS = REACHABILITY_VERDICT_TTL_MS + 1;

beforeEach(() => {
  CacheService.getInstance().flush();
  // A leg is normally released when it settles, so a test that failed before
  // releasing one would otherwise leave a pending promise every later read of
  // that node id joins.
  resetReachabilityProbesForTests();
});

afterEach(() => {
  vi.useRealTimers();
  CacheService.getInstance().flush();
});

/**
 * The freshness ceiling the product's live probes share: the GitOps portfolio
 * probe budget, the fleet overview probe budget, and the fleet readiness
 * evidence budget. Spelled as a literal rather than imported, because the
 * window has to stay under the ceiling those three agree on, not under one of
 * them: raising this read model's probe budget on its own would otherwise
 * leave a widened window looking compliant while the other two surfaces still
 * treat 3 s as the bound.
 */
const SHARED_PROBE_CEILING_MS = 3000;

describe('reachability verdict reuse', () => {
  it('keeps the reuse window under the shared probe ceiling', () => {
    // The window caps how long a recorded verdict is served. It does not bound
    // how old the evidence behind it is: a dark verdict is recorded when its
    // probe gives up, so the worst case is the probe budget plus this window.
    // The live comparison catches a window that outgrew this read model's own
    // budget, and the literal catches one that outgrew the ceiling the rest of
    // the product still assumes.
    expect(REACHABILITY_VERDICT_TTL_MS).toBeLessThan(REMOTE_PROBE_TIMEOUT_MS);
    expect(REACHABILITY_VERDICT_TTL_MS).toBeLessThan(SHARED_PROBE_CEILING_MS);
  });

  it('answers a dark node from the reuse window instead of probing it again', async () => {
    const fetchRows = vi.fn<(nodeId: number) => Promise<ProbeResult>>(async () => null);

    const first = await probeSilentNodeIds([4], fetchRows);
    const second = await probeSilentNodeIds([4], fetchRows);

    expect([...first]).toEqual([4]);
    expect([...second]).toEqual([4]);
    expect(fetchRows).toHaveBeenCalledTimes(1);
  });

  it('probes a node again once the reuse window has passed', async () => {
    const fetchRows = vi.fn<(nodeId: number) => Promise<ProbeResult>>(async () => null);
    await probeSilentNodeIds([4], fetchRows);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.advanceTimersByTime(AFTER_THE_WINDOW_MS);
    await probeSilentNodeIds([4], fetchRows);

    expect(fetchRows).toHaveBeenCalledTimes(2);
  });

  it('sees a node back no later than one probe after the reuse window', async () => {
    let answering = false;
    const fetchRows = vi.fn<(nodeId: number) => Promise<ProbeResult>>(async () => (answering ? [] : null));

    expect([...(await probeSilentNodeIds([4], fetchRows))]).toEqual([4]);

    // Inside the window the node is still reported dark without a probe. That is
    // the cost of reusing the verdict, and it is bounded: the window is shorter
    // than the probe budget, so the panel cannot be wrong for longer than asking
    // would have taken.
    answering = true;
    expect([...(await probeSilentNodeIds([4], fetchRows))]).toEqual([4]);
    expect(fetchRows).toHaveBeenCalledTimes(1);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.advanceTimersByTime(AFTER_THE_WINDOW_MS);
    expect([...(await probeSilentNodeIds([4], fetchRows))]).toEqual([]);
    expect(fetchRows).toHaveBeenCalledTimes(2);

    // A dark verdict is recorded again the moment the node stops answering.
    answering = false;
    expect([...(await probeSilentNodeIds([4], fetchRows))]).toEqual([4]);
    expect(fetchRows).toHaveBeenCalledTimes(3);
  });

  it('lets a live answer retire a dark verdict written by another writer', async () => {
    // Pinning the write itself: whatever put a dark verdict in the cache, a
    // probe that sees the node answer has to retire it. The entry is written
    // directly rather than through a second leg because one leg per node is the
    // rule now, so no other writer can be mid-probe while this one runs.
    let release: (rows: ProbeResult) => void = () => {};
    const fetchRows = vi.fn<(nodeId: number) => Promise<ProbeResult>>(() => {
      if (fetchRows.mock.calls.length > 1) return Promise.resolve<ProbeResult>([]);
      return new Promise<ProbeResult>((resolve) => { release = resolve; });
    });

    const pending = probeSilentNodeIds([4], fetchRows);
    // Stands in for the fan-out leg, which writes the same entry.
    CacheService.getInstance().set(`gitops-reachability:4`, true, REACHABILITY_VERDICT_TTL_MS);
    release([]);

    expect([...(await pending)]).toEqual([]);
    expect([...(await probeSilentNodeIds([4], fetchRows))]).toEqual([]);
    expect(fetchRows).toHaveBeenCalledTimes(2);
  });

  it('gives overlapping readers one probe of a node', async () => {
    // The panel, the drift panel and the list all ask about the same node at
    // once, and a dark node takes the whole probe budget to settle. Readers
    // that arrive while a leg is in flight have to join it, not start their own,
    // or the cache never gets a chance to answer anyone.
    let release: (rows: ProbeResult) => void = () => {};
    const fetchRows = vi.fn<(nodeId: number) => Promise<ProbeResult>>(() => new Promise<ProbeResult>((resolve) => {
      release = resolve;
    }));

    const first = probeSilentNodeIds([4], fetchRows);
    const second = probeSilentNodeIds([4], fetchRows);
    const third = probeSilentNodeIds([4], fetchRows);
    release(null);

    expect([...(await first)]).toEqual([4]);
    expect([...(await second)]).toEqual([4]);
    expect([...(await third)]).toEqual([4]);
    expect(fetchRows).toHaveBeenCalledTimes(1);
  });

  it('gives a reader that arrives late the probe already in flight', async () => {
    let release: (rows: ProbeResult) => void = () => {};
    const fetchRows = vi.fn<(nodeId: number) => Promise<ProbeResult>>(() => new Promise<ProbeResult>((resolve) => {
      release = resolve;
    }));

    const first = probeSilentNodeIds([4], fetchRows);
    // The second read only starts once the first leg is genuinely under way.
    await Promise.resolve();
    const second = probeSilentNodeIds([4], fetchRows);
    release([]);

    expect([...(await first)]).toEqual([]);
    expect([...(await second)]).toEqual([]);
    expect(fetchRows).toHaveBeenCalledTimes(1);
  });

  it('records one verdict per probe rather than one per reader', async () => {
    // The ordering guarantee, pinned by what it costs rather than by when it
    // happens. Three readers share one leg; the leg owns the write, so the
    // verdict is recorded once. A reader that wrote its own answer would record it
    // three times, which both reopens the late-write gap and re-arms the reuse
    // window once per read instead of once per probe.
    const cache = CacheService.getInstance();
    const set = vi.spyOn(cache, 'set');
    const invalidate = vi.spyOn(cache, 'invalidate');
    const fetchRows = vi.fn<(nodeId: number) => Promise<ProbeResult>>(async () => null);

    await Promise.all([
      probeSilentNodeIds([4], fetchRows),
      probeSilentNodeIds([4], fetchRows),
      probeSilentNodeIds([4], fetchRows),
    ]);

    expect(fetchRows).toHaveBeenCalledTimes(1);
    expect(set.mock.calls.filter(([key]) => key === 'gitops-reachability:4')).toHaveLength(1);
    expect(invalidate).not.toHaveBeenCalled();
    set.mockRestore();
    invalidate.mockRestore();
  });

  it('does not let a reader that arrives late put its own verdict back', async () => {
    // A reader collects its result long after the probe settled and a newer leg
    // has seen the node answer. Its stale dark result must not overwrite that.
    let releaseDark: (rows: ProbeResult) => void = () => {};
    const fetchRows = vi.fn<(nodeId: number) => Promise<ProbeResult>>(() => new Promise<ProbeResult>((resolve) => {
      releaseDark = resolve;
    }));

    const late = probeSilentNodeIds([4], fetchRows);
    releaseDark(null);
    await Promise.resolve();

    // Let the window lapse so a newer leg can start, and let it see the node
    // answer, which retires the dark verdict.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.advanceTimersByTime(AFTER_THE_WINDOW_MS);
    expect([...(await probeSilentNodeIds([4], async () => []))]).toEqual([]);
    vi.useRealTimers();

    // Only now does the late reader collect its own dark result.
    expect([...(await late)]).toEqual([4]);
    expect(CacheService.getInstance().peek('gitops-reachability:4')).toBeUndefined();
  });

  it('settles a joined reader even when the probe it joined rejects', async () => {
    // One shared leg means one rejection reaches every joined reader. Each has
    // to report the throw the same way, or the surfaces would disagree about
    // which of them saw the failure.
    const fetchRows = vi.fn<(nodeId: number) => Promise<ProbeResult>>(() => Promise.reject(new Error('probe blew up')));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const [first, second] = await Promise.all([
      probeSilentNodeIds([4], fetchRows),
      probeSilentNodeIds([4], fetchRows),
    ]);

    expect([...first]).toEqual([]);
    expect([...second]).toEqual([]);
    expect(fetchRows).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('never reuses a reachable verdict', async () => {
    const fetchRows = vi.fn<(nodeId: number) => Promise<ProbeResult>>(async () => []);

    expect([...(await probeSilentNodeIds([4], fetchRows))]).toEqual([]);
    expect([...(await probeSilentNodeIds([4], fetchRows))]).toEqual([]);
    expect(fetchRows).toHaveBeenCalledTimes(2);
  });

  it('treats a node that answered but cannot be read as not dark', async () => {
    const fetchRows = vi.fn<(nodeId: number) => Promise<ProbeResult>>(async () => 'unsupported');

    expect([...(await probeSilentNodeIds([4], fetchRows))]).toEqual([]);
    expect([...(await probeSilentNodeIds([4], fetchRows))]).toEqual([]);
    expect(fetchRows).toHaveBeenCalledTimes(2);
  });

  it('does not remember a leg that threw as a dark node', async () => {
    const fetchRows = vi.fn<(nodeId: number) => Promise<ProbeResult>>(async () => {
      throw new Error('probe blew up');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect([...(await probeSilentNodeIds([4], fetchRows))]).toEqual([]);
    expect([...(await probeSilentNodeIds([4], fetchRows))]).toEqual([]);

    expect(fetchRows).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});