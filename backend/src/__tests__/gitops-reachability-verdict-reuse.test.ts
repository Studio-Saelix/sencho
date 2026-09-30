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
 *   - a node that came back is seen back as soon as that window has passed, and
 *     never stranded as unreachable;
 *   - a reachable verdict is never reused, so nothing can be reported as up
 *     after it went dark;
 *   - a leg this build could not read is not remembered as a dark node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheService } from '../services/CacheService';
import { probeSilentNodeIds, REACHABILITY_VERDICT_TTL_MS, REMOTE_PROBE_TIMEOUT_MS } from '../services/gitops/portfolioAggregator';

type ProbeResult = unknown[] | null | 'unsupported';

/** Just past the reuse window, so the verdict is expired without guessing at it. */
const AFTER_THE_WINDOW_MS = REACHABILITY_VERDICT_TTL_MS + 1;

beforeEach(() => {
  CacheService.getInstance().flush();
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
    // The safety argument rests on this: a served verdict may never outlive the
    // longest a fresh probe could have taken. The live comparison catches a
    // window that outgrew this read model's own budget, and the literal catches
    // one that outgrew the ceiling the rest of the product still assumes.
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

  it('lets a live answer retire a dark verdict the fan-out wrote meanwhile', async () => {
    // Two surfaces probe the same node at once. The portfolio fan-out records
    // dark while this panel's leg is still in flight, and this leg's answer is
    // the newer evidence, so the entry has to be retired rather than left to
    // make the panel report a node the hub has just proved is up.
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