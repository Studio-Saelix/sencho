/**
 * Coverage for LabelFleetStopCard.
 *
 * Locks the destructive-action contract: buttons gated on a label name, the
 * confirm modal gates the real stop, dry run bypasses the modal, per-node
 * results render, and every failure path surfaces a toast (no silent failure).
 *
 * Also locks the stack-label scope: suggestions come from the fleet
 * stack-label endpoint (never node labels), a node-only name produces a clear
 * zero-stack preview, and a non-ok suggestions response is non-fatal.
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

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedFetchForNode = fetchForNode as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: every endpoint 404s so the suggestions load lands empty and the
  // debounced preview never throws. Individual tests override per URL.
  mockedFetch.mockResolvedValue(jsonResponse(404, {}));
});

it('disables both actions until a label name is entered', () => {
  render(<LabelFleetStopCard />);
  expect(screen.getByRole('button', { name: 'Stop fleet' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Dry run' })).toBeDisabled();
});

it('enables Dry run on a label name but gates Stop fleet until the blast radius resolves', async () => {
  const user = userEvent.setup();
  // The default mocks 404 every endpoint, so the match-preview never resolves.
  render(<LabelFleetStopCard />);
  await user.type(screen.getByPlaceholderText('e.g. production'), 'prod');
  expect(screen.getByRole('button', { name: 'Dry run' })).toBeEnabled();
  // No resolved preview (or dry run) yet, so the destructive Stop stays disabled.
  expect(screen.getByRole('button', { name: 'Stop fleet' })).toBeDisabled();
});

it('labels the target as a stack label and explains node labels are excluded', () => {
  render(<LabelFleetStopCard />);
  expect(screen.getByText('Stack label · target')).toBeInTheDocument();
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
  render(<LabelFleetStopCard />);

  // Open the popover and confirm stack labels render with their counts.
  await user.click(screen.getByPlaceholderText('e.g. production'));
  expect(await screen.findByText('production')).toBeInTheDocument();
  expect(screen.getByText('3 stacks · 2 nodes')).toBeInTheDocument();
  expect(screen.getByText('1 stack · 1 node')).toBeInTheDocument();

  // A node-only label name (never returned by the stack-label endpoint) is absent,
  // and the card never reaches for the per-node label list.
  expect(screen.queryByText('edge')).not.toBeInTheDocument();
  expect(mockedFetchForNode).not.toHaveBeenCalled();
});

it('drops malformed suggestion entries that fail the stack-label shape guard', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/suggestions') {
      return Promise.resolve(jsonResponse(200, {
        suggestions: [
          { name: 'missing-scope' },
          'garbage',
          { name: 'valid', scope: 'stack', nodeCount: 1, stackCount: 1 },
        ],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<LabelFleetStopCard />);
  await user.click(screen.getByPlaceholderText('e.g. production'));
  expect(await screen.findByText('valid')).toBeInTheDocument();
  expect(screen.queryByText('missing-scope')).not.toBeInTheDocument();
});

it('populates the input when a suggestion is selected', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/suggestions') {
      return Promise.resolve(jsonResponse(200, {
        suggestions: [{ name: 'production', scope: 'stack', nodeCount: 2, stackCount: 3 }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<LabelFleetStopCard />);
  const input = screen.getByPlaceholderText('e.g. production') as HTMLInputElement;
  await user.click(input);
  await user.click(await screen.findByRole('button', { name: /production/ }));
  expect(input.value).toBe('production');
  expect(screen.getByRole('button', { name: 'Dry run' })).toBeEnabled();
});

it('shows a zero-stack preview when a node-only name is typed', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') {
      return Promise.resolve(jsonResponse(200, { matchedNodes: 0, matchedStacks: 0, perNode: [] }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<LabelFleetStopCard />);
  await user.type(screen.getByPlaceholderText('e.g. production'), 'edge');

  expect(await screen.findByText('No reachable node carries a stack label by that name', undefined, { timeout: 2000 })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText('0 matching stacks')).toBeInTheDocument());
});

it('keeps the card usable when the suggestions endpoint returns 403', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/suggestions') {
      return Promise.resolve(jsonResponse(403, { error: 'Admin required' }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<LabelFleetStopCard />);
  // No crash, no suggestions, and the operator can still type a name by hand.
  await user.type(screen.getByPlaceholderText('e.g. production'), 'prod');
  expect(screen.getByRole('button', { name: 'Dry run' })).toBeEnabled();
});

it('dry run calls fleet-stop with dryRun:true and never opens the confirm modal', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/fleet-stop') {
      return Promise.resolve(jsonResponse(200, {
        results: [{ nodeId: 1, nodeName: 'central', reachable: true, matched: true, stackResults: [{ stackName: 'web', success: true, dryRun: true }] }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<LabelFleetStopCard />);
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

it('gates Stop fleet on a resolved preview, carries the node/stack list into the modal, then runs a real stop', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') {
      return Promise.resolve(jsonResponse(200, {
        matchedNodes: 1, matchedStacks: 1, unreachableNodes: 0,
        perNode: [{ nodeId: 1, nodeName: 'central', reachable: true, labelExists: true, stackCount: 1, stackNames: ['web'] }],
      }));
    }
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
  render(<LabelFleetStopCard />);
  await user.type(screen.getByPlaceholderText('e.g. production'), 'prod');

  // Stop fleet only enables once the live preview resolves the blast radius.
  const stopBtn = screen.getByRole('button', { name: 'Stop fleet' });
  await waitFor(() => expect(stopBtn).toBeEnabled(), { timeout: 2000 });
  await user.click(stopBtn);

  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText('Stop all stacks with the stack label "prod"?')).toBeInTheDocument();
  // The modal carries the resolved node/stack list, not just the label name.
  expect(within(dialog).getByText(/Will stop 1 stack across 1 node/)).toBeInTheDocument();
  expect(within(dialog).getByText('central')).toBeInTheDocument();
  expect(within(dialog).getByText('web')).toBeInTheDocument();

  // The real stop must not have fired yet (only the preview hit the network).
  expect(mockedFetch.mock.calls.find(c => c[0] === '/fleet/labels/fleet-stop')).toBeFalsy();

  await user.click(within(dialog).getByRole('button', { name: 'Stop fleet' }));

  await waitFor(() => {
    const stopCall = mockedFetch.mock.calls.find(c => c[0] === '/fleet/labels/fleet-stop');
    expect(JSON.parse(stopCall![1].body)).toEqual({ labelName: 'prod', dryRun: false });
  });
  // Per-node results render in the card (the "· 1 stack" label is unique to the
  // results list, distinguishing it from the preview well).
  expect(await screen.findByText('central · 1 stack')).toBeInTheDocument();
  await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
});

it('lists every node and stack in the confirm modal and sums them across nodes', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') {
      return Promise.resolve(jsonResponse(200, {
        matchedNodes: 2, matchedStacks: 3, unreachableNodes: 0,
        perNode: [
          { nodeId: 1, nodeName: 'central', reachable: true, labelExists: true, stackCount: 1, stackNames: ['web'] },
          { nodeId: 2, nodeName: 'edge-1', reachable: true, labelExists: true, stackCount: 2, stackNames: ['api', 'db'] },
        ],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<LabelFleetStopCard />);
  await user.type(screen.getByPlaceholderText('e.g. production'), 'prod');
  const stopBtn = screen.getByRole('button', { name: 'Stop fleet' });
  await waitFor(() => expect(stopBtn).toBeEnabled(), { timeout: 2000 });
  await user.click(stopBtn);

  const dialog = await screen.findByRole('alertdialog');
  // The reduce + pluralization across nodes is the only computed display logic.
  expect(within(dialog).getByText(/Will stop 3 stacks across 2 nodes/)).toBeInTheDocument();
  expect(within(dialog).getByText('central')).toBeInTheDocument();
  expect(within(dialog).getByText('edge-1')).toBeInTheDocument();
  expect(within(dialog).getByText('web')).toBeInTheDocument();
  expect(within(dialog).getByText('api, db')).toBeInTheDocument();
});

it('surfaces an error toast when fleet-stop returns a non-ok response', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/fleet-stop') {
      return Promise.resolve(jsonResponse(500, { error: 'boom' }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<LabelFleetStopCard />);
  await user.type(screen.getByPlaceholderText('e.g. production'), 'prod');
  await user.click(screen.getByRole('button', { name: 'Dry run' }));
  await waitFor(() => expect(toastError).toHaveBeenCalledWith('boom'));
});

it('populates the blast readout from the debounced match-preview', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') {
      return Promise.resolve(jsonResponse(200, { matchedNodes: 2, matchedStacks: 3, unreachableNodes: 0, perNode: [] }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<LabelFleetStopCard />);
  await user.type(screen.getByPlaceholderText('e.g. production'), 'prod');
  await waitFor(() => expect(screen.getByText('3 stacks · 2 nodes')).toBeInTheDocument(), { timeout: 2000 });
});

it('degrades to "preview unavailable" when match-preview returns a malformed 200 body', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') {
      // 200 but perNode is missing: the render path must degrade, not throw.
      return Promise.resolve(jsonResponse(200, { matchedStacks: 1, matchedNodes: 1 }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<LabelFleetStopCard />);
  await user.type(screen.getByPlaceholderText('e.g. production'), 'prod');
  expect(await screen.findByText('preview endpoint did not respond', undefined, { timeout: 2000 })).toBeInTheDocument();
  // The card stays interactive (no crash from the missing perNode array), but the
  // destructive Stop stays gated while the preview is unavailable; Dry run is the
  // escape hatch that can still resolve the blast radius.
  expect(screen.getByRole('button', { name: 'Dry run' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Stop fleet' })).toBeDisabled();
});

it('keeps Stop fleet disabled when the preview resolves to zero matching stacks', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') {
      return Promise.resolve(jsonResponse(200, { matchedNodes: 0, matchedStacks: 0, unreachableNodes: 0, perNode: [] }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<LabelFleetStopCard />);
  await user.type(screen.getByPlaceholderText('e.g. production'), 'edge');
  await waitFor(() => expect(screen.getByText('0 matching stacks')).toBeInTheDocument(), { timeout: 2000 });
  // A resolved-but-empty preview is nothing to stop, so the destructive Stop
  // stays disabled even though the blast radius is fully resolved.
  expect(screen.getByRole('button', { name: 'Stop fleet' })).toBeDisabled();
});

it('lets a successful dry run unblock Stop fleet when the match-preview endpoint is unavailable', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/fleet-stop') {
      return Promise.resolve(jsonResponse(200, {
        results: [{ nodeId: 1, nodeName: 'central', reachable: true, matched: true, stackResults: [{ stackName: 'web', success: true, dryRun: true }] }],
      }));
    }
    // match-preview (and everything else) is unavailable.
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<LabelFleetStopCard />);
  await user.type(screen.getByPlaceholderText('e.g. production'), 'prod');
  const stopBtn = screen.getByRole('button', { name: 'Stop fleet' });
  expect(stopBtn).toBeDisabled();

  // A dry run resolves the blast radius even with no live preview.
  await user.click(screen.getByRole('button', { name: 'Dry run' }));
  await waitFor(() => expect(stopBtn).toBeEnabled());

  // And the confirm modal it opens carries the dry-run-resolved targets.
  await user.click(stopBtn);
  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText('central')).toBeInTheDocument();
  expect(within(dialog).getByText('web')).toBeInTheDocument();
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
  render(<LabelFleetStopCard />);
  const input = screen.getByPlaceholderText('e.g. production');
  await user.type(input, 'prod');
  const stopBtn = screen.getByRole('button', { name: 'Stop fleet' });

  // Resolve via dry run, then edit away and back to the same label.
  await user.click(screen.getByRole('button', { name: 'Dry run' }));
  await waitFor(() => expect(stopBtn).toBeEnabled());
  await user.clear(input);
  await user.type(input, 'prod');

  // The stale snapshot must not re-enable Stop; a fresh dry run/preview is required.
  await waitFor(() => expect(stopBtn).toBeDisabled());
});

it('does not crash when fleet-stop returns a malformed 200 body', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/fleet-stop') {
      // results is not an array: must degrade to a toast, not throw.
      return Promise.resolve(jsonResponse(200, { results: 'nope' }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<LabelFleetStopCard />);
  await user.type(screen.getByPlaceholderText('e.g. production'), 'prod');
  await user.click(screen.getByRole('button', { name: 'Dry run' }));
  // Reported as an unexpected response, not masqueraded as "No reachable nodes".
  await waitFor(() => expect(toastError).toHaveBeenCalledWith('Fleet stop returned an unexpected response. Check the server logs and retry.'));
  expect(toastWarning).not.toHaveBeenCalled();
  expect(screen.getByPlaceholderText('e.g. production')).toBeInTheDocument();
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
  render(<LabelFleetStopCard />);
  expect(await screen.findByText(/1 node unreachable; suggestions may be incomplete/i)).toBeInTheDocument();
  await user.click(screen.getByPlaceholderText('e.g. production'));
  expect(await screen.findByText('media')).toBeInTheDocument();
  // The node-name spread renders as a muted detail under the label name.
  expect(screen.getByText('central, edge-1')).toBeInTheDocument();
});

it('renders unreachable nodes in the preview without dropping the matched ones', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') {
      return Promise.resolve(jsonResponse(200, {
        matchedNodes: 1,
        matchedStacks: 1,
        unreachableNodes: 1,
        perNode: [
          { nodeId: 1, nodeName: 'central', reachable: true, labelExists: true, stackCount: 1, stackNames: ['web'] },
          { nodeId: 2, nodeName: 'edge-1', reachable: false, labelExists: false, stackCount: 0, stackNames: [], error: 'Remote node not configured' },
        ],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<LabelFleetStopCard />);
  await user.type(screen.getByPlaceholderText('e.g. production'), 'media');
  expect(await screen.findByText('web', undefined, { timeout: 2000 })).toBeInTheDocument();
  expect(screen.getByText('unreachable · 1')).toBeInTheDocument();
  expect(screen.getByText('edge-1')).toBeInTheDocument();
});

it('distinguishes "label exists, no stacks" and shows a 0-reachable blast when the rest are unreachable', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/match-preview') {
      return Promise.resolve(jsonResponse(200, {
        matchedNodes: 0,
        matchedStacks: 0,
        unreachableNodes: 1,
        perNode: [
          { nodeId: 1, nodeName: 'central', reachable: true, labelExists: true, stackCount: 0, stackNames: [] },
          { nodeId: 2, nodeName: 'edge-1', reachable: false, labelExists: false, stackCount: 0, stackNames: [], error: 'Remote node not configured' },
        ],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<LabelFleetStopCard />);
  await user.type(screen.getByPlaceholderText('e.g. production'), 'media');
  expect(await screen.findByText('This stack label exists but has no stacks assigned on the reachable nodes', undefined, { timeout: 2000 })).toBeInTheDocument();
  expect(screen.getByText('unreachable · 1')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText('0 reachable · 1 unreachable')).toBeInTheDocument());
});

it('renders an unreachable fleet-stop node as unreachable, not "no matching label", and warns', async () => {
  const user = userEvent.setup();
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/labels/fleet-stop') {
      return Promise.resolve(jsonResponse(200, {
        results: [{ nodeId: 2, nodeName: 'edge-1', reachable: false, matched: false, stackResults: [], error: 'Remote node not configured' }],
      }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<LabelFleetStopCard />);
  await user.type(screen.getByPlaceholderText('e.g. production'), 'prod');
  await user.click(screen.getByRole('button', { name: 'Dry run' }));
  expect(await screen.findByText(/edge-1 \(unreachable\)/)).toBeInTheDocument();
  await waitFor(() => expect(toastWarning).toHaveBeenCalled());
});
