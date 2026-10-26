import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), fetchForNode: vi.fn() }));
const auth = { isAdmin: true, can: () => true };
vi.mock('@/context/AuthContext', () => ({ useAuth: () => auth }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(() => 'id'), dismiss: vi.fn() },
}));

import { apiFetch, fetchForNode } from '@/lib/api';
import type { FleetNode } from '@/components/FleetView/types';
import { FleetActionsTab } from './FleetActionsTab';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedFetchForNode = fetchForNode as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

const nodes = [{ id: 1, name: 'central', type: 'local', status: 'online' }] as unknown as FleetNode[];

beforeEach(() => {
  vi.clearAllMocks();
  auth.isAdmin = true;
  mockedFetchForNode.mockResolvedValue(jsonResponse(200, []));
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/prune/estimate') {
      return Promise.resolve(jsonResponse(200, { totalBytes: 4096, perNode: [{ nodeId: 1, nodeName: 'central', reclaimableBytes: 4096, reachable: true }] }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
});

it('lists the three actions and shows what a prune would free', async () => {
  render(<FleetActionsTab nodes={nodes} />);
  expect(screen.getByText('Reclaim disk space')).toBeInTheDocument();
  expect(screen.getByText('Label stacks')).toBeInTheDocument();
  expect(screen.getByText('Stop stacks by label')).toBeInTheDocument();
  expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Prune…', 'Assign…', 'Stop…']);
  expect(await screen.findByText('~4 KB of images')).toBeInTheDocument();
});

it('leaves out the Reclaim row and its admin-only estimate for a non-admin', async () => {
  auth.isAdmin = false;
  render(<FleetActionsTab nodes={nodes} />);
  expect(screen.queryByText('Reclaim disk space')).not.toBeInTheDocument();
  expect(screen.getByText('Label stacks')).toBeInTheDocument();
  expect(screen.getByText('Stop stacks by label')).toBeInTheDocument();
  expect(mockedFetch).not.toHaveBeenCalled();
});

it('renders no hint when the estimate is unavailable', async () => {
  mockedFetch.mockResolvedValue(jsonResponse(500, {}));
  render(<FleetActionsTab nodes={nodes} />);
  await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(document.querySelector('.animate-pulse')).toBeNull());
  expect(screen.queryByText(/of images|nothing to reclaim/)).not.toBeInTheDocument();
});

it('asks for a node before offering any action', () => {
  render(<FleetActionsTab nodes={[]} />);
  expect(screen.getByText('Add a node to the fleet to use bulk actions.')).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

it('opens each task in its own sheet and leaves the list untouched', async () => {
  const user = userEvent.setup();
  render(<FleetActionsTab nodes={nodes} />);
  await user.click(screen.getByRole('button', { name: 'Stop…' }));
  const stop = await screen.findByRole('dialog');
  expect(within(stop).getByRole('heading', { name: 'Stop stacks by label' })).toBeInTheDocument();
  expect(screen.queryByText('Nothing to reclaim')).not.toBeInTheDocument();
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  await user.click(screen.getByRole('button', { name: 'Assign…' }));
  expect(within(await screen.findByRole('dialog')).getByRole('heading', { name: 'Label stacks' })).toBeInTheDocument();
});

it('starts a task from a clean slate every time it opens', async () => {
  const user = userEvent.setup();
  render(<FleetActionsTab nodes={nodes} />);
  await user.click(screen.getByRole('button', { name: 'Stop…' }));
  await user.type(await screen.findByPlaceholderText('e.g. production'), 'prod');
  await user.keyboard('{Escape}');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  await user.click(screen.getByRole('button', { name: 'Stop…' }));
  expect(await screen.findByPlaceholderText('e.g. production')).toHaveValue('');
});

it('marks a partial estimate on the Reclaim row', async () => {
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/prune/estimate') {
      return Promise.resolve(jsonResponse(200, { totalBytes: 500, perNode: [{ nodeId: 1, nodeName: 'central', reclaimableBytes: 500, reachable: true, partial: true }] }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<FleetActionsTab nodes={nodes} />);
  expect(await screen.findByText('~500 Bytes of images · partial')).toBeInTheDocument();
});

it('says there is nothing to reclaim when the estimate is zero, partial or not', async () => {
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/fleet/prune/estimate') {
      return Promise.resolve(jsonResponse(200, { totalBytes: 0, perNode: [{ nodeId: 1, nodeName: 'central', reclaimableBytes: 0, reachable: true, partial: true }] }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<FleetActionsTab nodes={nodes} />);
  expect(await screen.findByText('nothing to reclaim · partial')).toBeInTheDocument();
});

it('refreshes the Reclaim hint after a prune and opens Reclaim fresh the next time', async () => {
  const user = userEvent.setup();
  let estimate = 4096;
  const plan = {
    nodeId: 1, nodeName: 'central', reachable: true, fingerprint: 'fp', reclaimableBytes: 4096,
    items: [{ target: 'images', id: 'sha256:aaa', name: 'example/app:latest', sizeBytes: 4096, managed: true, reason: 'unused', image: { references: ['example/app:latest'] } }],
    targets: [{ target: 'images', success: true, reclaimedBytes: 4096, dryRun: true }],
  };
  mockedFetch.mockImplementation((url: string, init?: RequestInit) => {
    if (url === '/fleet/prune/estimate') {
      return Promise.resolve(jsonResponse(200, { totalBytes: estimate, perNode: [{ nodeId: 1, nodeName: 'central', reclaimableBytes: estimate, reachable: true }] }));
    }
    if (url === '/fleet/labels/fleet-prune') {
      if (JSON.parse(String(init?.body)).dryRun) return Promise.resolve(jsonResponse(200, { results: [plan] }));
      estimate = 0;
      return Promise.resolve(jsonResponse(200, { results: [{
        nodeId: 1, nodeName: 'central', reachable: true, reclaimedBytes: 4096,
        outcomes: [{ id: 'sha256:aaa', target: 'images', status: 'removed', sizeBytes: 4096 }],
        targets: [{ target: 'images', success: true, reclaimedBytes: 4096, dryRun: false }],
      }] }));
    }
    return Promise.resolve(jsonResponse(404, {}));
  });
  render(<FleetActionsTab nodes={nodes} />);
  expect(await screen.findByText('~4 KB of images')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Prune…' }));
  const sheet = await screen.findByRole('dialog');
  const prune = await within(sheet).findByRole('button', { name: 'Prune' });
  await waitFor(() => expect(prune).toBeEnabled());
  await user.click(prune);
  await within(sheet).findByText('Reclaimed 4 KB');
  expect(await screen.findByText('nothing to reclaim')).toBeInTheDocument();

  await user.click(within(sheet).getByRole('button', { name: 'Done' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: 'Prune…' }));
  const reopened = await screen.findByRole('dialog');
  expect(within(reopened).queryByRole('button', { name: 'Done' })).not.toBeInTheDocument();
  expect(await within(reopened).findByRole('button', { name: 'Prune' })).toBeInTheDocument();
});
