import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
import { FleetPruneCard } from './FleetPruneCard';

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

function estimateResponse() {
  return jsonResponse(200, {
    totalBytes: 4096,
    perNode: [{ nodeId: 1, nodeName: 'central', reclaimableBytes: 4096, reachable: true }],
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/prune/estimate') return Promise.resolve(estimateResponse());
    return Promise.resolve(jsonResponse(404, {}));
  });
});

it('keeps destructive prune disabled until an itemized dry run is reviewed', async () => {
  render(<FleetPruneCard nodes={nodes} />);
  await waitFor(() => expect(screen.getByText('~ 4 KB reclaimable')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeDisabled();
  expect(screen.getByText(/Run Dry run to unlock Prune fleet/)).toBeInTheDocument();
});

it('drops the unlock footer once dry run review is valid', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/prune/estimate') return Promise.resolve(estimateResponse());
    if (url === '/fleet/labels/fleet-prune') return Promise.resolve(jsonResponse(200, { results: [planResult] }));
    return Promise.resolve(jsonResponse(404, {}));
  });

  render(<FleetPruneCard nodes={nodes} />);
  await waitFor(() => expect(screen.getByText(/Run Dry run to unlock Prune fleet/)).toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: 'Dry run' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeEnabled());
  expect(screen.queryByText(/Run Dry run to unlock Prune fleet/)).not.toBeInTheDocument();
  expect(screen.getByText(/Reversible · no · reviewed across 1 node/)).toBeInTheDocument();
});

it('renders item metadata and enables prune after a valid dry run', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/prune/estimate') return Promise.resolve(estimateResponse());
    if (url === '/fleet/labels/fleet-prune') return Promise.resolve(jsonResponse(200, { results: [planResult] }));
    return Promise.resolve(jsonResponse(404, {}));
  });

  render(<FleetPruneCard nodes={nodes} />);
  await user.click(screen.getByRole('button', { name: 'Dry run' }));

  await waitFor(() => expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeEnabled());
  expect(screen.getByText('example/app:latest')).toBeInTheDocument();
  expect(screen.getByText('managed')).toBeInTheDocument();
  expect(screen.getByText(/stack app/)).toBeInTheDocument();
  expect(screen.getByText('example/app@sha256:digest')).toBeInTheDocument();
  const dryRunCall = mockedFetch.mock.calls.find((call) => call[0] === '/fleet/labels/fleet-prune');
  expect(JSON.parse(dryRunCall![1].body)).toEqual({ targets: ['images'], scope: 'managed', dryRun: true });
});

it('submits the reviewed roster and fingerprint then renders item outcomes', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/fleet/prune/estimate') return Promise.resolve(estimateResponse());
    if (url === '/fleet/labels/fleet-prune') {
      const body = JSON.parse(String(init?.body));
      if (body.dryRun) return Promise.resolve(jsonResponse(200, { results: [planResult] }));
      return Promise.resolve(jsonResponse(200, {
        results: [{
          nodeId: 1,
          nodeName: 'central',
          reachable: true,
          reclaimedBytes: 4096,
          outcomes: [{ id: 'sha256:abcdef1234567890', target: 'images', status: 'removed', sizeBytes: 4096 }],
          targets: [{ target: 'images', success: true, reclaimedBytes: 4096, dryRun: false, removed: 1, skipped: 0, failed: 0 }],
        }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });

  render(<FleetPruneCard nodes={nodes} />);
  await user.click(screen.getByRole('button', { name: 'Dry run' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Prune fleet' }));
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Prune managed' }));

  await waitFor(() => expect(screen.getByText('removed')).toBeInTheDocument());
  const executeCall = mockedFetch.mock.calls
    .filter((call) => call[0] === '/fleet/labels/fleet-prune')
    .find((call) => JSON.parse(call[1].body).dryRun === false);
  expect(JSON.parse(executeCall![1].body)).toEqual({
    targets: ['images'],
    scope: 'managed',
    dryRun: false,
    reviewedNodes: [{ nodeId: 1, reachable: true }],
    plans: [{ nodeId: 1, fingerprint: 'reviewed-fingerprint' }],
  });
  expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeDisabled();
});

it('invalidates authorization when targets or scope change', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/prune/estimate') return Promise.resolve(estimateResponse());
    if (url === '/fleet/labels/fleet-prune') return Promise.resolve(jsonResponse(200, { results: [planResult] }));
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<FleetPruneCard nodes={nodes} />);
  await user.click(screen.getByRole('button', { name: 'Dry run' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeEnabled());
  await user.click(screen.getByRole('checkbox', { name: 'Volumes' }));
  expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeDisabled();
  expect(screen.queryByText('example/app:latest')).not.toBeInTheDocument();
});

it('invalidates authorization when the node roster or status changes', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/prune/estimate') return Promise.resolve(estimateResponse());
    if (url === '/fleet/labels/fleet-prune') return Promise.resolve(jsonResponse(200, { results: [planResult] }));
    return Promise.resolve(jsonResponse(404, {}));
  });
  const view = render(<FleetPruneCard nodes={nodes} />);
  await user.click(screen.getByRole('button', { name: 'Dry run' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeEnabled());
  view.rerender(<FleetPruneCard nodes={[{ ...nodes[0], status: 'offline' }]} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeDisabled());
});

it('shows unreachable nodes as excluded without treating them as empty plans', async () => {
  const user = userEvent.setup();
  const unreachable = {
    nodeId: 1,
    nodeName: 'central',
    reachable: false,
    error: 'Pilot tunnel is disconnected',
    reclaimableBytes: 0,
    targets: [{ target: 'images', success: false, reclaimedBytes: 0, dryRun: true, error: 'Pilot tunnel is disconnected' }],
  };
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/prune/estimate') return Promise.resolve(estimateResponse());
    if (url === '/fleet/labels/fleet-prune') return Promise.resolve(jsonResponse(200, { results: [unreachable] }));
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<FleetPruneCard nodes={nodes} />);
  await user.click(screen.getByRole('button', { name: 'Dry run' }));
  expect(await screen.findByText('central · excluded')).toBeInTheDocument();
  expect(screen.getByText('Pilot tunnel is disconnected')).toBeInTheDocument();
});

it('accepts a valid empty plan', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/prune/estimate') return Promise.resolve(estimateResponse());
    if (url === '/fleet/labels/fleet-prune') return Promise.resolve(jsonResponse(200, {
      results: [{ ...planResult, items: [], reclaimableBytes: 0, targets: [{ ...planResult.targets[0], reclaimedBytes: 0 }] }],
    }));
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<FleetPruneCard nodes={nodes} />);
  await user.click(screen.getByRole('button', { name: 'Dry run' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeEnabled());
  expect(screen.getByText('Images · 0 · 0 Bytes')).toBeInTheDocument();
});

it('uses the exact stale-plan toast and clears authorization', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/fleet/prune/estimate') return Promise.resolve(estimateResponse());
    if (url === '/fleet/labels/fleet-prune') {
      const body = JSON.parse(String(init?.body));
      if (body.dryRun) return Promise.resolve(jsonResponse(200, { results: [planResult] }));
      return Promise.resolve(jsonResponse(409, {
        code: 'PRUNE_PLAN_STALE',
        nodeId: 1,
        error: 'The prune plan changed on central after the dry run',
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<FleetPruneCard nodes={nodes} />);
  await user.click(screen.getByRole('button', { name: 'Dry run' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Prune fleet' }));
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Prune managed' }));
  await waitFor(() => expect(toastError).toHaveBeenCalledWith(
    'The prune plan changed on “central” after the dry run. Run the dry run again before pruning.',
  ));
  expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeDisabled();
  expect(screen.queryByText('example/app:latest')).not.toBeInTheDocument();
});

it('reports an execution-time stale race from a partial result', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/fleet/prune/estimate') return Promise.resolve(estimateResponse());
    if (url === '/fleet/labels/fleet-prune') {
      const body = JSON.parse(String(init?.body));
      if (body.dryRun) return Promise.resolve(jsonResponse(200, { results: [planResult] }));
      return Promise.resolve(jsonResponse(200, {
        results: [{
          nodeId: 1,
          nodeName: 'central',
          reachable: true,
          code: 'PRUNE_PLAN_STALE',
          error: 'Prune plan changed',
          reclaimedBytes: 0,
          targets: [{ target: 'images', success: false, reclaimedBytes: 0, dryRun: false, error: 'Prune plan changed' }],
        }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<FleetPruneCard nodes={nodes} />);
  await user.click(screen.getByRole('button', { name: 'Dry run' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Prune fleet' }));
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Prune managed' }));

  await waitFor(() => expect(toastError).toHaveBeenCalledWith(
    'The prune plan changed on “central” after the dry run. Run the dry run again before pruning.',
  ));
  expect(toastWarning).not.toHaveBeenCalled();
  expect(screen.getByText('Prune plan changed')).toBeInTheDocument();
});

it('rejects an incomplete successful execute response', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/fleet/prune/estimate') return Promise.resolve(estimateResponse());
    if (url === '/fleet/labels/fleet-prune') {
      const body = JSON.parse(String(init?.body));
      if (body.dryRun) return Promise.resolve(jsonResponse(200, { results: [planResult] }));
      return Promise.resolve(jsonResponse(200, { results: [] }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<FleetPruneCard nodes={nodes} />);
  await user.click(screen.getByRole('button', { name: 'Dry run' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Prune fleet' }));
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Prune managed' }));

  await waitFor(() => expect(toastError).toHaveBeenCalledWith('Fleet prune returned an incomplete node result set'));
  expect(toastSuccess).not.toHaveBeenCalledWith(expect.stringContaining('Reclaimed'));
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
  mockedFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/fleet/prune/estimate') return Promise.resolve(estimateResponse());
    if (url === '/fleet/labels/fleet-prune') {
      const body = JSON.parse(String(init?.body));
      return Promise.resolve(jsonResponse(200, body.dryRun ? { results: [planResult] } : { results }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<FleetPruneCard nodes={nodes} />);
  await user.click(screen.getByRole('button', { name: 'Dry run' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Prune fleet' }));
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Prune managed' }));
  await waitFor(() => expect(toastError).toHaveBeenCalledWith('Fleet prune returned an incomplete node result set'));
  expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeDisabled();
});

it('warns when another node mutated before an execution-time stale result', async () => {
  const user = userEvent.setup();
  const twoNodes = [...nodes, { id: 2, name: 'edge', status: 'online' }] as unknown as FleetNode[];
  const edgePlan = { ...planResult, nodeId: 2, nodeName: 'edge', fingerprint: 'edge-fingerprint' };
  mockedFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/fleet/prune/estimate') return Promise.resolve(estimateResponse());
    if (url === '/fleet/labels/fleet-prune') {
      const body = JSON.parse(String(init?.body));
      if (body.dryRun) return Promise.resolve(jsonResponse(200, { results: [planResult, edgePlan] }));
      return Promise.resolve(jsonResponse(200, {
        results: [
          {
            nodeId: 1, nodeName: 'central', reachable: true, reclaimedBytes: 4096,
            outcomes: [{ id: 'sha256:abcdef1234567890', target: 'images', status: 'removed', sizeBytes: 4096 }],
            targets: [{ target: 'images', success: true, reclaimedBytes: 4096, dryRun: false }],
          },
          {
            nodeId: 2, nodeName: 'edge', reachable: true, code: 'PRUNE_PLAN_STALE',
            error: 'Prune plan changed', reclaimedBytes: 0,
            targets: [{ target: 'images', success: false, reclaimedBytes: 0, dryRun: false, error: 'Prune plan changed' }],
          },
        ],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<FleetPruneCard nodes={twoNodes} />);
  await user.click(screen.getByRole('button', { name: 'Dry run' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Prune fleet' }));
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Prune managed' }));

  await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(
    'Fleet prune partially completed: 4 KB reclaimed before the plan changed on “edge”. Run the dry run again before pruning.',
  ));
});
