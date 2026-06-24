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

  it('marks a one-shot task with a chip and leaves recurring tasks unmarked', async () => {
    tasksFixture = [
      makeTask({ id: 1, name: 'recurring-task' }),
      makeTask({ id: 2, name: 'one-shot-task', delete_after_run: 1 }),
    ];
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /All tasks/ }));
    await screen.findByText('recurring-task');

    // A single One-shot chip, scoped to the one-shot row.
    const chips = screen.getAllByText('One-shot');
    expect(chips).toHaveLength(1);
    // A pending one-shot carries the plain lifecycle tooltip, not the failure copy.
    expect(chips[0]).toHaveAttribute('title', expect.stringContaining('Deletes itself after a successful run'));
    expect(chips[0]).toHaveAttribute('title', expect.not.stringContaining('kept after a failed run'));
    const oneShotRow = screen.getByText('one-shot-task').closest('tr');
    expect(oneShotRow).toContainElement(chips[0]);
    const recurringRow = screen.getByText('recurring-task').closest('tr');
    expect(recurringRow?.textContent).not.toContain('One-shot');
  });

  it('explains a failed one-shot was kept to debug', async () => {
    tasksFixture = [makeTask({ id: 1, name: 'failed-one-shot', delete_after_run: 1, last_status: 'failure' })];
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /All tasks/ }));
    const chip = await screen.findByText('One-shot');
    expect(chip).toHaveAttribute('title', expect.stringContaining('kept after a failed run'));
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

  it('disables Create when the cron expression has a seconds field', async () => {
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
    await userEvent.type(await screen.findByPlaceholderText('e.g. Nightly stack restart'), 'cleanup');

    // Use System Prune so the form needs no stack target/node, isolating the cron check.
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'System Prune' }));

    const createButton = screen.getByRole('button', { name: 'Create' });
    expect(createButton).toBeEnabled();

    const cronInput = screen.getByPlaceholderText('0 3 * * *');
    await userEvent.clear(cronInput);
    await userEvent.type(cronInput, '30 0 3 * * *');

    expect(screen.getByText(/seconds field is not supported/i)).toBeInTheDocument();
    expect(createButton).toBeDisabled();

    await userEvent.clear(cronInput);
    await userEvent.type(cronInput, '0 4 * * *');
    expect(createButton).toBeEnabled();
  });
});
