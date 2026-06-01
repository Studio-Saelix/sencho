/**
 * Coverage for LabelFleetStopCard.
 *
 * Locks the destructive-action contract: buttons gated on a label name, the
 * confirm modal gates the real stop, dry run bypasses the modal, per-node
 * results render, and every failure path surfaces a toast (no silent failure).
 */
import { it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  fetchForNode: vi.fn(),
}));

const toastError = vi.fn();
const toastSuccess = vi.fn();
const toastInfo = vi.fn();
const toastWarning = vi.fn();
vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
    info: (...a: unknown[]) => toastInfo(...a),
    warning: (...a: unknown[]) => toastWarning(...a),
    loading: vi.fn(() => 'toast-id'),
    dismiss: vi.fn(),
  },
}));

import { apiFetch, fetchForNode } from '@/lib/api';
import { LabelFleetStopCard } from './LabelFleetStopCard';
import type { FleetNode } from '@/components/FleetView/types';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedFetchForNode = fetchForNode as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const nodes = [
  { id: 1, name: 'central', status: 'online' },
  { id: 2, name: 'edge-1', status: 'online' },
] as unknown as FleetNode[];

beforeEach(() => {
  vi.clearAllMocks();
  // Suggestion load on mount: no labels.
  mockedFetchForNode.mockResolvedValue(jsonResponse(200, []));
  // Default: preview unavailable so the debounce effect never throws.
  mockedFetch.mockResolvedValue(jsonResponse(404, {}));
});

it('disables both actions until a label name is entered', () => {
  render(<LabelFleetStopCard nodes={nodes} />);
  expect(screen.getByRole('button', { name: 'Stop fleet' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Dry run' })).toBeDisabled();
});

it('enables the actions once a label is typed', async () => {
  const user = userEvent.setup();
  render(<LabelFleetStopCard nodes={nodes} />);
  await user.type(screen.getByPlaceholderText('e.g. production'), 'prod');
  expect(screen.getByRole('button', { name: 'Stop fleet' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Dry run' })).toBeEnabled();
});

it('dry run calls fleet-stop with dryRun:true and never opens the confirm modal', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/fleet-stop') {
      return Promise.resolve(jsonResponse(200, {
        results: [{ nodeId: 1, nodeName: 'central', matched: true, stackResults: [{ stackName: 'web', success: true, dryRun: true }] }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<LabelFleetStopCard nodes={nodes} />);
  await user.type(screen.getByPlaceholderText('e.g. production'), 'prod');
  await user.click(screen.getByRole('button', { name: 'Dry run' }));

  await waitFor(() => {
    const stopCall = mockedFetch.mock.calls.find(c => c[0] === '/fleet/labels/fleet-stop');
    expect(stopCall).toBeTruthy();
    expect(JSON.parse(stopCall![1].body)).toEqual({ labelName: 'prod', dryRun: true });
  });
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
});

it('stop fleet opens the confirm modal, and confirming runs a real stop that renders per-node results', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/fleet-stop') {
      return Promise.resolve(jsonResponse(200, {
        results: [
          { nodeId: 1, nodeName: 'central', matched: true, stackResults: [{ stackName: 'web', success: true }] },
          { nodeId: 2, nodeName: 'edge-1', matched: false, stackResults: [] },
        ],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<LabelFleetStopCard nodes={nodes} />);
  await user.type(screen.getByPlaceholderText('e.g. production'), 'prod');
  await user.click(screen.getByRole('button', { name: 'Stop fleet' }));

  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText('Stop all stacks labeled "prod"?')).toBeInTheDocument();

  // The real stop must not have fired yet.
  expect(mockedFetch.mock.calls.find(c => c[0] === '/fleet/labels/fleet-stop')).toBeFalsy();

  await user.click(within(dialog).getByRole('button', { name: 'Stop fleet' }));

  await waitFor(() => {
    const stopCall = mockedFetch.mock.calls.find(c => c[0] === '/fleet/labels/fleet-stop');
    expect(JSON.parse(stopCall![1].body)).toEqual({ labelName: 'prod', dryRun: false });
  });
  expect(await screen.findByText('web')).toBeInTheDocument();
  await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
});

it('surfaces an error toast when fleet-stop returns a non-ok response', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/fleet-stop') {
      return Promise.resolve(jsonResponse(500, { error: 'boom' }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<LabelFleetStopCard nodes={nodes} />);
  await user.type(screen.getByPlaceholderText('e.g. production'), 'prod');
  await user.click(screen.getByRole('button', { name: 'Dry run' }));
  await waitFor(() => expect(toastError).toHaveBeenCalledWith('boom'));
});

it('populates the blast readout from the debounced match-preview', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') {
      return Promise.resolve(jsonResponse(200, { matchedNodes: 2, matchedStacks: 3, perNode: [] }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<LabelFleetStopCard nodes={nodes} />);
  await user.type(screen.getByPlaceholderText('e.g. production'), 'prod');
  await waitFor(() => expect(screen.getByText('3 stacks · 2 nodes')).toBeInTheDocument(), { timeout: 2000 });
});
