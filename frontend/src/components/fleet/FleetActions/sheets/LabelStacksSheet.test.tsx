/**
 * Coverage for the Label stacks sheet.
 *
 * Loads each node's stacks and labels when the sheet opens, derives label
 * templates from the fleet, gates Apply on a label-and-stack selection, sends a
 * name/color template plus per-node targets to the fleet orchestrator, and turns
 * the sheet into a per-node result (created vs reused) with no silent failure.
 */
import { it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), fetchForNode: vi.fn() }));
const can = vi.fn(() => true);
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ can }) }));

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
import { LabelStacksSheet } from './LabelStacksSheet';
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

function renderSheet(props: Partial<React.ComponentProps<typeof LabelStacksSheet>> = {}) {
  const onOpenChange = vi.fn();
  const view = render(<LabelStacksSheet open onOpenChange={onOpenChange} nodes={nodes} {...props} />);
  return { ...view, onOpenChange };
}

function assignBody() {
  const call = mockedApiFetch.mock.calls.find(c => c[0] === '/fleet/labels/bulk-assign');
  return call ? JSON.parse(call[1].body) : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  can.mockReturnValue(true);
  mockedFetchForNode.mockImplementation((path: string, nodeId: number) => defaultReads(path, nodeId));
  mockedApiFetch.mockResolvedValue(jsonResponse(200, { results: [] }));
});

it('does not read the fleet while closed', () => {
  renderSheet({ open: false });
  expect(mockedFetchForNode).not.toHaveBeenCalled();
});

it('loads stacks across nodes and gates Apply until a label and a stack are selected', async () => {
  const user = userEvent.setup();
  renderSheet();
  await screen.findByText('web');
  await screen.findByText('api');
  expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  expect(screen.getByText('Nothing selected')).toBeInTheDocument();

  await user.click(screen.getByText('prod'));
  expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();

  await user.click(screen.getByText('web'));
  expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
});

it('names what Apply will do before it runs, including where the label is created', async () => {
  const user = userEvent.setup();
  renderSheet();
  await screen.findByText('api');
  await user.click(screen.getByText('prod'));
  await user.click(screen.getByText('web'));
  await user.click(screen.getByText('api'));

  expect(screen.getByText('Adds “prod” to 2 stacks')).toBeInTheDocument();
  expect(screen.getByText('on 2 nodes · creates the label on 1 node')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Per-node detail' }));
  // The local node already has the label (reuse); the remote does not (create).
  expect(within(screen.getByText('central', { selector: 'span.text-\\[11px\\]' }).parentElement as HTMLElement).getByText('reuse')).toBeInTheDocument();
  expect(within(screen.getByText('edge', { selector: 'span.text-\\[11px\\]' }).parentElement as HTMLElement).getByText('create')).toBeInTheDocument();
});

it('applies in one click, sends the template plus per-node targets, and shows per-node results', async () => {
  const user = userEvent.setup();
  mockedApiFetch.mockResolvedValue(jsonResponse(200, {
    results: [
      { nodeId: 1, nodeName: 'central', reachable: true, created: false, stackResults: [{ stackName: 'web', success: true }] },
      { nodeId: 2, nodeName: 'edge', reachable: true, created: true, stackResults: [{ stackName: 'api', success: true }] },
    ],
  }));
  renderSheet();
  await screen.findByText('api');

  await user.click(screen.getByText('prod'));
  await user.click(screen.getByText('web'));
  await user.click(screen.getByText('api'));
  await user.click(screen.getByRole('button', { name: 'Apply' }));

  await waitFor(() => expect(assignBody()).toEqual({
    label: { name: 'prod', color: 'blue' },
    targets: [
      { nodeId: 1, stackNames: ['web'] },
      { nodeId: 2, stackNames: ['api'] },
    ],
  }));
  expect(await screen.findByText('Assigned “prod” to 2 stacks')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Per-node outcome' }));
  expect(screen.getByText(/label reused/)).toBeInTheDocument();
  expect(screen.getByText(/label created/)).toBeInTheDocument();
  expect(toastSuccess).toHaveBeenCalled();
});

it('prefers the local node color when the same label name has different colors across nodes', async () => {
  const user = userEvent.setup();
  // Two remotes carry teal and the local node blue: only the local preference yields blue.
  const threeNodes = [...nodes, { id: 3, name: 'edge-b', type: 'remote', status: 'online' }] as unknown as FleetNode[];
  mockedFetchForNode.mockImplementation((path: string, nodeId: number) => {
    if (path === '/labels' && (nodeId === 2 || nodeId === 3)) return Promise.resolve(jsonResponse(200, [{ id: 20 + nodeId, name: 'prod', color: 'teal' }]));
    if (path === '/fleet/node/3/stacks') return Promise.resolve(jsonResponse(200, []));
    return defaultReads(path, nodeId);
  });
  renderSheet({ nodes: threeNodes });
  await screen.findByText('web');

  await user.click(screen.getByText('prod'));
  expect(screen.getByText(/uses different colors on different nodes/)).toBeInTheDocument();
  await user.click(screen.getByText('web'));
  await user.click(screen.getByRole('button', { name: 'Apply' }));

  await waitFor(() => expect(assignBody()?.label.color).toBe('blue'));
});

it('marks a node unreachable when its reads fail', async () => {
  const threeNodes = [...nodes, { id: 3, name: 'offline', type: 'remote', status: 'offline' }] as unknown as FleetNode[];
  renderSheet({ nodes: threeNodes });
  await screen.findByText('web');
  await waitFor(() => expect(screen.getByText('unreachable')).toBeInTheDocument());
});

it('surfaces an error toast and keeps the selection when the orchestrator returns non-ok', async () => {
  const user = userEvent.setup();
  mockedApiFetch.mockResolvedValue(jsonResponse(500, { error: 'assign failed' }));
  renderSheet();
  await screen.findByText('web');

  await user.click(screen.getByText('prod'));
  await user.click(screen.getByText('web'));
  await user.click(screen.getByRole('button', { name: 'Apply' }));

  await waitFor(() => expect(toastError).toHaveBeenCalledWith('assign failed'));
  expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
});

it('warns and shows the unreachable node in the result when one node fails', async () => {
  const user = userEvent.setup();
  mockedApiFetch.mockResolvedValue(jsonResponse(200, {
    results: [
      { nodeId: 1, nodeName: 'central', reachable: true, created: true, stackResults: [{ stackName: 'web', success: true }] },
      { nodeId: 2, nodeName: 'edge', reachable: false, created: false, error: 'Node unreachable', stackResults: [{ stackName: 'api', success: false, error: 'Node unreachable' }] },
    ],
  }));
  renderSheet();
  await screen.findByText('api');

  await user.click(screen.getByText('prod'));
  await user.click(screen.getByText('web'));
  await user.click(screen.getByText('api'));
  await user.click(screen.getByRole('button', { name: 'Apply' }));

  expect(await screen.findByText('1 assigned')).toBeInTheDocument();
  expect(screen.getByText('1 failed · 1 node unreachable')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Per-node outcome' }));
  expect(screen.getByText(/\(unreachable\)/)).toBeInTheDocument();
  await waitFor(() => expect(toastWarning).toHaveBeenCalled());
});

it('rejects a malformed 200 instead of reporting a clean assign', async () => {
  const user = userEvent.setup();
  mockedApiFetch.mockResolvedValue(jsonResponse(200, {}));
  renderSheet();
  await screen.findByText('web');
  await user.click(screen.getByText('prod'));
  await user.click(screen.getByText('web'));
  await user.click(screen.getByRole('button', { name: 'Apply' }));

  await waitFor(() => expect(toastError).toHaveBeenCalledWith('Label stacks returned an unexpected response. Check the server logs and retry.'));
  expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
});

it('keeps Apply disabled when the session may not edit a selected stack', async () => {
  const user = userEvent.setup();
  can.mockImplementation(((_action: string, _type: string, stackName: string) => stackName !== 'api') as () => boolean);
  renderSheet();
  await screen.findByText('api');
  await user.click(screen.getByText('prod'));
  await user.click(screen.getByText('web'));
  expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  await user.click(screen.getByText('api'));
  expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
});

it('re-reads every node from Refresh and clears the selection', async () => {
  const user = userEvent.setup();
  renderSheet();
  await screen.findByText('web');
  await user.click(screen.getByText('prod'));
  await user.click(screen.getByText('web'));
  const readsBefore = mockedFetchForNode.mock.calls.length;
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(mockedFetchForNode.mock.calls.length).toBe(readsBefore * 2));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled());
});

it('does not offer the stacks of a node whose labels could not be read', async () => {
  mockedFetchForNode.mockImplementation((path: string, nodeId: number) => {
    if (path === '/labels' && nodeId === 2) return Promise.resolve(jsonResponse(500, { error: 'boom' }));
    return defaultReads(path, nodeId);
  });
  renderSheet();
  await screen.findByText('web');
  await waitFor(() => expect(screen.getByText('unreachable')).toBeInTheDocument());
  expect(screen.queryByText('api')).not.toBeInTheDocument();
});

it('treats a malformed stacks or labels body as an unreachable node instead of crashing', async () => {
  mockedFetchForNode.mockImplementation((path: string, nodeId: number) => {
    if (path === '/fleet/node/2/stacks') return Promise.resolve(jsonResponse(200, { stacks: ['api'] }));
    return defaultReads(path, nodeId);
  });
  renderSheet();
  await screen.findByText('web');
  await waitFor(() => expect(screen.getByText('unreachable')).toBeInTheDocument());
  expect(screen.queryByText('api')).not.toBeInTheDocument();
});

it('says why Apply is unavailable when the session may not edit a selected stack', async () => {
  const user = userEvent.setup();
  can.mockImplementation(((_action: string, _type: string, stackName: string) => stackName !== 'api') as () => boolean);
  renderSheet();
  await screen.findByText('api');
  await user.click(screen.getByText('prod'));
  await user.click(screen.getByText('api'));
  expect(screen.getByText('You do not have permission to edit every selected stack, so Apply is unavailable.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
});

it('reports a response with no stack results as an error, not a clean assign', async () => {
  const user = userEvent.setup();
  mockedApiFetch.mockResolvedValue(jsonResponse(200, {
    results: [{ nodeId: 1, nodeName: 'central', reachable: true, created: false, stackResults: [] }],
  }));
  renderSheet();
  await screen.findByText('web');
  await user.click(screen.getByText('prod'));
  await user.click(screen.getByText('web'));
  await user.click(screen.getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(toastError).toHaveBeenCalledWith('Label stacks returned no results. Check the server logs and retry.'));
  expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
});

it('keeps the result when the node roster changes after Apply', async () => {
  const user = userEvent.setup();
  mockedApiFetch.mockResolvedValue(jsonResponse(200, {
    results: [{ nodeId: 1, nodeName: 'central', reachable: true, created: false, stackResults: [{ stackName: 'web', success: true }] }],
  }));
  const view = renderSheet();
  await screen.findByText('web');
  await user.click(screen.getByText('prod'));
  await user.click(screen.getByText('web'));
  await user.click(screen.getByRole('button', { name: 'Apply' }));
  await screen.findByText('Assigned “prod” to 1 stack');

  const more = [...nodes, { id: 3, name: 'edge-b', type: 'remote', status: 'online' }] as unknown as FleetNode[];
  view.rerender(<LabelStacksSheet open onOpenChange={vi.fn()} nodes={more} />);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(screen.getByText('Assigned “prod” to 1 stack')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
});

it('keeps the selection while Apply runs, and cannot be dismissed until it finishes', async () => {
  const user = userEvent.setup();
  let finish: ((response: Response) => void) | null = null;
  mockedApiFetch.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
  const { onOpenChange, rerender } = renderSheet();
  await screen.findByText('web');
  await user.click(screen.getByText('prod'));
  await user.click(screen.getByText('web'));
  await user.click(screen.getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(finish).not.toBeNull());

  const more = [...nodes, { id: 3, name: 'edge-b', type: 'remote', status: 'online' }] as unknown as FleetNode[];
  rerender(<LabelStacksSheet open onOpenChange={onOpenChange} nodes={more} />);
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(screen.getByRole('checkbox', { name: 'web' })).toBeChecked();
  await user.keyboard('{Escape}');
  expect(onOpenChange).not.toHaveBeenCalledWith(false);

  await act(async () => {
    finish!(jsonResponse(200, {
      results: [{ nodeId: 1, nodeName: 'central', reachable: true, created: false, stackResults: [{ stackName: 'web', success: true }] }],
    }));
  });
  expect(await screen.findByText('Assigned “prod” to 1 stack')).toBeInTheDocument();
});

it('treats stack names or labels of the wrong type as an unreachable node', async () => {
  mockedFetchForNode.mockImplementation((path: string, nodeId: number) => {
    if (path === '/fleet/node/2/stacks') return Promise.resolve(jsonResponse(200, [1, 2]));
    return defaultReads(path, nodeId);
  });
  renderSheet();
  await screen.findByText('web');
  await waitFor(() => expect(screen.getByText('unreachable')).toBeInTheDocument());
});

it('reloads for a roster change that arrived while an assign was running and then failed', async () => {
  const user = userEvent.setup();
  let finish: ((response: Response) => void) | null = null;
  mockedApiFetch.mockImplementation(() => new Promise<Response>((resolve) => { finish = resolve; }));
  const { onOpenChange, rerender } = renderSheet();
  await screen.findByText('web');
  await user.click(screen.getByText('prod'));
  await user.click(screen.getByText('web'));
  await user.click(screen.getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(finish).not.toBeNull());

  const more = [...nodes, { id: 3, name: 'edge-b', type: 'remote', status: 'online' }] as unknown as FleetNode[];
  rerender(<LabelStacksSheet open onOpenChange={onOpenChange} nodes={more} />);
  const readsDuringRun = mockedFetchForNode.mock.calls.length;
  await act(async () => { finish!(jsonResponse(500, { error: 'assign failed' })); });
  await waitFor(() => expect(mockedFetchForNode.mock.calls.length).toBeGreaterThan(readsDuringRun));
  expect(mockedFetchForNode.mock.calls.some((call) => call[1] === 3)).toBe(true);
});

it('names the stack filter for assistive technology', async () => {
  renderSheet();
  await screen.findByText('web');
  expect(screen.getByRole('textbox', { name: 'Filter stacks' })).toBeInTheDocument();
});
