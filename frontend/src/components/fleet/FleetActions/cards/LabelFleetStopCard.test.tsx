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

it('enables the actions once a label is typed', async () => {
  const user = userEvent.setup();
  render(<LabelFleetStopCard />);
  await user.type(screen.getByPlaceholderText('e.g. production'), 'prod');
  expect(screen.getByRole('button', { name: 'Stop fleet' })).toBeEnabled();
  expect(screen.getByRole('button', { name: 'Dry run' })).toBeEnabled();
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
  expect(screen.getByRole('button', { name: 'Stop fleet' })).toBeEnabled();
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

  expect(await screen.findByText('No stacks are assigned to this stack label', undefined, { timeout: 2000 })).toBeInTheDocument();
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
  expect(screen.getByRole('button', { name: 'Stop fleet' })).toBeEnabled();
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
  render(<LabelFleetStopCard />);
  await user.type(screen.getByPlaceholderText('e.g. production'), 'prod');
  await user.click(screen.getByRole('button', { name: 'Stop fleet' }));

  const dialog = await screen.findByRole('alertdialog');
  expect(within(dialog).getByText('Stop all stacks with the stack label "prod"?')).toBeInTheDocument();

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
  render(<LabelFleetStopCard />);
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
  render(<LabelFleetStopCard />);
  await user.type(screen.getByPlaceholderText('e.g. production'), 'prod');
  await waitFor(() => expect(screen.getByText('3 stacks · 2 nodes')).toBeInTheDocument(), { timeout: 2000 });
});
