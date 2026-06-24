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
import { SCHEDULED_ACTIONS } from '@/lib/scheduledActions';
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
let nodesFixture: { id: number; name: string }[];

beforeEach(() => {
  tasksFixture = [];
  nodesFixture = [{ id: 1, name: 'hub' }, { id: 2, name: 'edge' }];
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
        cron_expression: '0 3 * * *',
        prune_targets: ['containers', 'images', 'networks', 'volumes'],
      });
      expect(postCall![1].localOnly).toBe(true);
    });
  });

  it('renders the five registry category lanes in the timeline view', async () => {
    render(<ScheduledOperationsView />);
    // Timeline is the default view; the lane track always renders.
    for (const lane of ['Lifecycle', 'Updates', 'Security', 'Maintenance', 'Backups']) {
      expect(await screen.findByText(lane)).toBeInTheDocument();
    }
  });

  it('offers every registry action in the create picker', async () => {
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
    await userEvent.click(screen.getAllByRole('combobox')[0]);

    for (const action of SCHEDULED_ACTIONS) {
      expect(await screen.findByRole('button', { name: action.label })).toBeInTheDocument();
    }
  });

  it('shows the correct conditional fields per action', async () => {
    render(<ScheduledOperationsView />);
    await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));

    // The Combobox toggles selection, so each step selects an action that
    // differs from the current one (the modal opens on the first action,
    // Restart Stack).
    const selectAction = async (label: string) => {
      await userEvent.click(screen.getAllByRole('combobox')[0]);
      await userEvent.click(await screen.findByRole('button', { name: label }));
    };

    // Default stack action (Restart Stack): Node + Stack, no Prune Targets.
    expect(await screen.findByText('Stack')).toBeInTheDocument();
    expect(screen.getByText('Node')).toBeInTheDocument();
    expect(screen.queryByText('Prune Targets')).not.toBeInTheDocument();

    // Node-only action: Node shown, Stack hidden.
    await selectAction('Auto-update All Stacks');
    expect(screen.getByText('Node')).toBeInTheDocument();
    expect(screen.queryByText('Stack')).not.toBeInTheDocument();

    // Fleet snapshot: no Node, no Stack.
    await selectAction('Fleet Snapshot');
    expect(screen.queryByText('Node')).not.toBeInTheDocument();
    expect(screen.queryByText('Stack')).not.toBeInTheDocument();

    // Prune: Prune Targets shown, no Node.
    await selectAction('System Prune');
    expect(screen.getByText('Prune Targets')).toBeInTheDocument();
    expect(screen.queryByText('Node')).not.toBeInTheDocument();
  });

  it('emits node_id and target_id for a stack update save', async () => {
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
    await userEvent.type(await screen.findByPlaceholderText('e.g. Nightly stack restart'), 'stack-update');

    // Switch from the default restart to the stack update action.
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Auto-update Stack' }));

    // Node selector, then the stack selector that loads once a node is chosen.
    await userEvent.click(screen.getAllByRole('combobox')[1]);
    await userEvent.click(await screen.findByRole('button', { name: 'hub' }));
    await userEvent.click(screen.getAllByRole('combobox')[2]);
    await userEvent.click(await screen.findByRole('button', { name: 'web' }));

    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      const postCall = mockedFetch.mock.calls.find(
        ([url, opts]) => url === '/scheduled-tasks' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall![1].body);
      expect(body).toMatchObject({
        name: 'stack-update',
        target_type: 'stack',
        action: 'update',
        target_id: 'web',
        node_id: 1,
      });
    });
  });

  it('maps the update-fleet alias to action=update, target_type=fleet on save', async () => {
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
    await userEvent.type(await screen.findByPlaceholderText('e.g. Nightly stack restart'), 'fleet-update');

    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Auto-update All Stacks' }));

    // Node selector is the second combobox once the node-only field renders.
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
        name: 'fleet-update',
        target_type: 'fleet',
        action: 'update',
        node_id: 1,
      });
    });
  });
});
