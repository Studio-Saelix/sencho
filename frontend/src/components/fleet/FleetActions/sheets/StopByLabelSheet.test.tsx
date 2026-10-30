/**
 * Coverage for the Stop stacks by label sheet.
 *
 * Locks the destructive-action contract: Stop is gated on a resolved blast
 * radius, runs exactly the node/stack list the operator saw, the sheet turns into
 * the per-node result, and every failure path surfaces a toast (no silent failure).
 *
 * Also locks the stack-label scope: suggestions come from the fleet stack-label
 * endpoint (never node labels), a node-only name produces a clear zero-stack
 * answer, and a non-ok suggestions response is non-fatal.
 */
import { it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  fetchForNode: vi.fn(),
}));
const can = vi.fn(() => true);
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ can }) }));

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
import { StopByLabelSheet } from './StopByLabelSheet';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedFetchForNode = fetchForNode as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const PLACEHOLDER = 'e.g. production';
const WAIT = { timeout: 2000 };

function renderSheet(open = true) {
  const onOpenChange = vi.fn();
  const view = render(<StopByLabelSheet open={open} onOpenChange={onOpenChange} />);
  return { ...view, onOpenChange };
}

function previewOf(perNode: unknown[], counts: { nodes: number; stacks: number; unreachable?: number }) {
  return jsonResponse(200, {
    matchedNodes: counts.nodes, matchedStacks: counts.stacks, unreachableNodes: counts.unreachable ?? 0, perNode,
  });
}

const centralWeb = { nodeId: 1, nodeName: 'central', reachable: true, labelExists: true, stackCount: 1, stackNames: ['web'] };

beforeEach(() => {
  vi.clearAllMocks();
  can.mockReturnValue(true);
  // Default: every endpoint 404s so the suggestions load lands empty and the
  // debounced preview degrades to unavailable. Tests override per URL.
  mockedFetch.mockResolvedValue(jsonResponse(404, {}));
});

it('does not touch the network while closed', () => {
  renderSheet(false);
  expect(mockedFetch).not.toHaveBeenCalled();
});

it('keeps Stop disabled until a label name resolves to something to stop', async () => {
  const user = userEvent.setup();
  renderSheet();
  expect(screen.getByRole('button', { name: 'Stop stacks' })).toBeDisabled();
  expect(screen.getByText('No label yet')).toBeInTheDocument();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  // The default mocks 404 the match-preview, so nothing is resolved yet.
  expect(screen.getByRole('button', { name: 'Stop stacks' })).toBeDisabled();
});

it('labels the target as a stack label and explains node labels are excluded', () => {
  renderSheet();
  expect(screen.getByText('Stack label')).toBeInTheDocument();
  expect(screen.getByText(/Node labels are not used by this action/i)).toBeInTheDocument();
});

it('sources suggestions from the fleet stack-label endpoint, not from node labels', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/suggestions') {
      return Promise.resolve(jsonResponse(200, {
        suggestions: [
          { name: 'production', scope: 'stack', nodeCount: 2, stackCount: 3 },
          { name: 'monitoring', scope: 'stack', nodeCount: 1, stackCount: 1 },
        ],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();

  await user.click(screen.getByPlaceholderText(PLACEHOLDER));
  expect(await screen.findByText('production')).toBeInTheDocument();
  expect(screen.getByText('3 stacks · 2 nodes')).toBeInTheDocument();
  expect(screen.getByText('1 stack · 1 node')).toBeInTheDocument();
  expect(screen.queryByText('edge')).not.toBeInTheDocument();
  expect(mockedFetchForNode).not.toHaveBeenCalled();
});

it('drops malformed suggestion entries that fail the stack-label shape guard', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/suggestions') {
      return Promise.resolve(jsonResponse(200, {
        suggestions: [{ name: 'missing-scope' }, 'garbage', { name: 'valid', scope: 'stack', nodeCount: 1, stackCount: 1 }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.click(screen.getByPlaceholderText(PLACEHOLDER));
  expect(await screen.findByText('valid')).toBeInTheDocument();
  expect(screen.queryByText('missing-scope')).not.toBeInTheDocument();
});

it('populates the input when a suggestion is selected', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/suggestions') {
      return Promise.resolve(jsonResponse(200, { suggestions: [{ name: 'production', scope: 'stack', nodeCount: 2, stackCount: 3 }] }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  const input = screen.getByPlaceholderText(PLACEHOLDER) as HTMLInputElement;
  await user.click(input);
  await user.click(await screen.findByRole('button', { name: /production/ }));
  expect(input.value).toBe('production');
});

it('shows a zero-stack answer when a node-only name is typed', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') return Promise.resolve(previewOf([], { nodes: 0, stacks: 0 }));
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'edge');
  expect(await screen.findByText('No stacks match', undefined, WAIT)).toBeInTheDocument();
  expect(screen.getByText('No reachable node carries a stack label by that name.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Stop stacks' })).toBeDisabled();
});

it('keeps the sheet usable when the suggestions endpoint returns 403', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/suggestions') return Promise.resolve(jsonResponse(403, { error: 'Admin required' }));
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  expect(screen.getByPlaceholderText(PLACEHOLDER)).toHaveValue('prod');
});

it('names what Stop will do from the live preview, then runs a real stop bound to that list', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') return Promise.resolve(previewOf([centralWeb], { nodes: 1, stacks: 1 }));
    if (url === '/fleet/labels/fleet-stop') {
      return Promise.resolve(jsonResponse(200, {
        results: [
          { nodeId: 1, nodeName: 'central', reachable: true, matched: true, stackResults: [{ stackName: 'web', success: true }] },
          { nodeId: 2, nodeName: 'edge-1', reachable: true, matched: false, stackResults: [] },
        ],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');

  const stopBtn = screen.getByRole('button', { name: 'Stop stacks' });
  await waitFor(() => expect(stopBtn).toBeEnabled(), WAIT);
  expect(screen.getByText('Stops 1 stack')).toBeInTheDocument();
  expect(screen.getByText('on 1 node · web')).toBeInTheDocument();
  // Nothing has run: only the preview hit the network.
  expect(mockedFetch.mock.calls.find(c => c[0] === '/fleet/labels/fleet-stop')).toBeFalsy();

  await user.click(stopBtn);
  await waitFor(() => {
    const stopCall = mockedFetch.mock.calls.find(c => c[0] === '/fleet/labels/fleet-stop');
    // The real stop binds execution to the exact node + stack list resolved in
    // the preview, so neither a reconnecting node nor a newly labelled stack can
    // be added later.
    expect(JSON.parse(stopCall![1].body)).toEqual({ labelName: 'prod', dryRun: false, targets: [{ nodeId: 1, stackNames: ['web'] }] });
  });
  expect(await screen.findByText('Stopped 1 stack')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled();
  expect(screen.queryByRole('button', { name: 'Stop stacks' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Per-node outcome' }));
  expect(screen.getByText('central · 1 stack')).toBeInTheDocument();
  await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
});

it('lists every node and stack behind the answer and sums them across nodes', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') {
      return Promise.resolve(previewOf([
        centralWeb,
        { nodeId: 2, nodeName: 'edge-1', reachable: true, labelExists: true, stackCount: 2, stackNames: ['api', 'db'] },
      ], { nodes: 2, stacks: 3 }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  expect(await screen.findByText('Stops 3 stacks', undefined, WAIT)).toBeInTheDocument();
  expect(screen.getByText('on 2 nodes · web, api, db')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Stacks per node' }));
  expect(screen.getByText('central')).toBeInTheDocument();
  expect(screen.getByText('edge-1')).toBeInTheDocument();
  expect(screen.getByText('api, db')).toBeInTheDocument();
});

it('truncates the example stacks in the answer and counts the rest', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') {
      return Promise.resolve(previewOf([
        { nodeId: 1, nodeName: 'central', reachable: true, labelExists: true, stackCount: 5, stackNames: ['a', 'b', 'c', 'd', 'e'] },
      ], { nodes: 1, stacks: 5 }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  expect(await screen.findByText('on 1 node · a, b, c +2 more', undefined, WAIT)).toBeInTheDocument();
});

it('surfaces an error toast when fleet-stop returns a non-ok response and keeps Stop available', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') return Promise.resolve(previewOf([centralWeb], { nodes: 1, stacks: 1 }));
    if (url === '/fleet/labels/fleet-stop') return Promise.resolve(jsonResponse(500, { error: 'boom' }));
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  const stopBtn = screen.getByRole('button', { name: 'Stop stacks' });
  await waitFor(() => expect(stopBtn).toBeEnabled(), WAIT);
  await user.click(stopBtn);
  await waitFor(() => expect(toastError).toHaveBeenCalledWith('boom'));
  expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Stop stacks' })).toBeEnabled();
});

it('degrades to "preview unavailable" when match-preview returns a malformed 200 body', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    // 200 but perNode is missing: the render path must degrade, not throw.
    if (url === '/fleet/labels/match-preview') return Promise.resolve(jsonResponse(200, { matchedStacks: 1, matchedNodes: 1 }));
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  expect(await screen.findByText('Preview unavailable', undefined, WAIT)).toBeInTheDocument();
  // The destructive Stop stays gated; the dry run is the escape hatch that can
  // still resolve the blast radius.
  expect(screen.getByRole('button', { name: 'Resolve with dry run' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Stop stacks' })).toBeDisabled();
});

it('lets a successful dry run unblock Stop when the match-preview endpoint is unavailable', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/fleet-stop') {
      return Promise.resolve(jsonResponse(200, {
        results: [{ nodeId: 1, nodeName: 'central', reachable: true, matched: true, stackResults: [{ stackName: 'web', success: true, dryRun: true }] }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  const stopBtn = screen.getByRole('button', { name: 'Stop stacks' });
  expect(stopBtn).toBeDisabled();

  await user.click(await screen.findByRole('button', { name: 'Resolve with dry run' }, WAIT));
  await waitFor(() => {
    const call = mockedFetch.mock.calls.find(c => c[0] === '/fleet/labels/fleet-stop');
    expect(JSON.parse(call![1].body)).toEqual({ labelName: 'prod', dryRun: true });
  });
  await waitFor(() => expect(stopBtn).toBeEnabled());
  expect(screen.getByText('Stops 1 stack')).toBeInTheDocument();
  // A dry run only resolves the blast radius: the sheet is not a result yet.
  expect(screen.queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
});

it('invalidates a dry-run snapshot when the label is edited, even back to the same name', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/fleet-stop') {
      return Promise.resolve(jsonResponse(200, {
        results: [{ nodeId: 1, nodeName: 'central', reachable: true, matched: true, stackResults: [{ stackName: 'web', success: true, dryRun: true }] }],
      }));
    }
    // match-preview stays unavailable, so only the dry-run snapshot can resolve.
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  const input = screen.getByPlaceholderText(PLACEHOLDER);
  await user.type(input, 'prod');
  const stopBtn = screen.getByRole('button', { name: 'Stop stacks' });

  await user.click(await screen.findByRole('button', { name: 'Resolve with dry run' }, WAIT));
  await waitFor(() => expect(stopBtn).toBeEnabled());
  await user.clear(input);
  await user.type(input, 'prod');

  // The stale snapshot must not re-enable Stop; a fresh dry run/preview is required.
  await waitFor(() => expect(stopBtn).toBeDisabled());
});

it('ignores a stale in-flight preview response that resolves after the label changed', async () => {
  const user = userEvent.setup();
  let resolveProd: ((r: Response) => void) | null = null;
  mockedFetch.mockImplementation((url: string, init?: { body?: string }) => {
    if (url === '/fleet/labels/match-preview') {
      const label = JSON.parse(init?.body ?? '{}').labelName;
      // Hold the prod preview open so it resolves AFTER the label changes.
      if (label === 'prod') return new Promise<Response>((resolve) => { resolveProd = resolve; });
      if (label === 'qa') return Promise.resolve(previewOf([], { nodes: 0, stacks: 0 }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  const input = screen.getByPlaceholderText(PLACEHOLDER);

  await user.type(input, 'prod');
  await waitFor(() => expect(resolveProd).not.toBeNull(), WAIT);

  await user.clear(input);
  await user.type(input, 'qa');
  expect(await screen.findByText('No stacks match', undefined, WAIT)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Stop stacks' })).toBeDisabled();

  // The stale prod preview now resolves with a matching stack. It must not gate
  // Stop for qa, nor leak prod's targets into the answer.
  await act(async () => {
    resolveProd!(previewOf([centralWeb], { nodes: 1, stacks: 1 }));
    await new Promise(r => setTimeout(r, 0));
  });
  expect(screen.getByRole('button', { name: 'Stop stacks' })).toBeDisabled();
  expect(screen.getByText('No stacks match')).toBeInTheDocument();
  expect(screen.queryByText('Stops 1 stack')).not.toBeInTheDocument();
});

it('does not crash when fleet-stop returns a malformed 200 body', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    // results is not an array: must degrade to a toast, not throw.
    if (url === '/fleet/labels/fleet-stop') return Promise.resolve(jsonResponse(200, { results: 'nope' }));
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  await user.click(await screen.findByRole('button', { name: 'Resolve with dry run' }, WAIT));
  // Reported as an unexpected response, not masqueraded as "No reachable nodes".
  await waitFor(() => expect(toastError).toHaveBeenCalledWith('Stop stacks returned an unexpected response. Check the server logs and retry.'));
  expect(toastWarning).not.toHaveBeenCalled();
  expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
});

it('shows remote labels with their node spread and flags partial coverage', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/suggestions') {
      return Promise.resolve(jsonResponse(200, {
        suggestions: [{ name: 'media', scope: 'stack', nodeCount: 2, stackCount: 3, nodes: ['central', 'edge-1'] }],
        unreachableNodes: 1,
        partial: true,
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  expect(await screen.findByText(/1 node unreachable; suggestions may be incomplete/i)).toBeInTheDocument();
  await user.click(screen.getByPlaceholderText(PLACEHOLDER));
  expect(await screen.findByText('media')).toBeInTheDocument();
  expect(screen.getByText('central, edge-1')).toBeInTheDocument();
});

it('marks unreachable nodes on the answer without dropping the matched ones', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') {
      return Promise.resolve(previewOf([
        centralWeb,
        { nodeId: 2, nodeName: 'edge-1', reachable: false, labelExists: false, stackCount: 0, stackNames: [], error: 'Remote node not configured' },
      ], { nodes: 1, stacks: 1, unreachable: 1 }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'media');
  expect(await screen.findByText('Stops 1 stack', undefined, WAIT)).toBeInTheDocument();
  expect(screen.getByText('1 unreachable, left out')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Stacks per node' }));
  expect(screen.getByText('unreachable · 1')).toBeInTheDocument();
  expect(screen.getByText('edge-1')).toBeInTheDocument();
  expect(screen.getByText('Remote node not configured')).toBeInTheDocument();
});

it('distinguishes "label exists, no stacks" and still names the unreachable node', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') {
      return Promise.resolve(previewOf([
        { nodeId: 1, nodeName: 'central', reachable: true, labelExists: true, stackCount: 0, stackNames: [] },
        { nodeId: 2, nodeName: 'edge-1', reachable: false, labelExists: false, stackCount: 0, stackNames: [], error: 'Remote node not configured' },
      ], { nodes: 0, stacks: 0, unreachable: 1 }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'media');
  expect(await screen.findByText('This stack label exists but has no stacks assigned on the reachable nodes.', undefined, WAIT)).toBeInTheDocument();
  expect(screen.getByText('1 unreachable, left out')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Unreachable nodes' }));
  expect(screen.getByText('unreachable · 1')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Stop stacks' })).toBeDisabled();
});

it('reports a confirmed node that vanished as a failure, not a clean success', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') return Promise.resolve(previewOf([centralWeb], { nodes: 1, stacks: 1 }));
    if (url === '/fleet/labels/fleet-stop') {
      // One stopped node plus a confirmed node that disappeared from the
      // registry: the backend returns its confirmed stacks as failures.
      return Promise.resolve(jsonResponse(200, {
        results: [
          { nodeId: 1, nodeName: 'central', reachable: true, matched: true, stackResults: [{ stackName: 'web', success: true }] },
          { nodeId: 2, nodeName: 'Node 2', reachable: false, matched: false, error: 'Node no longer exists', stackResults: [{ stackName: 'api', success: false, error: 'Node no longer exists' }] },
        ],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  const stopBtn = screen.getByRole('button', { name: 'Stop stacks' });
  await waitFor(() => expect(stopBtn).toBeEnabled(), WAIT);
  await user.click(stopBtn);

  // The vanished confirmed node flips the outcome to a warning, so a partial
  // stop never reads as a clean success.
  expect(await screen.findByText('1 stopped, 1 failed')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Per-node outcome' }));
  expect(screen.getByText(/Node 2 \(unreachable\)/)).toBeInTheDocument();
  await waitFor(() => expect(toastWarning).toHaveBeenCalled());
  expect(toastSuccess).not.toHaveBeenCalled();
});

it('warns when a confirmed node lost the label instead of reporting a no-match', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') return Promise.resolve(previewOf([centralWeb], { nodes: 1, stacks: 1 }));
    if (url === '/fleet/labels/fleet-stop') {
      // The label vanished on the node between preview and stop, so the
      // backend reports the confirmed stack as a failure with matched false.
      return Promise.resolve(jsonResponse(200, {
        results: [{
          nodeId: 1, nodeName: 'central', reachable: true, matched: false,
          stackResults: [{ stackName: 'web', success: false, error: 'No longer carries this label' }],
        }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  const stopBtn = screen.getByRole('button', { name: 'Stop stacks' });
  await waitFor(() => expect(stopBtn).toBeEnabled(), WAIT);
  await user.click(stopBtn);

  expect(await screen.findByText('0 stopped, 1 failed')).toBeInTheDocument();
  expect(screen.getByTestId('status-answer')).toHaveAttribute('data-tone', 'warning');
  await waitFor(() => expect(toastWarning).toHaveBeenCalledWith('0 stopped, 1 failed. See the result.'));
  expect(toastInfo).not.toHaveBeenCalledWith(expect.stringContaining('No reachable node carries'));
});

it('keeps a node left out of the plan on the stop result and toast', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') {
      return Promise.resolve(previewOf([
        centralWeb,
        { nodeId: 2, nodeName: 'edge-1', reachable: false, labelExists: false, stackCount: 0, stackNames: [], error: 'Pilot tunnel is disconnected' },
      ], { nodes: 1, stacks: 1, unreachable: 1 }));
    }
    if (url === '/fleet/labels/fleet-stop') {
      // The real stop sends targets only for reachable nodes, so the response
      // never mentions the node the plan left out.
      return Promise.resolve(jsonResponse(200, {
        results: [{ nodeId: 1, nodeName: 'central', reachable: true, matched: true, stackResults: [{ stackName: 'web', success: true }] }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  const stopBtn = screen.getByRole('button', { name: 'Stop stacks' });
  await waitFor(() => expect(stopBtn).toBeEnabled(), WAIT);
  await user.click(stopBtn);
  await waitFor(() => {
    const stopCall = mockedFetch.mock.calls
      .filter(c => c[0] === '/fleet/labels/fleet-stop')
      .map(c => JSON.parse(c[1].body))
      .find(b => !b.dryRun);
    // A left-out node must never receive a target, or the stop could widen to
    // it after it reconnects.
    expect(stopCall.targets).toEqual([{ nodeId: 1, stackNames: ['web'] }]);
  });

  // The stacks on the reachable node stopped, but the unreachable node keeps
  // the label's stack running: the result is a warning, not a clean success.
  expect(await screen.findByText('Stopped 1 stack')).toBeInTheDocument();
  expect(screen.getByTestId('status-answer')).toHaveAttribute('data-tone', 'warning');
  expect(screen.getByTestId('status-marker')).toHaveTextContent('1 node unreachable, left out');
  await user.click(screen.getByRole('button', { name: 'Per-node outcome' }));
  expect(screen.getByText('edge-1 (unreachable, left out)')).toBeInTheDocument();
  expect(screen.getByText(/Pilot tunnel is disconnected/)).toBeInTheDocument();
  await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(
    'Stopped 1 stack across 1 node. 1 node unreachable, left out.',
  ));
  expect(toastSuccess).not.toHaveBeenCalled();
});

it('warns when a planned node becomes unreachable at execution and nothing else failed', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') {
      return Promise.resolve(previewOf([
        centralWeb,
        { nodeId: 2, nodeName: 'edge-1', reachable: true, labelExists: true, stackCount: 1, stackNames: ['api'] },
      ], { nodes: 2, stacks: 2 }));
    }
    if (url === '/fleet/labels/fleet-stop') {
      // edge-1 dropped after the plan resolved; the stop attempted it and got
      // no stack results back, while central stopped cleanly.
      return Promise.resolve(jsonResponse(200, {
        results: [
          { nodeId: 1, nodeName: 'central', reachable: true, matched: true, stackResults: [{ stackName: 'web', success: true }] },
          { nodeId: 2, nodeName: 'edge-1', reachable: false, matched: false, stackResults: [], error: 'Pilot tunnel is disconnected' },
        ],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  const stopBtn = screen.getByRole('button', { name: 'Stop stacks' });
  await waitFor(() => expect(stopBtn).toBeEnabled(), WAIT);
  await user.click(stopBtn);

  expect(await screen.findByText('Stopped 1 stack')).toBeInTheDocument();
  expect(screen.getByTestId('status-answer')).toHaveAttribute('data-tone', 'warning');
  expect(screen.getByTestId('status-marker')).toHaveTextContent('1 node unreachable');
  await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(
    'Stopped 1 stack across 1 node. 1 node unreachable.',
  ));
  expect(toastSuccess).not.toHaveBeenCalled();
});

it('carries a dry-run snapshot\'s left-out node into the real stop result', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string, init?: { body?: string }) => {
    if (url === '/fleet/labels/fleet-stop') {
      const body = JSON.parse(init?.body ?? '{}');
      if (body.dryRun) {
        return Promise.resolve(jsonResponse(200, {
          results: [
            { nodeId: 1, nodeName: 'central', reachable: true, matched: true, stackResults: [{ stackName: 'web', success: true, dryRun: true }] },
            { nodeId: 2, nodeName: 'edge-1', reachable: false, matched: false, stackResults: [], error: 'Pilot tunnel is disconnected' },
          ],
        }));
      }
      return Promise.resolve(jsonResponse(200, {
        results: [{ nodeId: 1, nodeName: 'central', reachable: true, matched: true, stackResults: [{ stackName: 'web', success: true }] }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  await user.click(await screen.findByRole('button', { name: 'Resolve with dry run' }, WAIT));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Stop stacks' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Stop stacks' }));

  expect(await screen.findByText('Stopped 1 stack')).toBeInTheDocument();
  expect(screen.getByTestId('status-answer')).toHaveAttribute('data-tone', 'warning');
  expect(screen.getByTestId('status-marker')).toHaveTextContent('1 node unreachable, left out');
  await user.click(screen.getByRole('button', { name: 'Per-node outcome' }));
  expect(screen.getByText('edge-1 (unreachable, left out)')).toBeInTheDocument();
  await waitFor(() => {
    const stopCall = mockedFetch.mock.calls
      .filter(c => c[0] === '/fleet/labels/fleet-stop')
      .map(c => JSON.parse(c[1].body))
      .find(b => !b.dryRun);
    expect(stopCall.targets).toEqual([{ nodeId: 1, stackNames: ['web'] }]);
  });
});

it('marks a left-out node alongside stacks that failed at execution', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') {
      return Promise.resolve(previewOf([
        centralWeb,
        { nodeId: 2, nodeName: 'edge-1', reachable: false, labelExists: false, stackCount: 0, stackNames: [], error: 'Pilot tunnel is disconnected' },
      ], { nodes: 1, stacks: 1, unreachable: 1 }));
    }
    if (url === '/fleet/labels/fleet-stop') {
      return Promise.resolve(jsonResponse(200, {
        results: [{ nodeId: 1, nodeName: 'central', reachable: true, matched: true, stackResults: [{ stackName: 'web', success: false, error: 'busy' }] }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  const stopBtn = screen.getByRole('button', { name: 'Stop stacks' });
  await waitFor(() => expect(stopBtn).toBeEnabled(), WAIT);
  await user.click(stopBtn);

  // A failure on a reachable node must not push the left-out node out of the answer.
  expect(await screen.findByText('0 stopped, 1 failed')).toBeInTheDocument();
  expect(screen.getByTestId('status-answer')).toHaveAttribute('data-tone', 'warning');
  expect(screen.getByTestId('status-marker')).toHaveTextContent('1 node unreachable, left out');
  await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(
    '0 stopped, 1 failed. See the result. 1 node unreachable, left out.',
  ));
});

it('carries stacks the dry run could not resolve into the real stop result', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string, init?: { body?: string }) => {
    if (url === '/fleet/labels/fleet-stop') {
      const body = JSON.parse(init?.body ?? '{}');
      if (body.dryRun) {
        return Promise.resolve(jsonResponse(200, {
          results: [{
            nodeId: 1, nodeName: 'central', reachable: true, matched: true,
            stackResults: [{ stackName: 'web', success: true, dryRun: true }, { stackName: 'db', success: false, error: 'dry run failed' }],
          }],
        }));
      }
      return Promise.resolve(jsonResponse(200, {
        results: [{ nodeId: 1, nodeName: 'central', reachable: true, matched: true, stackResults: [{ stackName: 'web', success: true }] }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  await user.click(await screen.findByRole('button', { name: 'Resolve with dry run' }, WAIT));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Stop stacks' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Stop stacks' }));

  // `db` failed to resolve and was never sent; the result must not read clean.
  expect(await screen.findByText('Stopped 1 stack')).toBeInTheDocument();
  expect(screen.getByTestId('status-answer')).toHaveAttribute('data-tone', 'warning');
  expect(screen.getByTestId('status-marker')).toHaveTextContent('1 stack could not be resolved');
  await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(
    'Stopped 1 stack across 1 node. 1 stack could not be resolved.',
  ));
  expect(toastSuccess).not.toHaveBeenCalled();
});

it('keeps Stop disabled when the session may not stop a resolved stack', async () => {
  const user = userEvent.setup();
  can.mockReturnValue(false);
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') return Promise.resolve(previewOf([centralWeb], { nodes: 1, stacks: 1 }));
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  expect(await screen.findByText('Stops 1 stack', undefined, WAIT)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Stop stacks' })).toBeDisabled();
});

const suggestionsRoute = (url: string) => url === '/fleet/labels/suggestions'
  ? Promise.resolve(jsonResponse(200, { suggestions: [{ name: 'production', scope: 'stack', nodeCount: 1, stackCount: 1 }] }))
  : null;

it('closes the suggestions on Escape without closing the sheet', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => suggestionsRoute(url) ?? Promise.resolve(jsonResponse(404, {})));
  const { onOpenChange } = renderSheet();
  await user.click(screen.getByPlaceholderText(PLACEHOLDER));
  expect(await screen.findByRole('button', { name: /production/ })).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('button', { name: /production/ })).not.toBeInTheDocument();
  expect(onOpenChange).not.toHaveBeenCalledWith(false);
  // With the suggestions closed, the next Escape closes the sheet as usual.
  await user.keyboard('{Escape}');
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it('closes the suggestions when the input loses focus', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => suggestionsRoute(url) ?? Promise.resolve(jsonResponse(404, {})));
  renderSheet();
  await user.click(screen.getByPlaceholderText(PLACEHOLDER));
  expect(await screen.findByRole('button', { name: /production/ })).toBeInTheDocument();
  await user.tab();
  expect(screen.queryByRole('button', { name: /production/ })).not.toBeInTheDocument();
});

it('resolves a typed label with one preview request, not one per keystroke', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') return Promise.resolve(previewOf([centralWeb], { nodes: 1, stacks: 1 }));
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  await screen.findByText('Stops 1 stack', undefined, WAIT);
  const previews = mockedFetch.mock.calls.filter(c => c[0] === '/fleet/labels/match-preview');
  expect(previews).toHaveLength(1);
  expect(JSON.parse(previews[0][1].body)).toEqual({ labelName: 'prod' });
});

it('says why Stop is unavailable when the session may not stop a resolved stack', async () => {
  const user = userEvent.setup();
  can.mockReturnValue(false);
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') return Promise.resolve(previewOf([centralWeb], { nodes: 1, stacks: 1 }));
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  expect(await screen.findByText('You do not have permission to stop every stack listed, so Stop is unavailable.', undefined, WAIT)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Stop stacks' })).toBeDisabled();
});

it('does not report a stop that only hit unreachable nodes as "no stack carried the label"', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') return Promise.resolve(previewOf([centralWeb], { nodes: 1, stacks: 1 }));
    if (url === '/fleet/labels/fleet-stop') {
      return Promise.resolve(jsonResponse(200, {
        results: [{ nodeId: 1, nodeName: 'central', reachable: false, matched: false, stackResults: [], error: 'Pilot tunnel is disconnected' }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  const stopBtn = screen.getByRole('button', { name: 'Stop stacks' });
  await waitFor(() => expect(stopBtn).toBeEnabled(), WAIT);
  await user.click(stopBtn);
  expect(await screen.findByText('Nothing was stopped')).toBeInTheDocument();
  expect(screen.getByText('1 node unreachable, so the stacks there were not stopped.')).toBeInTheDocument();
  expect(screen.getByTestId('status-marker')).toHaveTextContent('1 node unreachable');
  expect(screen.queryByText(/No stack carried/)).not.toBeInTheDocument();
});

it('keeps the left-out marker when nothing stopped because the plan excluded the node', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') {
      return Promise.resolve(previewOf([
        centralWeb,
        { nodeId: 2, nodeName: 'edge-1', reachable: false, labelExists: false, stackCount: 0, stackNames: [], error: 'Pilot tunnel is disconnected' },
      ], { nodes: 1, stacks: 1, unreachable: 1 }));
    }
    if (url === '/fleet/labels/fleet-stop') {
      // The reachable node reports the label with no stack results, so nothing
      // stopped; the plan's left-out node must still be marked.
      return Promise.resolve(jsonResponse(200, {
        results: [{ nodeId: 1, nodeName: 'central', reachable: true, matched: true, stackResults: [] }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  const stopBtn = screen.getByRole('button', { name: 'Stop stacks' });
  await waitFor(() => expect(stopBtn).toBeEnabled(), WAIT);
  await user.click(stopBtn);

  expect(await screen.findByText('Nothing was stopped')).toBeInTheDocument();
  expect(screen.getByTestId('status-marker')).toHaveTextContent('1 node unreachable, left out');
  await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(
    'Nothing was stopped. 1 node unreachable, left out.',
  ));
});

it('keeps the unresolved marker when nothing stopped because the dry run resolved nothing', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string, init?: { body?: string }) => {
    if (url === '/fleet/labels/fleet-stop') {
      const body = JSON.parse(init?.body ?? '{}');
      if (body.dryRun) {
        return Promise.resolve(jsonResponse(200, {
          results: [{
            nodeId: 1, nodeName: 'central', reachable: true, matched: true,
            stackResults: [{ stackName: 'web', success: true, dryRun: true }, { stackName: 'db', success: false, error: 'dry run failed' }],
          }],
        }));
      }
      // The resolved stack reports no result on the real run, so nothing stopped.
      return Promise.resolve(jsonResponse(200, {
        results: [{ nodeId: 1, nodeName: 'central', reachable: true, matched: true, stackResults: [] }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  await user.click(await screen.findByRole('button', { name: 'Resolve with dry run' }, WAIT));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Stop stacks' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Stop stacks' }));

  expect(await screen.findByText('Nothing was stopped')).toBeInTheDocument();
  expect(screen.getByTestId('status-marker')).toHaveTextContent('1 stack could not be resolved');
  expect(screen.getByText('1 stack could not be resolved, so they were not stopped.')).toBeInTheDocument();
  await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(
    'Nothing was stopped. 1 stack could not be resolved.',
  ));
});

it('leaves out stacks whose dry run failed and keeps the unreachable nodes on the answer', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/fleet-stop') {
      return Promise.resolve(jsonResponse(200, {
        results: [
          {
            nodeId: 1, nodeName: 'central', reachable: true, matched: true,
            stackResults: [{ stackName: 'web', success: true, dryRun: true }, { stackName: 'db', success: false, error: 'dry run failed' }],
          },
          { nodeId: 2, nodeName: 'edge-1', reachable: false, matched: false, stackResults: [], error: 'Remote node not configured' },
        ],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  await user.click(await screen.findByRole('button', { name: 'Resolve with dry run' }, WAIT));
  expect(await screen.findByText('Stops 1 stack')).toBeInTheDocument();
  expect(screen.getByText('on 1 node · web')).toBeInTheDocument();
  expect(screen.getByText('1 unreachable, left out · 1 could not be resolved')).toBeInTheDocument();
  await waitFor(() => expect(toastWarning).toHaveBeenCalledWith('Resolved 1 stack; 1 could not be resolved. 1 node unreachable.'));
  toastWarning.mockClear();
  await user.click(screen.getByRole('button', { name: 'Stop stacks' }));
  await waitFor(() => {
    const call = mockedFetch.mock.calls.filter(c => c[0] === '/fleet/labels/fleet-stop').map(c => JSON.parse(c[1].body)).find(b => !b.dryRun);
    expect(call.targets).toEqual([{ nodeId: 1, stackNames: ['web'] }]);
  });
  // The real response names the same node the plan left out; it must appear once,
  // not twice, and the stack that failed to resolve must stay visible.
  expect(await screen.findByText('1 stopped, 1 failed')).toBeInTheDocument();
  expect(screen.getByTestId('status-answer')).toHaveAttribute('data-tone', 'warning');
  expect(screen.getByTestId('status-marker')).toHaveTextContent('1 node unreachable · 1 stack could not be resolved');
  await user.click(screen.getByRole('button', { name: 'Per-node outcome' }));
  expect(screen.getAllByText(/edge-1/)).toHaveLength(1);
  await waitFor(() => expect(toastWarning).toHaveBeenCalledWith(
    '1 stopped, 1 failed. See the result. 1 node unreachable. 1 stack could not be resolved.',
  ));
});

it('answers "No stacks match" after a dry run that resolved nothing', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/fleet-stop') {
      return Promise.resolve(jsonResponse(200, {
        results: [{ nodeId: 1, nodeName: 'central', reachable: true, matched: false, stackResults: [] }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  await user.click(await screen.findByRole('button', { name: 'Resolve with dry run' }, WAIT));
  expect(await screen.findByText('No stacks match')).toBeInTheDocument();
  expect(screen.queryByText('Preview unavailable')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Stop stacks' })).toBeDisabled();
});

it('locks the label while a stop runs and cannot be dismissed until it finishes', async () => {
  const user = userEvent.setup();
  let finish: ((response: Response) => void) | null = null;
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') return Promise.resolve(previewOf([centralWeb], { nodes: 1, stacks: 1 }));
    if (url === '/fleet/labels/fleet-stop') return new Promise<Response>((resolve) => { finish = resolve; });
    return Promise.resolve(jsonResponse(404, {}));
  });
  const { onOpenChange } = renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  const stopBtn = screen.getByRole('button', { name: 'Stop stacks' });
  await waitFor(() => expect(stopBtn).toBeEnabled(), WAIT);
  await user.click(stopBtn);
  await waitFor(() => expect(finish).not.toBeNull());

  expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeDisabled();
  await user.keyboard('{Escape}');
  expect(onOpenChange).not.toHaveBeenCalledWith(false);

  await act(async () => {
    finish!(jsonResponse(200, {
      results: [{ nodeId: 1, nodeName: 'central', reachable: true, matched: true, stackResults: [{ stackName: 'web', success: true }] }],
    }));
  });
  expect(await screen.findByText('Stopped 1 stack')).toBeInTheDocument();
});

it('keeps the unreachable marker and node list on a dry run that resolved nothing', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/fleet-stop') {
      return Promise.resolve(jsonResponse(200, {
        results: [
          { nodeId: 1, nodeName: 'central', reachable: true, matched: false, stackResults: [] },
          { nodeId: 2, nodeName: 'edge-1', reachable: false, matched: false, stackResults: [], error: 'Remote node not configured' },
        ],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  await user.click(await screen.findByRole('button', { name: 'Resolve with dry run' }, WAIT));
  expect(await screen.findByText('No stacks match')).toBeInTheDocument();
  expect(screen.getByText('1 unreachable, left out')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Unreachable nodes' }));
  expect(screen.getByText('edge-1')).toBeInTheDocument();
});

it('does not call a dry run where every stack failed "no stacks match"', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/fleet-stop') {
      return Promise.resolve(jsonResponse(200, {
        results: [{ nodeId: 1, nodeName: 'central', reachable: true, matched: true, stackResults: [{ stackName: 'web', success: false, error: 'busy' }] }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  await user.click(await screen.findByRole('button', { name: 'Resolve with dry run' }, WAIT));
  expect(await screen.findByText('Nothing could be resolved')).toBeInTheDocument();
  expect(screen.getByText('1 stack carrying this label failed their dry run.')).toBeInTheDocument();
  expect(screen.queryByText('No stacks match')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Stop stacks' })).toBeDisabled();
});

it('reports a dry run whose only results failed as unresolved, not as a no-match', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/fleet-stop') {
      // A remote that reports no label match but still returns a failed result.
      return Promise.resolve(jsonResponse(200, {
        results: [{ nodeId: 1, nodeName: 'central', reachable: true, matched: false, stackResults: [{ stackName: 'web', success: false, error: 'busy' }] }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  await user.click(await screen.findByRole('button', { name: 'Resolve with dry run' }, WAIT));
  expect(await screen.findByText('Nothing could be resolved')).toBeInTheDocument();
  await waitFor(() => expect(toastWarning).toHaveBeenCalledWith('Resolved 0 stacks; 1 could not be resolved.'));
  expect(toastInfo).not.toHaveBeenCalledWith(expect.stringContaining('No reachable node carries'));
});

it('counts a node with a malformed dry-run body as failed instead of dropping it', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/fleet-stop') {
      return Promise.resolve(jsonResponse(200, {
        results: [
          { nodeId: 1, nodeName: 'central', reachable: true, matched: true, stackResults: [{ stackName: 'web', success: true, dryRun: true }] },
          { nodeId: 2, nodeName: 'edge-1', reachable: true, matched: true, stackResults: 'nope' },
        ],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  await user.click(await screen.findByRole('button', { name: 'Resolve with dry run' }, WAIT));
  expect(await screen.findByText('Stops 1 stack')).toBeInTheDocument();
  expect(screen.getByText('1 could not be resolved')).toBeInTheDocument();
});

it('treats a preview with non-string stack names as unavailable', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') {
      return Promise.resolve(previewOf([{ ...centralWeb, stackNames: [42] }], { nodes: 1, stacks: 1 }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'prod');
  expect(await screen.findByText('Preview unavailable', undefined, WAIT)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Stop stacks' })).toBeDisabled();
});

it('lets the first Escape close the sheet when no suggestion list is on screen', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => suggestionsRoute(url) ?? Promise.resolve(jsonResponse(404, {})));
  const { onOpenChange } = renderSheet();
  await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'zzz');
  expect(screen.queryByRole('button', { name: /production/ })).not.toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(onOpenChange).toHaveBeenCalledWith(false);
});
