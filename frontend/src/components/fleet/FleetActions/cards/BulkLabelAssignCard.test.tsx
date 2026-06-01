/**
 * Coverage for BulkLabelAssignCard.
 *
 * Loads the node's stacks + labels, gates Apply on a stack-and-label selection,
 * confirms before applying, sends the assignment per-node, and surfaces a toast
 * on every outcome (no silent failure).
 */
import { it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({ fetchForNode: vi.fn() }));

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

import { fetchForNode } from '@/lib/api';
import { BulkLabelAssignCard } from './BulkLabelAssignCard';
import type { FleetNode } from '@/components/FleetView/types';

const mockedFetchForNode = fetchForNode as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const nodes = [{ id: 1, name: 'central', type: 'local', status: 'online' }] as unknown as FleetNode[];

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetchForNode.mockImplementation((path: string) => {
    if (path === '/fleet/node/1/stacks') return Promise.resolve(jsonResponse(200, ['web']));
    if (path === '/labels') return Promise.resolve(jsonResponse(200, [{ id: 10, name: 'prod', color: '#3b82f6' }]));
    return Promise.resolve(jsonResponse(200, { results: [] }));
  });
});

it('keeps Apply disabled until both a stack and a label are selected', async () => {
  const user = userEvent.setup();
  render(<BulkLabelAssignCard nodes={nodes} />);
  await screen.findByText('web');
  expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();

  await user.click(screen.getByRole('checkbox'));
  // Stack selected but no label yet.
  expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();

  await user.click(screen.getByText('prod'));
  expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
});

it('applies the assignment after confirmation and renders per-stack results', async () => {
  const user = userEvent.setup();
  mockedFetchForNode.mockImplementation((path: string) => {
    if (path === '/fleet/node/1/stacks') return Promise.resolve(jsonResponse(200, ['web']));
    if (path === '/labels') return Promise.resolve(jsonResponse(200, [{ id: 10, name: 'prod', color: '#3b82f6' }]));
    if (path === '/fleet-actions/labels/bulk-assign') return Promise.resolve(jsonResponse(200, { results: [{ stackName: 'web', success: true }] }));
    return Promise.resolve(jsonResponse(200, {}));
  });
  render(<BulkLabelAssignCard nodes={nodes} />);
  await screen.findByText('web');
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByText('prod'));
  await user.click(screen.getByRole('button', { name: 'Apply' }));

  const dialog = await screen.findByRole('alertdialog');
  await user.click(within(dialog).getByRole('button', { name: 'Apply' }));

  await waitFor(() => {
    const call = mockedFetchForNode.mock.calls.find(c => c[0] === '/fleet-actions/labels/bulk-assign');
    expect(call).toBeTruthy();
    expect(JSON.parse(call![2].body)).toEqual({ assignments: [{ stackName: 'web', labelIds: [10] }] });
  });
  await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
});

it('surfaces an error toast when the assignment returns non-ok', async () => {
  const user = userEvent.setup();
  mockedFetchForNode.mockImplementation((path: string) => {
    if (path === '/fleet/node/1/stacks') return Promise.resolve(jsonResponse(200, ['web']));
    if (path === '/labels') return Promise.resolve(jsonResponse(200, [{ id: 10, name: 'prod', color: '#3b82f6' }]));
    if (path === '/fleet-actions/labels/bulk-assign') return Promise.resolve(jsonResponse(500, { error: 'assign failed' }));
    return Promise.resolve(jsonResponse(200, {}));
  });
  render(<BulkLabelAssignCard nodes={nodes} />);
  await screen.findByText('web');
  await user.click(screen.getByRole('checkbox'));
  await user.click(screen.getByText('prod'));
  await user.click(screen.getByRole('button', { name: 'Apply' }));
  const dialog = await screen.findByRole('alertdialog');
  await user.click(within(dialog).getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(toastError).toHaveBeenCalledWith('assign failed'));
});
