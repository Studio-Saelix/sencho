import { beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

const toastError = vi.fn();
const toastSuccess = vi.fn();
const toastWarning = vi.fn();
vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
    warning: (...args: unknown[]) => toastWarning(...args),
    info: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    dismiss: vi.fn(),
  },
}));

import { apiFetch } from '@/lib/api';
import type { FleetNode } from '@/components/FleetView/types';
import { ReclaimSheet } from './ReclaimSheet';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const nodes = [{ id: 1, name: 'central', status: 'online' }] as unknown as FleetNode[];

const planResult = {
  nodeId: 1,
  nodeName: 'central',
  reachable: true,
  fingerprint: 'reviewed-fingerprint',
  reclaimableBytes: 4096,
  items: [{
    target: 'images',
    id: 'sha256:abcdef1234567890',
    name: 'example/app:latest',
    sizeBytes: 4096,
    managed: true,
    reason: 'Image is not used by any container',
    stackName: 'app',
    image: {
      references: ['example/app:latest'],
      digest: 'example/app@sha256:digest',
      createdAt: 1_700_000_000,
    },
  }],
  targets: [{ target: 'images', success: true, reclaimedBytes: 4096, dryRun: true }],
};

const removedResult = {
  nodeId: 1,
  nodeName: 'central',
  reachable: true,
  reclaimedBytes: 4096,
  outcomes: [{ id: 'sha256:abcdef1234567890', target: 'images', status: 'removed', sizeBytes: 4096 }],
  targets: [{ target: 'images', success: true, reclaimedBytes: 4096, dryRun: false, removed: 1, skipped: 0, failed: 0 }],
};

type Handler = (body: Record<string, unknown>) => Response;

/** Routes the one prune endpoint by dryRun so a test only states what differs. */
function routePrune(onDryRun: Handler, onExecute: Handler = () => jsonResponse(500, {})) {
  mockedFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url !== '/fleet/labels/fleet-prune') return Promise.resolve(jsonResponse(404, {}));
    const body = JSON.parse(String(init?.body));
    return Promise.resolve(body.dryRun ? onDryRun(body) : onExecute(body));
  });
}

function pruneCalls(dryRun: boolean) {
  return mockedFetch.mock.calls
    .filter((call) => call[0] === '/fleet/labels/fleet-prune')
    .map((call) => JSON.parse(call[1].body))
    .filter((body) => body.dryRun === dryRun);
}

function renderSheet(props: Partial<React.ComponentProps<typeof ReclaimSheet>> = {}) {
  const onPruned = vi.fn();
  const onOpenChange = vi.fn();
  const view = render(<ReclaimSheet open onOpenChange={onOpenChange} nodes={nodes} onPruned={onPruned} {...props} />);
  return { ...view, onPruned, onOpenChange };
}

async function waitForPlan() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prune' })).toBeEnabled());
}

async function pruneNow(user: ReturnType<typeof userEvent.setup>) {
  await waitForPlan();
  await user.click(screen.getByRole('button', { name: 'Prune' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  routePrune(() => jsonResponse(200, { results: [planResult] }));
});

it('builds the plan on open and keeps Prune disabled until it is reviewed', async () => {
  renderSheet();
  expect(screen.getByRole('button', { name: 'Prune' })).toBeDisabled();
  expect(await screen.findByText('4 KB to reclaim')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Prune' })).toBeEnabled();
  expect(pruneCalls(true)).toEqual([{ targets: ['images'], scope: 'managed', dryRun: true }]);
});

it('does not touch the network while closed', () => {
  renderSheet({ open: false });
  expect(mockedFetch).not.toHaveBeenCalled();
});

it('shows the reviewed items behind the collapsed per-node plan', async () => {
  const user = userEvent.setup();
  renderSheet();
  await screen.findByText('4 KB to reclaim');
  expect(screen.queryByTestId('status-proof')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Per-node plan' }));
  expect(screen.getByText('example/app:latest')).toBeInTheDocument();
  expect(screen.getByText('managed')).toBeInTheDocument();
  expect(screen.getByText(/stack app/)).toBeInTheDocument();
  expect(screen.getByText('example/app@sha256:digest')).toBeInTheDocument();
});

it('names a plan with nothing to reclaim and leaves Prune disabled', async () => {
  routePrune(() => jsonResponse(200, {
    results: [{ ...planResult, items: [], reclaimableBytes: 0, targets: [{ ...planResult.targets[0], reclaimedBytes: 0 }] }],
  }));
  renderSheet();
  expect(await screen.findByText('Nothing to reclaim')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Prune' })).toBeDisabled();
});

it('shows unreachable nodes as left out, not as an empty plan', async () => {
  const user = userEvent.setup();
  routePrune(() => jsonResponse(200, {
    results: [{
      nodeId: 1, nodeName: 'central', reachable: false, error: 'Pilot tunnel is disconnected', reclaimableBytes: 0,
      targets: [{ target: 'images', success: false, reclaimedBytes: 0, dryRun: true, error: 'Pilot tunnel is disconnected' }],
    }],
  }));
  renderSheet();
  expect(await screen.findByText('No node reachable')).toBeInTheDocument();
  expect(screen.getByText('1 unreachable, left out')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Prune' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Per-node plan' }));
  expect(screen.getByText('central · excluded')).toBeInTheDocument();
  expect(screen.getByText('Pilot tunnel is disconnected')).toBeInTheDocument();
});

it('rebuilds the plan when a target changes and blocks Prune meanwhile', async () => {
  const user = userEvent.setup();
  renderSheet();
  await waitForPlan();
  await user.click(screen.getByRole('checkbox', { name: 'Volumes' }));
  expect(screen.getByRole('button', { name: 'Prune' })).toBeDisabled();
  await waitFor(() => expect(pruneCalls(true)).toHaveLength(2));
  expect(pruneCalls(true)[1]).toEqual({ targets: ['images', 'volumes'], scope: 'managed', dryRun: true });
});

it('rebuilds for the wider scope and labels the commit accordingly', async () => {
  const user = userEvent.setup();
  renderSheet();
  await waitForPlan();
  await user.click(screen.getByRole('radio', { name: 'All unused' }));
  await waitFor(() => expect(pruneCalls(true)).toHaveLength(2));
  expect(pruneCalls(true)[1].scope).toBe('all');
  expect(await screen.findByRole('button', { name: 'Prune all' })).toBeEnabled();
});

it('ignores a plan that resolves after the options changed', async () => {
  const user = userEvent.setup();
  const pending: Array<(response: Response) => void> = [];
  mockedFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url !== '/fleet/labels/fleet-prune' || !JSON.parse(String(init?.body)).dryRun) return Promise.resolve(jsonResponse(404, {}));
    return new Promise<Response>((resolve) => { pending.push(resolve); });
  });
  renderSheet();
  await waitFor(() => expect(pending).toHaveLength(1));
  await user.click(screen.getByRole('checkbox', { name: 'Volumes' }));
  await waitFor(() => expect(pending).toHaveLength(2));

  await act(async () => { pending[0](jsonResponse(200, { results: [planResult] })); });
  expect(screen.getByRole('button', { name: 'Prune' })).toBeDisabled();
  expect(screen.queryByText('4 KB to reclaim')).not.toBeInTheDocument();

  const volumePlan = {
    ...planResult,
    items: [...planResult.items, { target: 'volumes', id: 'vol', name: 'data', sizeBytes: 1024, managed: true, reason: 'unused', volume: {} }],
    reclaimableBytes: 5120,
    targets: [...planResult.targets, { target: 'volumes', success: true, reclaimedBytes: 1024, dryRun: true }],
  };
  await act(async () => { pending[1](jsonResponse(200, { results: [volumePlan] })); });
  expect(await screen.findByText('5 KB to reclaim')).toBeInTheDocument();
});

it('reports a plan that could not be built and retries from Rebuild', async () => {
  const user = userEvent.setup();
  routePrune(() => jsonResponse(500, { error: 'Docker is busy' }));
  renderSheet();
  expect(await screen.findByText('Plan unavailable')).toBeInTheDocument();
  expect(screen.getByText('Docker is busy')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Prune' })).toBeDisabled();

  routePrune(() => jsonResponse(200, { results: [planResult] }));
  await user.click(screen.getByRole('button', { name: 'Rebuild' }));
  expect(await screen.findByText('4 KB to reclaim')).toBeInTheDocument();
});

it('submits the reviewed roster and fingerprint, then turns the sheet into the result', async () => {
  const user = userEvent.setup();
  routePrune(() => jsonResponse(200, { results: [planResult] }), () => jsonResponse(200, { results: [removedResult] }));
  const { onPruned } = renderSheet();
  await pruneNow(user);

  expect(await screen.findByText('Reclaimed 4 KB')).toBeInTheDocument();
  expect(pruneCalls(false)).toEqual([{
    targets: ['images'],
    scope: 'managed',
    dryRun: false,
    reviewedNodes: [{ nodeId: 1, reachable: true }],
    plans: [{ nodeId: 1, fingerprint: 'reviewed-fingerprint' }],
  }]);
  expect(screen.queryByRole('button', { name: 'Prune' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
  expect(screen.getByRole('checkbox', { name: 'Images' })).toBeDisabled();
  expect(onPruned).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Per-node outcome' }));
  expect(screen.getByText('removed')).toBeInTheDocument();
});

it('closes from Done', async () => {
  const user = userEvent.setup();
  routePrune(() => jsonResponse(200, { results: [planResult] }), () => jsonResponse(200, { results: [removedResult] }));
  const { onOpenChange } = renderSheet();
  await pruneNow(user);
  await user.click(await screen.findByRole('button', { name: 'Done' }));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it('discards the plan and rebuilds when the node roster or status changes', async () => {
  const view = renderSheet();
  await waitForPlan();
  view.rerender(<ReclaimSheet open onOpenChange={vi.fn()} nodes={[{ ...nodes[0], status: 'offline' }] as FleetNode[]} onPruned={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prune' })).toBeDisabled());
  await waitFor(() => expect(pruneCalls(true)).toHaveLength(2));
  await waitForPlan();
});

it('rebuilds with a notice when the node refuses a stale plan', async () => {
  const user = userEvent.setup();
  routePrune(
    () => jsonResponse(200, { results: [planResult] }),
    () => jsonResponse(409, { code: 'PRUNE_PLAN_STALE', nodeId: 1, error: 'The prune plan changed on central after the dry run' }),
  );
  renderSheet();
  await pruneNow(user);
  await waitFor(() => expect(toastError).toHaveBeenCalledWith(
    'The prune plan changed on “central” after it was built. Review the new plan.',
  ));
  await waitFor(() => expect(pruneCalls(true)).toHaveLength(2));
  expect(await screen.findByText(/The plan changed on “central” after it was built/)).toBeInTheDocument();
});

it('reports an execution-time stale race and offers to review the new plan', async () => {
  const user = userEvent.setup();
  routePrune(() => jsonResponse(200, { results: [planResult] }), () => jsonResponse(200, {
    results: [{
      nodeId: 1, nodeName: 'central', reachable: true, code: 'PRUNE_PLAN_STALE', error: 'Prune plan changed', reclaimedBytes: 0,
      targets: [{ target: 'images', success: false, reclaimedBytes: 0, dryRun: false, error: 'Prune plan changed' }],
    }],
  }));
  renderSheet();
  await pruneNow(user);

  expect(await screen.findByText('Nothing was pruned')).toBeInTheDocument();
  expect(toastError).toHaveBeenCalledWith('The prune plan changed on “central” after it was built. Review the new plan.');
  expect(toastWarning).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Review new plan' }));
  await waitFor(() => expect(pruneCalls(true)).toHaveLength(2));
  expect(await screen.findByText('4 KB to reclaim')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Prune' })).toBeEnabled();
});

it('warns when another node mutated before an execution-time stale result', async () => {
  const user = userEvent.setup();
  const twoNodes = [...nodes, { id: 2, name: 'edge', status: 'online' }] as unknown as FleetNode[];
  const edgePlan = { ...planResult, nodeId: 2, nodeName: 'edge', fingerprint: 'edge-fingerprint' };
  routePrune(() => jsonResponse(200, { results: [planResult, edgePlan] }), () => jsonResponse(200, {
    results: [
      removedResult,
      {
        nodeId: 2, nodeName: 'edge', reachable: true, code: 'PRUNE_PLAN_STALE', error: 'Prune plan changed', reclaimedBytes: 0,
        targets: [{ target: 'images', success: false, reclaimedBytes: 0, dryRun: false, error: 'Prune plan changed' }],
      },
    ],
  }));
  renderSheet({ nodes: twoNodes });
  await pruneNow(user);

  await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(
    'Fleet prune partially completed: 4 KB reclaimed before the plan changed on “edge”. Review the new plan.',
  ));
  expect(await screen.findByText('Partly pruned, 4 KB reclaimed')).toBeInTheDocument();
});

it('names skipped items on the result without hiding the reclaimed bytes', async () => {
  const user = userEvent.setup();
  routePrune(() => jsonResponse(200, { results: [planResult] }), () => jsonResponse(200, {
    results: [{
      ...removedResult,
      outcomes: [{ id: 'sha256:abcdef1234567890', target: 'images', status: 'skipped', reason: 'Became active' }],
      reclaimedBytes: 0,
      targets: [{ target: 'images', success: true, reclaimedBytes: 0, dryRun: false, removed: 0, skipped: 1, failed: 0 }],
    }],
  }));
  const { onPruned } = renderSheet();
  await pruneNow(user);
  expect(await screen.findByText('1 skipped')).toBeInTheDocument();
  expect(onPruned).not.toHaveBeenCalled();
});

it('rejects an incomplete successful execute response, refreshes the estimate and builds a fresh plan', async () => {
  const user = userEvent.setup();
  routePrune(() => jsonResponse(200, { results: [planResult] }), () => jsonResponse(200, { results: [] }));
  const { onPruned } = renderSheet();
  await pruneNow(user);

  await waitFor(() => expect(toastError).toHaveBeenCalledWith('Fleet prune returned an incomplete node result set'));
  expect(toastSuccess).not.toHaveBeenCalledWith(expect.stringContaining('Reclaimed'));
  // The request was accepted, so some nodes may already have pruned: the list estimate must refresh.
  expect(onPruned).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(pruneCalls(true)).toHaveLength(2));
  expect(await screen.findByText(/Some nodes may already have pruned/)).toBeInTheDocument();
});

it.each([
  ['unexpected node', [{ nodeId: 99, nodeName: 'other', reachable: true, reclaimedBytes: 0, targets: [] }]],
  ['malformed target', [{ nodeId: 1, nodeName: 'central', reachable: true, reclaimedBytes: 0, targets: [null] }]],
  ['negative total', [{
    nodeId: 1, nodeName: 'central', reachable: true, reclaimedBytes: -1,
    targets: [{ target: 'images', success: true, reclaimedBytes: 0, dryRun: false }],
  }]],
  ['malformed outcomes', [{
    nodeId: 1, nodeName: 'central', reachable: true, reclaimedBytes: 0,
    outcomes: [{ target: 'images', id: 'sha256:abcdef1234567890', status: 'failed' }],
    targets: [{ target: 'images', success: false, reclaimedBytes: 0, dryRun: false }],
  }]],
])('rejects an execute response with %s', async (_label, results) => {
  const user = userEvent.setup();
  routePrune(() => jsonResponse(200, { results: [planResult] }), () => jsonResponse(200, { results }));
  renderSheet();
  await pruneNow(user);
  await waitFor(() => expect(toastError).toHaveBeenCalledWith('Fleet prune returned an incomplete node result set'));
  expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
});

it('builds the first plan at once, without waiting for the input debounce', async () => {
  renderSheet();
  await waitFor(() => expect(pruneCalls(true)).toHaveLength(1), { timeout: 200 });
});

it('coalesces rapid option changes into one rebuild', async () => {
  const user = userEvent.setup();
  renderSheet();
  await waitForPlan();
  await user.click(screen.getByRole('checkbox', { name: 'Volumes' }));
  await user.click(screen.getByRole('checkbox', { name: 'Networks' }));
  await waitFor(() => expect(pruneCalls(true)).toHaveLength(2));
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(pruneCalls(true)).toHaveLength(2);
  expect(pruneCalls(true)[1].targets).toEqual(['images', 'networks', 'volumes']);
});

it('ignores an older plan that resolves after a newer one', async () => {
  const user = userEvent.setup();
  const pending: Array<(response: Response) => void> = [];
  mockedFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url !== '/fleet/labels/fleet-prune' || !JSON.parse(String(init?.body)).dryRun) return Promise.resolve(jsonResponse(404, {}));
    return new Promise<Response>((resolve) => { pending.push(resolve); });
  });
  renderSheet();
  await waitFor(() => expect(pending).toHaveLength(1));
  await user.click(screen.getByRole('checkbox', { name: 'Volumes' }));
  await waitFor(() => expect(pending).toHaveLength(2));

  const volumePlan = {
    ...planResult,
    items: [...planResult.items, { target: 'volumes', id: 'vol', name: 'data', sizeBytes: 1024, managed: true, reason: 'unused', volume: {} }],
    reclaimableBytes: 5120,
    targets: [...planResult.targets, { target: 'volumes', success: true, reclaimedBytes: 1024, dryRun: true }],
  };
  await act(async () => { pending[1](jsonResponse(200, { results: [volumePlan] })); });
  expect(await screen.findByText('5 KB to reclaim')).toBeInTheDocument();
  await act(async () => { pending[0](jsonResponse(200, { results: [planResult] })); });
  expect(screen.getByText('5 KB to reclaim')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Prune' })).toBeEnabled();
});

it('reports a plan that does not cover every reachable node instead of showing a blank section', async () => {
  routePrune(() => jsonResponse(200, { results: [] }));
  renderSheet();
  expect(await screen.findByText('Plan unavailable')).toBeInTheDocument();
  expect(screen.getByText('The plan did not cover every reachable node. Rebuild to try again.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Prune' })).toBeDisabled();
});

it('asks for a target when every option is unticked and builds nothing', async () => {
  const user = userEvent.setup();
  renderSheet();
  await waitForPlan();
  await user.click(screen.getByRole('checkbox', { name: 'Images' }));
  expect(await screen.findByText('Pick at least one target to build a plan.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Prune' })).toBeDisabled();
  await new Promise((resolve) => setTimeout(resolve, 450));
  expect(pruneCalls(true)).toHaveLength(1);
});

it('sends every reviewed node but only the reachable ones with a fingerprint', async () => {
  const user = userEvent.setup();
  const twoNodes = [...nodes, { id: 2, name: 'edge', status: 'offline' }] as unknown as FleetNode[];
  const edgeDown = { nodeId: 2, nodeName: 'edge', reachable: false, error: 'Pilot tunnel is disconnected', reclaimableBytes: 0, targets: [] };
  routePrune(() => jsonResponse(200, { results: [planResult, edgeDown] }), () => jsonResponse(200, { results: [removedResult] }));
  renderSheet({ nodes: twoNodes });
  await pruneNow(user);
  await screen.findByText('Reclaimed 4 KB');
  expect(pruneCalls(false)[0]).toMatchObject({
    reviewedNodes: [{ nodeId: 1, reachable: true }, { nodeId: 2, reachable: false }],
    plans: [{ nodeId: 1, fingerprint: 'reviewed-fingerprint' }],
  });
});

it('warns and marks the result when the plan left a node out of the run', async () => {
  const user = userEvent.setup();
  const twoNodes = [...nodes, { id: 2, name: 'edge', status: 'offline' }] as unknown as FleetNode[];
  const edgeDown = { nodeId: 2, nodeName: 'edge', reachable: false, error: 'Pilot tunnel is disconnected', reclaimableBytes: 0, targets: [] };
  routePrune(() => jsonResponse(200, { results: [planResult, edgeDown] }), () => jsonResponse(200, { results: [removedResult] }));
  renderSheet({ nodes: twoNodes });
  await pruneNow(user);

  expect(await screen.findByText('Reclaimed 4 KB')).toBeInTheDocument();
  const answer = screen.getByTestId('status-answer');
  expect(answer).toHaveAttribute('data-tone', 'warning');
  expect(screen.getByTestId('status-marker')).toHaveTextContent('1 node unreachable, left out');
  // The excluded node stays visible behind the proof as well.
  await user.click(screen.getByRole('button', { name: 'Per-node outcome' }));
  expect(screen.getByText('edge · excluded')).toBeInTheDocument();
  await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(
    'Reclaimed 4 KB across 1 node; 1 node unreachable, left out.',
  ));
  expect(toastSuccess).not.toHaveBeenCalled();
});

it('does not let Prune be clicked again on the old plan after a refused run', async () => {
  const user = userEvent.setup();
  let dryRuns = 0;
  mockedFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url !== '/fleet/labels/fleet-prune') return Promise.resolve(jsonResponse(404, {}));
    if (!JSON.parse(String(init?.body)).dryRun) return Promise.resolve(jsonResponse(500, { error: 'Docker is busy' }));
    dryRuns += 1;
    // The rebuild after the refusal stays in flight, so only the dropped plan can keep Prune off.
    return dryRuns === 1 ? Promise.resolve(jsonResponse(200, { results: [planResult] })) : new Promise<Response>(() => {});
  });
  renderSheet();
  await pruneNow(user);
  await waitFor(() => expect(toastError).toHaveBeenCalledWith('Docker is busy'));
  expect(screen.getByRole('button', { name: 'Prune' })).toBeDisabled();
  await waitFor(() => expect(pruneCalls(true)).toHaveLength(2));
  expect(pruneCalls(false)).toHaveLength(1);
});

it('explains a refused run on the plan it rebuilds', async () => {
  const user = userEvent.setup();
  routePrune(() => jsonResponse(200, { results: [planResult] }), () => jsonResponse(500, { error: 'Docker is busy' }));
  renderSheet();
  await pruneNow(user);
  expect(await screen.findByText(/Docker is busy\. Review the new plan\./)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Prune' })).toBeEnabled();
});

it('keeps the running prune and then the result when the node roster changes', async () => {
  const user = userEvent.setup();
  let finish: ((response: Response) => void) | null = null;
  mockedFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url !== '/fleet/labels/fleet-prune') return Promise.resolve(jsonResponse(404, {}));
    if (JSON.parse(String(init?.body)).dryRun) return Promise.resolve(jsonResponse(200, { results: [planResult] }));
    return new Promise<Response>((resolve) => { finish = resolve; });
  });
  const view = renderSheet();
  await pruneNow(user);
  await waitFor(() => expect(finish).not.toBeNull());

  view.rerender(<ReclaimSheet open onOpenChange={vi.fn()} nodes={[{ ...nodes[0], status: 'offline' }] as FleetNode[]} onPruned={vi.fn()} />);
  await act(async () => { finish!(jsonResponse(200, { results: [removedResult] })); });
  expect(await screen.findByText('Reclaimed 4 KB')).toBeInTheDocument();
  // No plan was queued by the roster change while the prune ran.
  await new Promise((resolve) => setTimeout(resolve, 450));
  expect(pruneCalls(true)).toHaveLength(1);
  expect(screen.getByText('Reclaimed 4 KB')).toBeInTheDocument();

  // And a later roster change leaves the finished result alone.
  view.rerender(<ReclaimSheet open onOpenChange={vi.fn()} nodes={nodes} onPruned={vi.fn()} />);
  await new Promise((resolve) => setTimeout(resolve, 450));
  expect(screen.getByText('Reclaimed 4 KB')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
  expect(pruneCalls(true)).toHaveLength(1);
});

it('cannot be dismissed while a prune is running, and closes from Done afterwards', async () => {
  const user = userEvent.setup();
  let finish: ((response: Response) => void) | null = null;
  mockedFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url !== '/fleet/labels/fleet-prune') return Promise.resolve(jsonResponse(404, {}));
    if (JSON.parse(String(init?.body)).dryRun) return Promise.resolve(jsonResponse(200, { results: [planResult] }));
    return new Promise<Response>((resolve) => { finish = resolve; });
  });
  const { onOpenChange } = renderSheet();
  await pruneNow(user);
  await waitFor(() => expect(finish).not.toBeNull());
  await user.keyboard('{Escape}');
  expect(onOpenChange).not.toHaveBeenCalledWith(false);

  await act(async () => { finish!(jsonResponse(200, { results: [removedResult] })); });
  await user.click(await screen.findByRole('button', { name: 'Done' }));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it('shows the building placeholder, not a blank section, when the roster changes while Prune runs', async () => {
  const user = userEvent.setup();
  let finish: ((response: Response) => void) | null = null;
  mockedFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url !== '/fleet/labels/fleet-prune') return Promise.resolve(jsonResponse(404, {}));
    if (JSON.parse(String(init?.body)).dryRun) return Promise.resolve(jsonResponse(200, { results: [planResult] }));
    return new Promise<Response>((resolve) => { finish = resolve; });
  });
  const view = renderSheet();
  await pruneNow(user);
  await waitFor(() => expect(finish).not.toBeNull());
  expect(screen.queryByTestId('plan-building')).not.toBeInTheDocument();

  view.rerender(<ReclaimSheet open onOpenChange={vi.fn()} nodes={[{ ...nodes[0], status: 'offline' }] as FleetNode[]} onPruned={vi.fn()} />);
  expect(await screen.findByTestId('plan-building')).toBeInTheDocument();
  await act(async () => { finish!(jsonResponse(200, { results: [removedResult] })); });
  await screen.findByText('Reclaimed 4 KB');
});

it('clears a refusal notice when the options change', async () => {
  const user = userEvent.setup();
  routePrune(() => jsonResponse(200, { results: [planResult] }), () => jsonResponse(500, { error: 'Docker is busy' }));
  renderSheet();
  await pruneNow(user);
  expect(await screen.findByText(/Docker is busy\. Review the new plan\./)).toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: 'Volumes' }));
  await waitFor(() => expect(screen.queryByText(/Docker is busy/)).not.toBeInTheDocument());
});

it('refreshes the estimate after a refused run, because nodes may already have pruned', async () => {
  const user = userEvent.setup();
  routePrune(() => jsonResponse(200, { results: [planResult] }), () => jsonResponse(500, { error: 'Docker is busy' }));
  const { onPruned } = renderSheet();
  await pruneNow(user);
  await waitFor(() => expect(onPruned).toHaveBeenCalledTimes(1));
});

it('keeps the refusal notice on the failure when the rebuilt plan cannot be built either', async () => {
  const user = userEvent.setup();
  let dryRuns = 0;
  mockedFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url !== '/fleet/labels/fleet-prune') return Promise.resolve(jsonResponse(404, {}));
    if (!JSON.parse(String(init?.body)).dryRun) return Promise.resolve(jsonResponse(500, { error: 'Docker is busy' }));
    dryRuns += 1;
    return Promise.resolve(dryRuns === 1 ? jsonResponse(200, { results: [planResult] }) : jsonResponse(500, { error: 'Docker is down' }));
  });
  renderSheet();
  await pruneNow(user);
  expect(await screen.findByText('Plan unavailable')).toBeInTheDocument();
  expect(screen.getByText('Docker is down')).toBeInTheDocument();
  expect(screen.getByText(/Docker is busy\. Review the new plan\./)).toBeInTheDocument();
});

it('replaces an earlier stale-plan notice with the failure of the next run', async () => {
  const user = userEvent.setup();
  let executes = 0;
  routePrune(
    () => jsonResponse(200, { results: [planResult] }),
    () => {
      executes += 1;
      return executes === 1
        ? jsonResponse(409, { code: 'PRUNE_PLAN_STALE', nodeId: 1, error: 'The prune plan changed on central after the dry run' })
        : jsonResponse(500, { error: 'Docker is busy' });
    },
  );
  renderSheet();
  await pruneNow(user);
  expect(await screen.findByText(/The plan changed on “central”/)).toBeInTheDocument();
  await waitForPlan();
  await user.click(screen.getByRole('button', { name: 'Prune' }));
  expect(await screen.findByText(/Docker is busy\. Review the new plan\./)).toBeInTheDocument();
  expect(screen.queryByText(/The plan changed on “central”/)).not.toBeInTheDocument();
});
