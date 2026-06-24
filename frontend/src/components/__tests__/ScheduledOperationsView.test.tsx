/**
 * Component coverage for ScheduledOperationsView. Locks the deterministic
 * wiring that manual and browser testing miss: the task list renders, a prefill
 * opens the create modal and is consumed once, the node filter narrows the
 * table, and a create submits the correct action/target payload to the
 * hub-local endpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ScheduledTask } from '@/types/scheduling';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), fetchForNode: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import { apiFetch, fetchForNode } from '@/lib/api';
import ScheduledOperationsView from '../ScheduledOperationsView';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedFetchForNode = fetchForNode as unknown as ReturnType<typeof vi.fn>;

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return { ok: init.ok ?? true, status: init.status ?? 200, json: async () => body } as unknown as Response;
}

function makeTask(overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: 1,
    name: 'task-1',
    target_type: 'system',
    target_id: null,
    node_id: 1,
    action: 'prune',
    cron_expression: '0 3 * * *',
    enabled: 1,
    created_by: 'admin',
    created_at: 0,
    updated_at: 0,
    last_run_at: null,
    next_run_at: null,
    last_status: null,
    last_error: null,
    prune_targets: null,
    target_services: null,
    prune_label_filter: null,
    ...overrides,
  };
}

let tasksFixture: ScheduledTask[];
let nodesFixture: { id: number; name: string; type: 'local' | 'remote' }[];

beforeEach(() => {
  tasksFixture = [];
  nodesFixture = [{ id: 1, name: 'hub', type: 'local' }, { id: 2, name: 'edge', type: 'remote' }];
  mockedFetch.mockReset();
  mockedFetchForNode.mockReset();

  mockedFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
    if (url === '/scheduled-tasks' && opts?.method === 'POST') return jsonResponse({ id: 99 }, { status: 201 });
    if (url === '/scheduled-tasks') return jsonResponse(tasksFixture);
    if (url === '/nodes') return jsonResponse(nodesFixture);
    if (url === '/stacks') return jsonResponse([]);
    return jsonResponse({});
  });
  mockedFetchForNode.mockResolvedValue(jsonResponse(['web', 'db']));
});

afterEach(() => vi.clearAllMocks());

describe('ScheduledOperationsView', () => {
  it('renders existing tasks in the table view', async () => {
    tasksFixture = [makeTask({ id: 7, name: 'nightly-prune' })];
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /All tasks/ }));
    expect(await screen.findByText('nightly-prune')).toBeInTheDocument();
  });

  it('opens the create modal from a prefill and consumes it once', async () => {
    const onPrefillConsumed = vi.fn();
    render(
      <ScheduledOperationsView
        prefill={{ stackName: 'web', nodeId: 1 }}
        onPrefillConsumed={onPrefillConsumed}
      />,
    );

    expect(await screen.findByText('New scheduled task')).toBeInTheDocument();
    expect(onPrefillConsumed).toHaveBeenCalledTimes(1);
    // The prefilled stack drives a node-scoped stack fetch through the proxy.
    await waitFor(() => expect(mockedFetchForNode).toHaveBeenCalledWith('/stacks', 1));
  });

  it('filters the table to the selected node and clears the filter', async () => {
    tasksFixture = [
      makeTask({ id: 1, name: 'hub-task', node_id: 1 }),
      makeTask({ id: 2, name: 'edge-task', node_id: 2 }),
    ];
    const onClearFilter = vi.fn();
    render(<ScheduledOperationsView filterNodeId={2} onClearFilter={onClearFilter} />);

    await userEvent.click(await screen.findByRole('button', { name: /All tasks/ }));
    expect(await screen.findByText('edge-task')).toBeInTheDocument();
    expect(screen.queryByText('hub-task')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Clear filter/ }));
    expect(onClearFilter).toHaveBeenCalled();
  });

  it('submits a system-prune create with the correct target_type and payload', async () => {
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
    await userEvent.type(await screen.findByPlaceholderText('e.g. Nightly stack restart'), 'cleanup');

    // The action selector is the first combobox; switch it to System Prune.
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'System Prune' }));

    // Prune is now node-scoped: pick the local node from its Node combobox.
    await userEvent.click(screen.getAllByRole('combobox')[1]);
    await userEvent.click(await screen.findByRole('button', { name: 'hub' }));

    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      const postCall = mockedFetch.mock.calls.find(
        ([url, opts]) => url === '/scheduled-tasks' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall![1].body);
      expect(body).toMatchObject({
        name: 'cleanup',
        target_type: 'system',
        action: 'prune',
        node_id: 1,
        cron_expression: '0 3 * * *',
        prune_targets: ['containers', 'images', 'networks', 'volumes'],
      });
      expect(postCall![1].localOnly).toBe(true);
    });
  });

  it('keeps Create disabled for a prune until a node is selected', async () => {
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
    await userEvent.type(await screen.findByPlaceholderText('e.g. Nightly stack restart'), 'cleanup');
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'System Prune' }));

    // Prune targets default to all four, but with no node the gate must hold.
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();

    await userEvent.click(screen.getAllByRole('combobox')[1]);
    await userEvent.click(await screen.findByRole('button', { name: 'hub' }));
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('excludes remote nodes from the System Prune node picker', async () => {
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'System Prune' }));

    // Open the Node combobox; only the local node should be listed.
    await userEvent.click(screen.getAllByRole('combobox')[1]);
    expect(await screen.findByRole('button', { name: 'hub' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'edge' })).not.toBeInTheDocument();
  });

  it('excludes remote nodes from the Vulnerability Scan node picker', async () => {
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Vulnerability Scan' }));

    await userEvent.click(screen.getAllByRole('combobox')[1]);
    expect(await screen.findByRole('button', { name: 'hub' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'edge' })).not.toBeInTheDocument();
  });

  it('shows a read-only "Entire fleet" scope for Fleet Snapshot', async () => {
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Fleet Snapshot' }));

    expect(await screen.findByText('Entire fleet')).toBeInTheDocument();
  });

  it('loads Restart Stack services from the selected node', async () => {
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
    // Default action is Restart Stack. Pick the remote node, then a stack on it.
    await userEvent.click(screen.getAllByRole('combobox')[1]);
    await userEvent.click(await screen.findByRole('button', { name: 'edge' }));
    // The Stack combobox unlocks once a node is chosen; pick a stack to drive discovery.
    await userEvent.click(screen.getAllByRole('combobox')[2]);
    await userEvent.click(await screen.findByRole('button', { name: 'web' }));

    // Service discovery must target the selected node, not the hub-local default.
    await waitFor(() =>
      expect(mockedFetchForNode).toHaveBeenCalledWith('/stacks/web/services', 2),
    );
  });
});
