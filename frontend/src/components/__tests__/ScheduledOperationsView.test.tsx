/**
 * Component coverage for ScheduledOperationsView. Locks the deterministic
 * wiring that manual and browser testing miss: the task list renders, a prefill
 * opens the create modal and is consumed once, the node filter narrows the
 * table, and a create submits the correct action/target payload to the
 * hub-local endpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
let nodesFixture: { id: number; name: string; type: 'local' | 'remote' }[];

beforeEach(() => {
  tasksFixture = [];
  nodesFixture = [{ id: 1, name: 'hub', type: 'local' }, { id: 2, name: 'edge', type: 'remote' }];
  mockedFetch.mockReset();
  mockedFetchForNode.mockReset();

  mockedFetch.mockImplementation(async (url: string, opts?: { method?: string }) => {
    if (url === '/scheduled-tasks' && opts?.method === 'POST') return jsonResponse({ id: 99 }, { status: 201 });
    if (/^\/scheduled-tasks\/\d+$/.test(url) && opts?.method === 'PUT') return jsonResponse({ id: Number(url.split('/').pop()) });
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
    // The prefilled stack stays selected; the node-change effect must not wipe it.
    // Comboboxes render in order: action, node, stack.
    await waitFor(() => expect(screen.getAllByRole('combobox')[2]).toHaveTextContent('web'));
  });

  it('keeps the stack selected when editing a stack-targeted task', async () => {
    tasksFixture = [makeTask({
      id: 9, name: 'restart-web', action: 'restart', target_type: 'stack', target_id: 'web', node_id: 1,
    })];
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /All tasks/ }));
    await userEvent.click(await screen.findByTitle('Edit'));
    await waitFor(() => expect(screen.getAllByRole('combobox')[2]).toHaveTextContent('web'));
  });

  it('clears the stale stack when the user changes the node', async () => {
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
    // Default action Restart Stack: choose a node, then a stack on it.
    await userEvent.click(screen.getAllByRole('combobox')[1]);
    await userEvent.click(await screen.findByRole('button', { name: 'hub' }));
    await userEvent.click(screen.getAllByRole('combobox')[2]);
    await userEvent.click(await screen.findByRole('button', { name: 'web' }));
    expect(screen.getAllByRole('combobox')[2]).toHaveTextContent('web');

    // Switching node is a user-driven change, so the now-stale stack clears
    // and the user must re-pick one before the schedule can be saved.
    await userEvent.click(screen.getAllByRole('combobox')[1]);
    await userEvent.click(await screen.findByRole('button', { name: 'edge' }));
    expect(screen.getAllByRole('combobox')[2]).toHaveTextContent('Select stack...');
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
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

    // The action selector is the first combobox; switch it to Prune Node Resources.
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Prune Node Resources' }));

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

  it('disables Create when the cron expression has a seconds field', async () => {
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
    await userEvent.type(await screen.findByPlaceholderText('e.g. Nightly stack restart'), 'cleanup');

    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Prune Node Resources' }));
    await userEvent.click(screen.getAllByRole('combobox')[1]);
    await userEvent.click(await screen.findByRole('button', { name: 'hub' }));

    const createButton = screen.getByRole('button', { name: 'Create' });
    expect(createButton).toBeEnabled();

    // The raw cron input lives in Advanced mode; Simple mode generates the cron.
    await userEvent.click(screen.getByRole('radio', { name: 'Advanced' }));
    const cronInput = screen.getByPlaceholderText('0 3 * * *');
    await userEvent.clear(cronInput);
    await userEvent.type(cronInput, '30 0 3 * * *');

    expect(screen.getByText(/seconds field is not supported/i)).toBeInTheDocument();
    expect(createButton).toBeDisabled();

    await userEvent.clear(cronInput);
    await userEvent.type(cronInput, '0 4 * * *');
    expect(createButton).toBeEnabled();
  });

  it('keeps Create disabled for a prune until a node is selected', async () => {
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
    await userEvent.type(await screen.findByPlaceholderText('e.g. Nightly stack restart'), 'cleanup');
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Prune Node Resources' }));

    // Prune targets default to all four, but with no node the gate must hold.
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();

    await userEvent.click(screen.getAllByRole('combobox')[1]);
    await userEvent.click(await screen.findByRole('button', { name: 'hub' }));
    expect(screen.getByRole('button', { name: 'Create' })).toBeEnabled();
  });

  it('excludes remote nodes from the Prune Node Resources node picker', async () => {
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Prune Node Resources' }));

    // Open the Node combobox; only the local node should be listed.
    await userEvent.click(screen.getAllByRole('combobox')[1]);
    expect(await screen.findByRole('button', { name: 'hub' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'edge' })).not.toBeInTheDocument();
  });

  it('excludes remote nodes from the Scan Node Images node picker', async () => {
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Scan Node Images' }));

    await userEvent.click(screen.getAllByRole('combobox')[1]);
    expect(await screen.findByRole('button', { name: 'hub' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'edge' })).not.toBeInTheDocument();
  });

  it('submits a vulnerability scan create with the selected local node', async () => {
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
    await userEvent.type(await screen.findByPlaceholderText('e.g. Nightly stack restart'), 'scan-local');
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Scan Node Images' }));
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
        name: 'scan-local',
        target_type: 'system',
        action: 'scan',
        node_id: 1,
        target_id: null,
        prune_targets: null,
        target_services: null,
        prune_label_filter: null,
      });
      expect(postCall![1].localOnly).toBe(true);
    });
  });

  it('shows a read-only "Entire fleet" scope for Create Fleet Snapshot', async () => {
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Create Fleet Snapshot' }));

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

  it('hides service checkboxes when the stack has only one service', async () => {
    mockedFetchForNode.mockImplementation(async (url: string) => {
      if (url.endsWith('/services')) return jsonResponse(['mariadb']);
      return jsonResponse(['db-compose']);
    });
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
    await userEvent.click(screen.getAllByRole('combobox')[1]);
    await userEvent.click(await screen.findByRole('button', { name: 'edge' }));
    await userEvent.click(screen.getAllByRole('combobox')[2]);
    await userEvent.click(await screen.findByRole('button', { name: 'db-compose' }));

    await waitFor(() =>
      expect(mockedFetchForNode).toHaveBeenCalledWith('/stacks/db-compose/services', 2),
    );
    expect(screen.queryByText(/^Services/)).not.toBeInTheDocument();
  });

  it('shows service checkboxes when the stack has multiple services', async () => {
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
    await userEvent.click(screen.getAllByRole('combobox')[1]);
    await userEvent.click(await screen.findByRole('button', { name: 'edge' }));
    await userEvent.click(screen.getAllByRole('combobox')[2]);
    await userEvent.click(await screen.findByRole('button', { name: 'web' }));

    const servicesBlock = (await screen.findByText(/^Services/)).closest('.space-y-2');
    expect(within(servicesBlock!).getAllByRole('checkbox')).toHaveLength(2);
  });

  it('renders the five registry category lanes in the timeline view', async () => {
    render(<ScheduledOperationsView />);
    // Timeline is the default view; the lane track always renders.
    for (const lane of ['Lifecycle', 'Updates', 'Security', 'Maintenance', 'Backups']) {
      expect(await screen.findByText(lane)).toBeInTheDocument();
    }
  });

  it('labels timeline pills with a category-aware target and a detailed tooltip', async () => {
    const soon = Date.now() + 2 * 60 * 60 * 1000;
    tasksFixture = [
      makeTask({ id: 1, name: 'Nightly Snapshot', target_type: 'fleet', action: 'snapshot', node_id: null, next_runs: [soon] }),
      makeTask({ id: 2, name: 'Nightly Prune', target_type: 'system', action: 'prune', node_id: 1, next_runs: [soon] }),
    ];
    render(<ScheduledOperationsView />);

    // Snapshot pill reads "Entire fleet"; prune pill reads its node name.
    expect(await screen.findByText('Entire fleet')).toBeInTheDocument();
    expect(await screen.findByText('hub')).toBeInTheDocument();

    // Tooltips carry the full action label, with the node when the task has one.
    const prunePill = screen.getByText('hub').closest('button');
    expect(prunePill).toHaveAttribute('title', expect.stringContaining('Prune Node Resources'));
    expect(prunePill).toHaveAttribute('title', expect.stringContaining('hub'));
    const snapshotPill = screen.getByText('Entire fleet').closest('button');
    expect(snapshotPill).toHaveAttribute('title', expect.stringContaining('Create Fleet Snapshot'));
  });

  it('names the node on a fleet auto-update pill and composes the full tooltip', async () => {
    const soon = Date.now() + 2 * 60 * 60 * 1000;
    const hhmm = (ts: number) => {
      const d = new Date(ts);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    };
    tasksFixture = [
      makeTask({ id: 1, name: 'Fleet Update', target_type: 'fleet', action: 'update', node_id: 1, next_runs: [soon] }),
    ];
    render(<ScheduledOperationsView />);

    expect(await screen.findByText('All stacks · hub')).toBeInTheDocument();
    // Tooltip locks the ordered shape: action · name · time · node.
    const pill = screen.getByText('All stacks · hub').closest('button');
    expect(pill).toHaveAttribute('title', `Auto-update All Stacks on Node · Fleet Update · ${hhmm(soon)} · hub`);
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
    await selectAction('Auto-update All Stacks on Node');
    expect(screen.getByText('Node')).toBeInTheDocument();
    expect(screen.queryByText('Stack')).not.toBeInTheDocument();

    // Fleet snapshot: no Node, no Stack.
    await selectAction('Create Fleet Snapshot');
    expect(screen.queryByText('Node')).not.toBeInTheDocument();
    expect(screen.queryByText('Stack')).not.toBeInTheDocument();

    // Prune: local-only Node plus Prune Targets.
    await selectAction('Prune Node Resources');
    expect(screen.getByText('Prune Targets')).toBeInTheDocument();
    expect(screen.getByText('Node')).toBeInTheDocument();

    // Container action: Node + Container, no Stack.
    await selectAction('Restart Container');
    expect(screen.getByText('Node')).toBeInTheDocument();
    expect(screen.getByText('Container')).toBeInTheDocument();
    expect(screen.queryByText('Stack')).not.toBeInTheDocument();
  });

  it('emits container target payload for a container restart save', async () => {
    mockedFetchForNode.mockImplementation(async (url: string) => {
      if (url === '/stacks') return jsonResponse(['web']);
      if (url.startsWith('/containers')) {
        return jsonResponse([
          { Id: 'abc', Names: ['/watchtower'], State: 'running', Image: 'containrrr/watchtower' },
        ]);
      }
      return jsonResponse([]);
    });

    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
    await userEvent.type(await screen.findByPlaceholderText('e.g. Nightly stack restart'), 'daily-watchtower');

    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Restart Container' }));

    await userEvent.click(screen.getAllByRole('combobox')[1]);
    await userEvent.click(await screen.findByRole('button', { name: 'hub' }));
    await userEvent.click(screen.getAllByRole('combobox')[2]);
    await userEvent.click(await screen.findByRole('button', { name: /watchtower/ }));

    await userEvent.click(screen.getByRole('button', { name: 'Create' }));

    await waitFor(() => {
      const postCall = mockedFetch.mock.calls.find(
        ([url, opts]) => url === '/scheduled-tasks' && opts?.method === 'POST',
      );
      expect(postCall).toBeTruthy();
      const body = JSON.parse(postCall![1].body);
      expect(body).toMatchObject({
        name: 'daily-watchtower',
        target_type: 'container',
        action: 'restart',
        target_id: 'watchtower',
        node_id: 1,
      });
    });
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
    await userEvent.click(await screen.findByRole('button', { name: 'Auto-update All Stacks on Node' }));

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

  it('clears stack-only fields when editing a restart task into a fleet snapshot', async () => {
    tasksFixture = [makeTask({
      id: 42,
      name: 'restart-web',
      target_type: 'stack',
      target_id: 'web',
      node_id: 1,
      action: 'restart',
      target_services: JSON.stringify(['web']),
    })];
    render(<ScheduledOperationsView />);

    await userEvent.click(await screen.findByRole('button', { name: /All tasks/ }));
    await userEvent.click(await screen.findByTitle('Edit'));
    await userEvent.click(screen.getAllByRole('combobox')[0]);
    await userEvent.click(await screen.findByRole('button', { name: 'Create Fleet Snapshot' }));
    await userEvent.click(screen.getByRole('button', { name: 'Update' }));

    await waitFor(() => {
      const putCall = mockedFetch.mock.calls.find(
        ([url, opts]) => url === '/scheduled-tasks/42' && opts?.method === 'PUT',
      );
      expect(putCall).toBeTruthy();
      const body = JSON.parse(putCall![1].body);
      expect(body).toMatchObject({
        target_type: 'fleet',
        action: 'snapshot',
        target_id: null,
        node_id: null,
        target_services: null,
        prune_targets: null,
        prune_label_filter: null,
      });
    });
  });

  describe('risk badge and helper text', () => {
    it('shows Interruptive badge and helper for the default action Restart Stack', async () => {
      render(<ScheduledOperationsView />);
      await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));

      expect(screen.getByText('Interruptive')).toBeInTheDocument();
      expect(screen.getByText(
        'Restarts containers in place. Running services are stopped and started again on the same configuration.',
      )).toBeInTheDocument();
    });

    it('shows Safe badge and helper for Create Fleet Snapshot', async () => {
      render(<ScheduledOperationsView />);
      await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));

      // Switch action to Create Fleet Snapshot (a non-node, non-stack action).
      await userEvent.click(screen.getAllByRole('combobox')[0]);
      await userEvent.click(await screen.findByRole('button', { name: 'Create Fleet Snapshot' }));

      expect(screen.getByText('Safe')).toBeInTheDocument();
      expect(screen.getByText(
        'Creates a versioned snapshot of compose and env files across the fleet.',
      )).toBeInTheDocument();
    });

    it('shows Destructive badge and helper for Prune Node Resources', async () => {
      render(<ScheduledOperationsView />);
      await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));

      // Switch action to Prune Node Resources.
      await userEvent.click(screen.getAllByRole('combobox')[0]);
      await userEvent.click(await screen.findByRole('button', { name: 'Prune Node Resources' }));

      expect(screen.getByText('Destructive')).toBeInTheDocument();
      expect(screen.getByText(
        'Removes unused Docker resources on the selected node. Be careful when pruning volumes.',
      )).toBeInTheDocument();
    });
  });

  describe('Simple schedule mode', () => {
    const deleteCheckboxState = () =>
      document.querySelector('#task-delete-after-run')?.getAttribute('data-state');

    it('defaults to Simple / Daily / 03:00 generating "0 3 * * *"', async () => {
      render(<ScheduledOperationsView />);
      await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));

      expect(screen.getByRole('radio', { name: 'Simple' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByRole('radio', { name: 'Daily' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByLabelText('Hour')).toHaveTextContent('03');
      expect(screen.getByText(/0 3 \* \* \*/)).toBeInTheDocument();
    });

    it('updates the cron preview when the frequency changes', async () => {
      render(<ScheduledOperationsView />);
      await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));

      await userEvent.click(screen.getByRole('radio', { name: 'Hourly' }));
      expect(screen.getByText(/^· 0 \* \* \* \*$/)).toBeInTheDocument();
    });

    it('locks delete-after-run on for a one-time schedule and keeps it on (editable) after leaving', async () => {
      render(<ScheduledOperationsView />);
      await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
      const deleteCheckbox = () => document.querySelector('#task-delete-after-run');
      expect(deleteCheckboxState()).toBe('unchecked');
      expect(deleteCheckbox()).toBeEnabled();

      await userEvent.click(screen.getByRole('radio', { name: 'Once' }));
      expect(deleteCheckboxState()).toBe('checked');
      expect(deleteCheckbox()).toBeDisabled(); // cannot be turned off for one-time schedules
      expect(screen.getByText(/Required for one-time schedules/i)).toBeInTheDocument();

      await userEvent.click(screen.getByRole('radio', { name: 'Daily' }));
      expect(screen.queryByText(/Required for one-time schedules/i)).not.toBeInTheDocument();
      expect(deleteCheckboxState()).toBe('checked'); // not reverted
      expect(deleteCheckbox()).toBeEnabled(); // editable again
    });

    it('blocks save for invalid simple schedules', async () => {
      render(<ScheduledOperationsView />);
      await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
      await userEvent.type(await screen.findByPlaceholderText('e.g. Nightly stack restart'), 'one-off');
      // Fleet Snapshot needs neither node nor stack, isolating the schedule gate.
      await userEvent.click(screen.getAllByRole('combobox')[0]);
      await userEvent.click(await screen.findByRole('button', { name: 'Create Fleet Snapshot' }));

      const createBtn = () => screen.getByRole('button', { name: 'Create' });
      expect(createBtn()).toBeEnabled();

      await userEvent.click(screen.getByRole('radio', { name: 'Once' })); // no date chosen
      expect(createBtn()).toBeDisabled();

      await userEvent.click(screen.getByRole('radio', { name: 'Weekly' })); // no weekdays
      expect(createBtn()).toBeDisabled();

      await userEvent.click(screen.getByRole('radio', { name: 'Monthly' }));
      expect(createBtn()).toBeEnabled(); // day defaults to 1
      const dom = screen.getByLabelText('Day of month');
      await userEvent.clear(dom);
      await userEvent.type(dom, '0');
      expect(createBtn()).toBeDisabled();
      await userEvent.clear(dom);
      await userEvent.type(dom, '32');
      expect(createBtn()).toBeDisabled();
    });

    it('opens an existing simple cron in Simple mode without the one-time caveat', async () => {
      tasksFixture = [makeTask({ id: 5, name: 'daily-prune', cron_expression: '0 3 * * *', delete_after_run: 0 })];
      render(<ScheduledOperationsView />);

      await userEvent.click(await screen.findByRole('button', { name: /All tasks/ }));
      await userEvent.click(await screen.findByTitle('Edit'));

      expect(screen.getByRole('radio', { name: 'Simple' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByRole('radio', { name: 'Daily' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.queryByText(/one-time schedule fires on the chosen date/i)).not.toBeInTheDocument();
    });

    it('preserves the chosen year when editing a future-year one-shot without changing it', async () => {
      // The cron (0 23 1 7 *) is yearless; the persisted run_at carries the real
      // year. Editing and re-saving must send that year, not this year's occurrence.
      const runAt = new Date(new Date().getFullYear() + 1, 6, 1, 23, 0, 0, 0).getTime();
      tasksFixture = [makeTask({
        id: 7, name: 'once-next-year', cron_expression: '0 23 1 7 *',
        delete_after_run: 1, run_at: runAt, next_run_at: runAt,
      })];
      render(<ScheduledOperationsView />);

      await userEvent.click(await screen.findByRole('button', { name: /All tasks/ }));
      await userEvent.click(await screen.findByTitle('Edit'));
      await userEvent.click(screen.getByRole('button', { name: 'Update' }));

      await waitFor(() => {
        const putCall = mockedFetch.mock.calls.find(
          ([url, opts]) => url === '/scheduled-tasks/7' && opts?.method === 'PUT',
        );
        expect(putCall).toBeTruthy();
        expect(JSON.parse(putCall![1].body).run_at).toBe(runAt);
      });
    });

    it('opens a non-simple cron in Advanced mode', async () => {
      tasksFixture = [makeTask({ id: 6, name: 'every-15', cron_expression: '*/15 * * * *' })];
      render(<ScheduledOperationsView />);

      await userEvent.click(await screen.findByRole('button', { name: /All tasks/ }));
      await userEvent.click(await screen.findByTitle('Edit'));

      expect(screen.getByRole('radio', { name: 'Advanced' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByDisplayValue('*/15 * * * *')).toBeInTheDocument();
    });

    it('warns that switching Advanced -> Simple replaces a custom cron expression', async () => {
      render(<ScheduledOperationsView />);
      await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));

      await userEvent.click(screen.getByRole('radio', { name: 'Advanced' }));
      const input = screen.getByDisplayValue('0 3 * * *');
      await userEvent.clear(input);
      await userEvent.type(input, '*/15 * * * *');
      await userEvent.click(screen.getByRole('radio', { name: 'Simple' }));

      expect(screen.getByText(/Switching to Simple mode replaces your custom cron expression/i)).toBeInTheDocument();
      expect(screen.getByText(/0 3 \* \* \*/)).toBeInTheDocument();
    });

    it('saves the compiled cron from a non-default Simple schedule (weekly)', async () => {
      render(<ScheduledOperationsView />);
      await userEvent.click(await screen.findByRole('button', { name: /New Schedule/ }));
      await userEvent.type(await screen.findByPlaceholderText('e.g. Nightly stack restart'), 'weekly-snapshot');
      await userEvent.click(screen.getAllByRole('combobox')[0]);
      await userEvent.click(await screen.findByRole('button', { name: 'Create Fleet Snapshot' }));

      await userEvent.click(screen.getByRole('radio', { name: 'Weekly' }));
      await userEvent.click(screen.getByRole('checkbox', { name: 'Monday' }));
      await userEvent.click(screen.getByRole('checkbox', { name: 'Wednesday' }));

      await userEvent.click(screen.getByRole('button', { name: 'Create' }));

      await waitFor(() => {
        const postCall = mockedFetch.mock.calls.find(
          ([url, opts]) => url === '/scheduled-tasks' && opts?.method === 'POST',
        );
        expect(postCall).toBeTruthy();
        // Compiled from the weekday selection, not the legacy default literal.
        expect(JSON.parse(postCall![1].body).cron_expression).toBe('0 3 * * 1,3');
      });
    });
  });
});
