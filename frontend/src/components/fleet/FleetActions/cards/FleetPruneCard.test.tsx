/**
 * Coverage for FleetPruneCard.
 *
 * The key safety property: the destructive "Prune fleet" confirm is blocked
 * until the operator has seen a live reclaim estimate. Also locks dry-run
 * payload shape, the all-scope confirm copy, and the failure toast.
 */
import { it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
    info: vi.fn(),
    warning: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    dismiss: vi.fn(),
  },
}));

import { apiFetch } from '@/lib/api';
import { FleetPruneCard } from './FleetPruneCard';
import type { FleetNode } from '@/components/FleetView/types';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const nodes = [{ id: 1, name: 'central', status: 'online' }] as unknown as FleetNode[];

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetch.mockResolvedValue(jsonResponse(404, {}));
});

it('blocks the prune confirm until a reclaim estimate is ready', async () => {
  // Estimate endpoint never resolves to ready (404 -> unavailable).
  render(<FleetPruneCard nodes={nodes} />);
  // images is selected by default, so an estimate is requested but unavailable.
  await waitFor(() => expect(screen.getByText('~ estimate unavailable')).toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeDisabled();
});

it('enables the prune confirm once the estimate resolves', async () => {
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/prune/estimate') {
      return Promise.resolve(jsonResponse(200, { totalBytes: 1024, perNode: [{ nodeId: 1, nodeName: 'central', reclaimableBytes: 1024, reachable: true }] }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<FleetPruneCard nodes={nodes} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeEnabled());
});

it('all-scope confirm spells out the irreversible all-unused prune', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/prune/estimate') {
      return Promise.resolve(jsonResponse(200, { totalBytes: 2048, perNode: [] }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<FleetPruneCard nodes={nodes} />);
  await user.click(screen.getByRole('button', { name: 'All unused' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Prune fleet' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText('Prune ALL unused resources across the fleet?')).toBeInTheDocument();
  expect(within(dialog).getByText(/This cannot be undone\./)).toBeInTheDocument();
});

it('dry run sends dryRun:true and reports reclaimable bytes', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/prune/estimate') {
      return Promise.resolve(jsonResponse(200, { totalBytes: 0, perNode: [] }));
    }
    if (url === '/fleet/labels/fleet-prune') {
      return Promise.resolve(jsonResponse(200, {
        results: [{ nodeId: 1, nodeName: 'central', reachable: true, targets: [{ target: 'images', success: true, reclaimedBytes: 4096, dryRun: true }] }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<FleetPruneCard nodes={nodes} />);
  await user.click(screen.getByRole('button', { name: 'Dry run' }));
  await waitFor(() => {
    const call = mockedFetch.mock.calls.find(c => c[0] === '/fleet/labels/fleet-prune');
    expect(call).toBeTruthy();
    expect(JSON.parse(call![1].body)).toEqual({ targets: ['images'], scope: 'managed', dryRun: true });
  });
  await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
});

it('surfaces an error toast when the prune returns non-ok', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/fleet-prune') {
      return Promise.resolve(jsonResponse(500, { error: 'prune blew up' }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<FleetPruneCard nodes={nodes} />);
  await user.click(screen.getByRole('button', { name: 'Dry run' }));
  await waitFor(() => expect(toastError).toHaveBeenCalledWith('prune blew up'));
});

function estimateCallCount(): number {
  return mockedFetch.mock.calls.filter(c => c[0] === '/fleet/prune/estimate').length;
}

it('re-fetches the estimate after a partial-success real prune', async () => {
  const user = userEvent.setup();
  let estimatePhase: 'pre' | 'post' = 'pre';
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/prune/estimate') {
      if (estimatePhase === 'pre') {
        return Promise.resolve(jsonResponse(200, {
          totalBytes: 1024,
          perNode: [{ nodeId: 1, nodeName: 'central', reclaimableBytes: 1024, reachable: true }],
        }));
      }
      return Promise.resolve(jsonResponse(200, {
        totalBytes: 0,
        perNode: [{ nodeId: 1, nodeName: 'central', reclaimableBytes: 0, reachable: true }],
      }));
    }
    if (url === '/fleet/labels/fleet-prune') {
      // One target succeeded before a later failure left the node unreachable.
      // reachable:false must not suppress the refresh (target.success is the signal).
      return Promise.resolve(jsonResponse(200, {
        results: [{
          nodeId: 1,
          nodeName: 'central',
          reachable: false,
          error: 'transport failed after images',
          targets: [
            { target: 'images', success: true, reclaimedBytes: 1024 },
            { target: 'volumes', success: false, reclaimedBytes: 0, error: 'unreachable' },
          ],
        }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });

  render(<FleetPruneCard nodes={nodes} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeEnabled());
  expect(screen.getByText('~ 1 KB reclaimable')).toBeInTheDocument();
  expect(screen.getByText('1 KB')).toBeInTheDocument();
  const callsBeforePrune = estimateCallCount();

  await user.click(screen.getByRole('button', { name: 'Prune fleet' }));
  const dialog = await screen.findByRole('alertdialog');
  estimatePhase = 'post';
  await user.click(within(dialog).getByRole('button', { name: 'Prune managed' }));

  await waitFor(() => expect(estimateCallCount()).toBe(callsBeforePrune + 1));
  const postEstimateCall = [...mockedFetch.mock.calls].reverse().find(c => c[0] === '/fleet/prune/estimate');
  expect(postEstimateCall).toBeTruthy();
  expect(JSON.parse(postEstimateCall![1].body)).toEqual({ targets: ['images'], scope: 'managed' });
  await waitFor(() => expect(screen.getByText('0 reclaimable')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByText('0 Bytes')).toBeInTheDocument());
});

it('does not re-fetch the estimate after a dry run', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/prune/estimate') {
      return Promise.resolve(jsonResponse(200, {
        totalBytes: 1024,
        perNode: [{ nodeId: 1, nodeName: 'central', reclaimableBytes: 1024, reachable: true }],
      }));
    }
    if (url === '/fleet/labels/fleet-prune') {
      return Promise.resolve(jsonResponse(200, {
        results: [{
          nodeId: 1,
          nodeName: 'central',
          reachable: true,
          targets: [{ target: 'images', success: true, reclaimedBytes: 4096, dryRun: true }],
        }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });

  render(<FleetPruneCard nodes={nodes} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeEnabled());
  const callsBefore = estimateCallCount();
  await user.click(screen.getByRole('button', { name: 'Dry run' }));
  await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
  // Debounce window: a refresh would schedule another estimate within 350ms.
  await new Promise(r => setTimeout(r, 500));
  expect(estimateCallCount()).toBe(callsBefore);
});

it('does not re-fetch the estimate when every target fails on a 2xx response', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/prune/estimate') {
      return Promise.resolve(jsonResponse(200, {
        totalBytes: 1024,
        perNode: [{ nodeId: 1, nodeName: 'central', reclaimableBytes: 1024, reachable: true }],
      }));
    }
    if (url === '/fleet/labels/fleet-prune') {
      return Promise.resolve(jsonResponse(200, {
        results: [{
          nodeId: 1,
          nodeName: 'central',
          reachable: true,
          targets: [{ target: 'images', success: false, reclaimedBytes: 0, error: 'A prune is already running on this node' }],
        }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });

  render(<FleetPruneCard nodes={nodes} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Prune fleet' })).toBeEnabled());
  const callsBefore = estimateCallCount();
  await user.click(screen.getByRole('button', { name: 'Prune fleet' }));
  const dialog = await screen.findByRole('alertdialog');
  await user.click(within(dialog).getByRole('button', { name: 'Prune managed' }));
  await waitFor(() => expect(toastError).toHaveBeenCalled());
  await new Promise(r => setTimeout(r, 500));
  expect(estimateCallCount()).toBe(callsBefore);
});
