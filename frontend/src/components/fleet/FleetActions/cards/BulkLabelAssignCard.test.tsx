/**
 * Coverage for the cross-node BulkLabelAssignCard.
 *
 * Loads each node's stacks + labels, derives label templates from the fleet,
 * gates Apply on a template-and-stack selection, sends a name/color template plus
 * per-node targets to the fleet orchestrator, and renders per-node results
 * (created vs reused) with no silent failure.
 */
import { it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), fetchForNode: vi.fn() }));

const toastError = vi.fn();
const toastSuccess = vi.fn();
const toastWarning = vi.fn();
vi.mock('@/components/ui/toast-store', () => ({
  toast: {
    error: (...a: unknown[]) => toastError(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
    warning: (...a: unknown[]) => toastWarning(...a),
    info: vi.fn(),
    loading: vi.fn(() => 'toast-id'),
    dismiss: vi.fn(),
  },
}));

import { apiFetch, fetchForNode } from '@/lib/api';
import { BulkLabelAssignCard } from './BulkLabelAssignCard';
import type { FleetNode } from '@/components/FleetView/types';

const mockedFetchForNode = fetchForNode as unknown as ReturnType<typeof vi.fn>;
const mockedApiFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const nodes = [
  { id: 1, name: 'central', type: 'local', status: 'online' },
  { id: 2, name: 'edge', type: 'remote', status: 'online' },
] as unknown as FleetNode[];

// Default fleet: node 1 (local) has stacks web/db and a `prod` label; node 2
// (remote) has stack api and no labels (so `prod` will be created there).
function defaultReads(path: string, nodeId: number): Promise<Response> {
  if (path === `/fleet/node/${nodeId}/stacks`) {
    if (nodeId === 1) return Promise.resolve(jsonResponse(200, ['web', 'db']));
    if (nodeId === 2) return Promise.resolve(jsonResponse(200, ['api']));
    return Promise.resolve(jsonResponse(503, { error: 'unreachable' }));
  }
  if (path === '/labels') {
    if (nodeId === 1) return Promise.resolve(jsonResponse(200, [{ id: 10, name: 'prod', color: 'blue' }]));
    if (nodeId === 2) return Promise.resolve(jsonResponse(200, []));
    return Promise.resolve(jsonResponse(503, { error: 'unreachable' }));
  }
  return Promise.resolve(jsonResponse(200, {}));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetchForNode.mockImplementation((path: string, nodeId: number) => defaultReads(path, nodeId));
  mockedApiFetch.mockResolvedValue(jsonResponse(200, { results: [] }));
});

it('loads stacks across nodes and gates Apply until a template and a stack are selected', async () => {
  const user = userEvent.setup();
  render(<BulkLabelAssignCard nodes={nodes} />);
  await screen.findByText('web');
  await screen.findByText('api');
  expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();

  await user.click(screen.getByText('prod'));
  // Template selected but no stack yet.
  expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();

  await user.click(screen.getByText('web'));
  expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
});

it('sends the label template plus per-node targets and renders per-node results', async () => {
  const user = userEvent.setup();
  mockedApiFetch.mockResolvedValue(jsonResponse(200, {
    results: [
      { nodeId: 1, nodeName: 'central', reachable: true, created: false, stackResults: [{ stackName: 'web', success: true }] },
      { nodeId: 2, nodeName: 'edge', reachable: true, created: true, stackResults: [{ stackName: 'api', success: true }] },
    ],
  }));
  render(<BulkLabelAssignCard nodes={nodes} />);
  await screen.findByText('api');

  await user.click(screen.getByText('prod'));
  await user.click(screen.getByText('web'));
  await user.click(screen.getByText('api'));
  await user.click(screen.getByRole('button', { name: 'Apply' }));

  const dialog = await screen.findByRole('alertdialog');
  await user.click(within(dialog).getByRole('button', { name: 'Apply' }));

  await waitFor(() => {
    const call = mockedApiFetch.mock.calls.find(c => c[0] === '/fleet/labels/bulk-assign');
    expect(call).toBeTruthy();
    expect(JSON.parse(call![1].body)).toEqual({
      label: { name: 'prod', color: 'blue' },
      targets: [
        { nodeId: 1, stackNames: ['web'] },
        { nodeId: 2, stackNames: ['api'] },
      ],
    });
  });
  await screen.findByText(/label reused/);
  await screen.findByText(/label created/);
  await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
});

it('prefers the local node color when the same label name has different colors across nodes', async () => {
  const user = userEvent.setup();
  mockedFetchForNode.mockImplementation((path: string, nodeId: number) => {
    if (path === '/labels' && nodeId === 2) return Promise.resolve(jsonResponse(200, [{ id: 20, name: 'prod', color: 'teal' }]));
    return defaultReads(path, nodeId);
  });
  render(<BulkLabelAssignCard nodes={nodes} />);
  await screen.findByText('web');

  await user.click(screen.getByText('prod'));
  await user.click(screen.getByText('web'));
  await user.click(screen.getByRole('button', { name: 'Apply' }));
  const dialog = await screen.findByRole('alertdialog');
  await user.click(within(dialog).getByRole('button', { name: 'Apply' }));

  await waitFor(() => {
    const call = mockedApiFetch.mock.calls.find(c => c[0] === '/fleet/labels/bulk-assign');
    expect(call).toBeTruthy();
    expect(JSON.parse(call![1].body).label.color).toBe('blue');
  });
});

it('marks a node unreachable when its reads fail', async () => {
  const threeNodes = [
    ...nodes,
    { id: 3, name: 'offline', type: 'remote', status: 'offline' },
  ] as unknown as FleetNode[];
  render(<BulkLabelAssignCard nodes={threeNodes} />);
  await screen.findByText('web');
  await waitFor(() => expect(screen.getByText('unreachable')).toBeInTheDocument());
});

it('surfaces an error toast when the orchestrator returns non-ok', async () => {
  const user = userEvent.setup();
  mockedApiFetch.mockResolvedValue(jsonResponse(500, { error: 'assign failed' }));
  render(<BulkLabelAssignCard nodes={nodes} />);
  await screen.findByText('web');

  await user.click(screen.getByText('prod'));
  await user.click(screen.getByText('web'));
  await user.click(screen.getByRole('button', { name: 'Apply' }));
  const dialog = await screen.findByRole('alertdialog');
  await user.click(within(dialog).getByRole('button', { name: 'Apply' }));

  await waitFor(() => expect(toastError).toHaveBeenCalledWith('assign failed'));
});

it('warns and renders an unreachable row when one node fails', async () => {
  const user = userEvent.setup();
  mockedApiFetch.mockResolvedValue(jsonResponse(200, {
    results: [
      { nodeId: 1, nodeName: 'central', reachable: true, created: true, stackResults: [{ stackName: 'web', success: true }] },
      { nodeId: 2, nodeName: 'edge', reachable: false, created: false, error: 'Node unreachable', stackResults: [{ stackName: 'api', success: false, error: 'Node unreachable' }] },
    ],
  }));
  render(<BulkLabelAssignCard nodes={nodes} />);
  await screen.findByText('api');

  await user.click(screen.getByText('prod'));
  await user.click(screen.getByText('web'));
  await user.click(screen.getByText('api'));
  await user.click(screen.getByRole('button', { name: 'Apply' }));
  const dialog = await screen.findByRole('alertdialog');
  await user.click(within(dialog).getByRole('button', { name: 'Apply' }));

  await screen.findByText(/\(unreachable\)/);
  await waitFor(() => expect(toastWarning).toHaveBeenCalled());
});
