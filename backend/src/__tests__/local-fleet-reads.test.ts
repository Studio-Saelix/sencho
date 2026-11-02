import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { buildLocalGraph, computeNodeNetworkingSummary } = vi.hoisted(() => ({
  buildLocalGraph: vi.fn(),
  computeNodeNetworkingSummary: vi.fn(),
}));

vi.mock('../services/DependencyGraphService', () => ({ buildLocalGraph }));
vi.mock('../services/network/networkingSummary', () => ({ computeNodeNetworkingSummary }));

import DockerController from '../services/DockerController';
import { FleetReadTimeoutError } from '../helpers/fleetReadBudget';
import { _resetLocalFleetBuildSharesForTests } from '../helpers/localFleetBuildShare';
import { readLocalDependencyGraph, readLocalNetworkingSummary } from '../helpers/localFleetReads';

/** 100 ms liveness check inside a 400 ms deadline: the production 5 s inside 25 s, scaled down. */
const TEST_BUDGET = { livenessBudgetMs: 100, deadlineMs: 400 };
const CUT_BUDGET = { livenessBudgetMs: 50, deadlineMs: 50 };

const graph = (nodes: number) => ({ nodeId: 1, nodeName: 'hub', nodes: Array.from({ length: nodes }, (_, i) => ({ id: `n${i}` })) });
const summary = (count: number) => ({
  exposed: { count, stacks: [] },
  unknownExposure: { count: 0, stacks: [] },
  networkDrift: { count: 0, stacks: [] },
});

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

let ping: ReturnType<typeof vi.fn>;

beforeEach(() => {
  ping = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(DockerController, 'getInstance').mockReturnValue({ ping } as unknown as DockerController);
});

afterEach(() => {
  vi.restoreAllMocks();
  buildLocalGraph.mockReset();
  computeNodeNetworkingSummary.mockReset();
  _resetLocalFleetBuildSharesForTests();
});

describe('readLocalDependencyGraph', () => {
  it('lets the Map retry join the build a cut read left running', async () => {
    const hold = gate();
    buildLocalGraph.mockImplementation(async () => { await hold.promise; return graph(7); });

    const cut = await readLocalDependencyGraph(1, 'hub', CUT_BUDGET).catch((err: unknown) => err);
    expect(cut).toBeInstanceOf(FleetReadTimeoutError);
    expect(buildLocalGraph).toHaveBeenCalledTimes(1);

    const retry = readLocalDependencyGraph(1, 'hub', TEST_BUDGET);
    hold.release();

    expect((await retry).nodes).toHaveLength(7);
    expect(buildLocalGraph).toHaveBeenCalledTimes(1);
  });

  it('serves a graph that finished after its reader gave up to the retry, once', async () => {
    const hold = gate();
    buildLocalGraph.mockImplementation(async () => { await hold.promise; return graph(7); });

    await readLocalDependencyGraph(1, 'hub', CUT_BUDGET).catch(() => undefined);
    hold.release();
    await settle();

    const retry = await readLocalDependencyGraph(1, 'hub', TEST_BUDGET);
    expect(retry.nodes).toHaveLength(7);
    expect(buildLocalGraph).toHaveBeenCalledTimes(1);

    // The retry received the answer, so a later load builds again.
    buildLocalGraph.mockImplementation(async () => graph(8));
    expect((await readLocalDependencyGraph(1, 'hub', TEST_BUDGET)).nodes).toHaveLength(8);
    expect(buildLocalGraph).toHaveBeenCalledTimes(2);
  });

  it('shares one build between concurrent readers', async () => {
    buildLocalGraph.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(graph(2)), 60)));

    const [a, b] = await Promise.all([
      readLocalDependencyGraph(1, 'hub', TEST_BUDGET),
      readLocalDependencyGraph(1, 'hub', TEST_BUDGET),
    ]);

    expect(buildLocalGraph).toHaveBeenCalledTimes(1);
    expect(a.nodes).toHaveLength(2);
    expect(b.nodes).toHaveLength(2);
  });

  it('does not start a build when the daemon check never answers', async () => {
    ping.mockImplementation(() => new Promise<never>(() => {}));

    const error = await readLocalDependencyGraph(1, 'hub', TEST_BUDGET).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(FleetReadTimeoutError);
    expect((error as FleetReadTimeoutError).budgetMs).toBe(TEST_BUDGET.livenessBudgetMs);
    expect(buildLocalGraph).not.toHaveBeenCalled();
  });

  it('tries again after a build that rejected', async () => {
    buildLocalGraph.mockRejectedValueOnce(new Error('snapshot failed')).mockResolvedValueOnce(graph(1));

    await expect(readLocalDependencyGraph(1, 'hub', TEST_BUDGET)).rejects.toThrow('snapshot failed');
    expect((await readLocalDependencyGraph(1, 'hub', TEST_BUDGET)).nodes).toHaveLength(1);
    expect(buildLocalGraph).toHaveBeenCalledTimes(2);
  });

  it('does not serve one node\'s unread graph to another node or another name', async () => {
    const hold = gate();
    buildLocalGraph.mockImplementation(async (id: number, name: string) => { await hold.promise; return { ...graph(1), nodeId: id, nodeName: name }; });

    await readLocalDependencyGraph(1, 'hub', CUT_BUDGET).catch(() => undefined);
    hold.release();
    await settle();

    const otherNode = await readLocalDependencyGraph(2, 'hub', TEST_BUDGET);
    const renamed = await readLocalDependencyGraph(1, 'renamed', TEST_BUDGET);

    expect(otherNode).toMatchObject({ nodeId: 2 });
    expect(renamed).toMatchObject({ nodeId: 1, nodeName: 'renamed' });
    expect(buildLocalGraph).toHaveBeenCalledTimes(3);
  });

  it('still runs the daemon check for a retry that joins a running build', async () => {
    const hold = gate();
    buildLocalGraph.mockImplementation(async () => { await hold.promise; return graph(7); });
    await readLocalDependencyGraph(1, 'hub', CUT_BUDGET).catch(() => undefined);

    ping.mockImplementation(() => new Promise<never>(() => {}));
    const error = await readLocalDependencyGraph(1, 'hub', TEST_BUDGET).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(FleetReadTimeoutError);
    expect((error as FleetReadTimeoutError).budgetMs).toBe(TEST_BUDGET.livenessBudgetMs);
    expect(ping).toHaveBeenCalledTimes(2);
    expect(buildLocalGraph).toHaveBeenCalledTimes(1);
    hold.release();
  });

  it('surfaces a daemon check that rejects without starting a build', async () => {
    ping.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

    const error = await readLocalDependencyGraph(1, 'hub', TEST_BUDGET).catch((err: unknown) => err);

    expect(error).not.toBeInstanceOf(FleetReadTimeoutError);
    expect((error as Error).message).toContain('ECONNREFUSED');
    expect(buildLocalGraph).not.toHaveBeenCalled();
  });
});

describe('readLocalNetworkingSummary', () => {
  it('lets a retry join the build a cut read left running', async () => {
    const hold = gate();
    computeNodeNetworkingSummary.mockImplementation(async () => { await hold.promise; return summary(3); });

    const cut = await readLocalNetworkingSummary(1, { deadlineMs: 50 }).catch((err: unknown) => err);
    expect(cut).toBeInstanceOf(FleetReadTimeoutError);

    const retry = readLocalNetworkingSummary(1, { deadlineMs: 400 });
    hold.release();

    expect((await retry).exposed.count).toBe(3);
    expect(computeNodeNetworkingSummary).toHaveBeenCalledTimes(1);
  });

  it('does not replay a summary a reader already received', async () => {
    computeNodeNetworkingSummary.mockResolvedValueOnce(summary(1)).mockResolvedValueOnce(summary(2));

    expect((await readLocalNetworkingSummary(1, { deadlineMs: 400 })).exposed.count).toBe(1);
    expect((await readLocalNetworkingSummary(1, { deadlineMs: 400 })).exposed.count).toBe(2);
    expect(computeNodeNetworkingSummary).toHaveBeenCalledTimes(2);
  });

  it('never gates the summary on a daemon check', async () => {
    ping.mockImplementation(() => new Promise<never>(() => {}));
    computeNodeNetworkingSummary.mockResolvedValue(summary(0));

    await readLocalNetworkingSummary(1, { deadlineMs: 400 });

    expect(ping).not.toHaveBeenCalled();
    expect(computeNodeNetworkingSummary).toHaveBeenCalledTimes(1);
  });

  it('does not serve one node\'s unread summary to another node', async () => {
    const hold = gate();
    computeNodeNetworkingSummary.mockImplementation(async (id: number) => { await hold.promise; return summary(id); });

    await readLocalNetworkingSummary(1, { deadlineMs: 50 }).catch(() => undefined);
    hold.release();
    await settle();

    expect((await readLocalNetworkingSummary(2, { deadlineMs: 400 })).exposed.count).toBe(2);
    expect(computeNodeNetworkingSummary).toHaveBeenCalledTimes(2);
  });

  it('tries again after a build that rejected', async () => {
    computeNodeNetworkingSummary.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(summary(1));

    await expect(readLocalNetworkingSummary(1, { deadlineMs: 400 })).rejects.toThrow('boom');
    expect((await readLocalNetworkingSummary(1, { deadlineMs: 400 })).exposed.count).toBe(1);
  });
});
