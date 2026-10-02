/**
 * The desktop Update page lists pending updates as a sortable table by default,
 * with the node-grouped card board as the alternative. Row detail (changelog,
 * blocked reason, per-service Apply) lives in an expandable row.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, within, fireEvent } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), fetchForNode: vi.fn() }));
vi.mock('@/lib/serviceUpdate', () => ({ requestServiceUpdate: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@/hooks/use-is-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
vi.mock('@/context/DeployFeedbackContext', () => ({
  useDeployFeedback: () => ({
    runWithLog: async (_params: unknown, fn: (started: Promise<void>, ds: string) => Promise<unknown>) =>
      fn(Promise.resolve(), 'test-session'),
  }),
}));
const mockNodeMeta = new Map<number, { capabilities: string[] }>();
const mockRefreshNodeMeta = vi.fn();
const mockNodes: { id: number; name: string; type: 'local' | 'remote'; status: string }[] = [
  { id: 1, name: 'Local', type: 'local', status: 'online' },
];
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ nodes: mockNodes, nodeMeta: mockNodeMeta, refreshNodeMeta: mockRefreshNodeMeta }),
}));

import { apiFetch, fetchForNode } from '@/lib/api';
import { requestServiceUpdate } from '@/lib/serviceUpdate';
import { SERVICE_SCOPED_UPDATE_CAPABILITY } from '@/lib/capabilities';
import AutoUpdateReadinessView from '../AutoUpdateReadinessView';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedFetchForNode = fetchForNode as unknown as ReturnType<typeof vi.fn>;

interface PreviewOpts {
  bump?: 'patch' | 'minor' | 'major';
  blocked?: boolean;
  blockedReason?: string | null;
  changelog?: string | null;
  images?: { service: string; has_update: boolean }[];
}

function preview(stack: string, opts: PreviewOpts = {}) {
  const bump = opts.bump ?? 'patch';
  const images = opts.images ?? [{ service: 'app', has_update: true }];
  return {
    stack_name: stack,
    images: images.map(i => ({
      service: i.service, image: `${stack}:1.0`, current_tag: '1.0', next_tag: '1.1',
      has_update: i.has_update, digest_update: true, tag_update: false, semver_bump: bump, check_status: 'ok',
    })),
    summary: {
      has_update: true,
      primary_image: `${stack}:1.0`,
      current_tag: '1.0',
      next_tag: '1.1',
      semver_bump: bump,
      update_kind: 'digest',
      blocked: opts.blocked ?? false,
      blocked_reason: opts.blockedReason ?? null,
      check_status: 'ok',
    },
    rollback_target: null,
    changelog: opts.changelog ?? null,
  };
}

function seed(fleet: Record<string, Record<string, boolean>>, previews: Record<string, unknown>, tasks: unknown[] = []) {
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/image-updates/fleet') return Promise.resolve({ ok: true, json: async () => fleet });
    if (url.startsWith('/scheduled-tasks')) return Promise.resolve({ ok: true, json: async () => tasks });
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
  mockedFetchForNode.mockImplementation(async (path: string) => {
    const stack = decodeURIComponent(/\/stacks\/([^/?]+)/.exec(path)?.[1] ?? '');
    return { ok: true, status: 200, json: async () => previews[stack] };
  });
}

afterEach(() => {
  localStorage.clear();
  mockedFetch.mockReset();
  mockedFetchForNode.mockReset();
  mockNodeMeta.clear();
  vi.mocked(requestServiceUpdate).mockReset();
  mockNodes.splice(0, mockNodes.length, { id: 1, name: 'Local', type: 'local', status: 'online' });
});

const bodyRows = () => screen.getAllByTestId('readiness-row');
const stackOrder = () => screen.getAllByTestId('readiness-stack').map(el => el.textContent);
const rowFor = (stack: string) => bodyRows().find(r => within(r).getByTestId('readiness-stack').textContent === stack)!;

describe('AutoUpdateReadinessView table view', () => {
  it('renders the table by default and lists one row per stack across nodes', async () => {
    mockNodes.push({ id: 2, name: 'Edge', type: 'remote', status: 'online' });
    seed(
      { '1': { alpha: true }, '2': { beta: true } },
      { alpha: preview('alpha'), beta: preview('beta') },
    );
    render(<AutoUpdateReadinessView />);

    expect(await screen.findByTestId('readiness-table')).toBeInTheDocument();
    expect(stackOrder()).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Table' })).toBeChecked();
    const rowText = bodyRows().map(r => r.textContent ?? '').join('|');
    expect(rowText).toContain('Local');
    expect(rowText).toContain('Edge');
  });

  it('orders by risk severity first, and re-sorts by stack when the header is clicked', async () => {
    seed(
      { '1': { alpha: true, bravo: true, charlie: true } },
      {
        alpha: preview('alpha', { bump: 'patch' }),
        bravo: preview('bravo', { bump: 'major', blocked: true, blockedReason: 'Major bump held' }),
        charlie: preview('charlie', { bump: 'minor' }),
      },
    );
    render(<AutoUpdateReadinessView />);
    await screen.findByTestId('readiness-table');

    expect(stackOrder()).toEqual(['bravo', 'charlie', 'alpha']);

    const stackHeader = screen.getByRole('button', { name: 'Stack' });
    fireEvent.click(stackHeader);
    expect(stackOrder()).toEqual(['alpha', 'bravo', 'charlie']);
    fireEvent.click(stackHeader);
    expect(stackOrder()).toEqual(['charlie', 'bravo', 'alpha']);
  });

  it('applies a whole stack from its row and disables Apply for a blocked update with the reason as title', async () => {
    seed(
      { '1': { safe: true, held: true } },
      {
        safe: preview('safe'),
        held: preview('held', { bump: 'major', blocked: true, blockedReason: 'Major bump held' }),
      },
    );
    render(<AutoUpdateReadinessView />);
    await screen.findByTestId('readiness-table');

    const heldRow = rowFor('held');
    const safeRow = rowFor('safe');
    expect(within(heldRow).getByText(/Blocked · major/i)).toBeInTheDocument();
    expect(within(safeRow).getByText(/Safe · patch/i)).toBeInTheDocument();
    const heldApply = within(heldRow).getByRole('button', { name: /Apply now/i });
    expect(heldApply).toBeDisabled();
    expect(heldApply).toHaveAttribute('title', 'Major bump held');
    const safeApply = within(safeRow).getByRole('button', { name: /Apply now/i });
    expect(safeApply).toBeEnabled();

    await act(async () => { fireEvent.click(safeApply); });
    expect(mockedFetchForNode).toHaveBeenCalledWith(
      expect.stringMatching(/\/stacks\/safe\/update/),
      1,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('keeps changelog and per-service Apply in an expandable row', async () => {
    mockNodeMeta.set(1, { capabilities: [SERVICE_SCOPED_UPDATE_CAPABILITY] });
    seed(
      { '1': { multi: true } },
      {
        multi: preview('multi', {
          changelog: 'Release notes for multi.',
          images: [{ service: 'web', has_update: true }, { service: 'worker', has_update: true }],
        }),
      },
    );
    render(<AutoUpdateReadinessView />);
    await screen.findByTestId('readiness-table');

    expect(screen.queryByTestId('readiness-row-detail')).toBeNull();
    expect(screen.queryByText('Release notes for multi.')).toBeNull();

    const toggle = screen.getByRole('button', { name: 'Show details for multi' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await act(async () => { fireEvent.click(toggle); });

    expect(screen.getByRole('button', { name: 'Hide details for multi' })).toHaveAttribute('aria-expanded', 'true');
    const detail = screen.getByTestId('readiness-row-detail');
    expect(within(detail).getByText('Release notes for multi.')).toBeInTheDocument();
    const serviceButtons = within(detail).getAllByRole('button', { name: /^Apply$/ });
    expect(serviceButtons).toHaveLength(2);

    vi.mocked(requestServiceUpdate).mockResolvedValue({
      ok: true, mode: 'update', serviceName: 'web', healthGateId: null,
      observing: false, recoveryId: null, recoveryAvailable: false,
    });
    await act(async () => { fireEvent.click(serviceButtons[0]); });
    expect(requestServiceUpdate).toHaveBeenCalledWith(expect.objectContaining({ stackName: 'multi', serviceName: 'web' }));
  });

  it('shows no per-service Apply for a single-service stack', async () => {
    mockNodeMeta.set(1, { capabilities: [SERVICE_SCOPED_UPDATE_CAPABILITY] });
    seed({ '1': { solo: true } }, { solo: preview('solo', { changelog: 'Solo notes.' }) });
    render(<AutoUpdateReadinessView />);
    await screen.findByTestId('readiness-table');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Show details for solo' })); });
    const detail = screen.getByTestId('readiness-row-detail');
    expect(within(detail).getByText('Solo notes.')).toBeInTheDocument();
    expect(within(detail).queryByRole('button', { name: /^Apply$/ })).toBeNull();
  });

  it('shows the next run per row, marks stacks without a covering schedule, and sorts by schedule in both directions', async () => {
    const now = Date.now();
    const task = (id: number, stack: string, offsetMs: number) => ({
      id, enabled: true, action: 'update', target_type: 'stack', target_id: stack, node_id: 1, next_run_at: now + offsetMs,
    });
    seed(
      { '1': { soon: true, later: true, unscheduled: true } },
      { soon: preview('soon'), later: preview('later'), unscheduled: preview('unscheduled') },
      [task(1, 'soon', 60 * 60_000), task(2, 'later', 5 * 60 * 60_000)],
    );
    render(<AutoUpdateReadinessView />);
    await screen.findByTestId('readiness-table');

    expect(within(rowFor('soon')).getByText(/in 1h/)).toBeInTheDocument();
    expect(within(rowFor('unscheduled')).getByText(/Auto: Off/)).toBeInTheDocument();
    expect(within(rowFor('soon')).queryByText(/Auto: Off/)).toBeNull();

    const header = screen.getByRole('button', { name: 'Schedule' });
    fireEvent.click(header);
    expect(stackOrder()).toEqual(['soon', 'later', 'unscheduled']);
    fireEvent.click(header);
    expect(stackOrder()).toEqual(['unscheduled', 'later', 'soon']);
  });

  it('sorts by node name', async () => {
    mockNodes.push({ id: 2, name: 'Alpha', type: 'remote', status: 'online' });
    seed({ '1': { one: true }, '2': { two: true } }, { one: preview('one'), two: preview('two') });
    render(<AutoUpdateReadinessView />);
    await screen.findByTestId('readiness-table');

    fireEvent.click(screen.getByRole('button', { name: 'Node' }));
    expect(stackOrder()).toEqual(['two', 'one']);
    fireEvent.click(screen.getByRole('button', { name: 'Node' }));
    expect(stackOrder()).toEqual(['one', 'two']);
  });

  it('shows a checking row without Apply, details toggle, or risk badge while a preview is loading', async () => {
    seed({ '1': { slow: true } }, { slow: preview('slow') });
    let release: (v: unknown) => void = () => {};
    mockedFetchForNode.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    render(<AutoUpdateReadinessView />);

    expect(await screen.findByText('Checking registry...')).toBeInTheDocument();
    const row = rowFor('slow');
    expect(within(row).queryByRole('button')).toBeNull();
    expect(within(row).queryByText(/Safe|Review|Blocked/i)).toBeNull();

    await act(async () => { release({ ok: true, status: 200, json: async () => preview('slow') }); });
    expect(await screen.findByRole('button', { name: /Apply now/i })).toBeInTheDocument();
  });

  it('holds full-stack Apply for review when another image failed verification, and explains it in the row', async () => {
    mockNodeMeta.set(1, { capabilities: [SERVICE_SCOPED_UPDATE_CAPABILITY] });
    const mixed = preview('mixed', { images: [{ service: 'confirmed', has_update: true }] });
    mixed.images.push({
      service: 'failing', image: 'private.example/db:latest', current_tag: 'latest', next_tag: null as unknown as string,
      has_update: false, digest_update: false, tag_update: false, semver_bump: 'none' as 'patch', check_status: 'ok',
      digest_error: 'Registry unreachable',
    } as (typeof mixed.images)[number]);
    Object.assign(mixed.summary, { verification_failed: true, verification_error: 'Registry unreachable' });
    seed({ '1': { mixed: true } }, { mixed });
    render(<AutoUpdateReadinessView />);
    await screen.findByTestId('readiness-table');

    const row = rowFor('mixed');
    expect(within(row).getByText(/Review · unverified/i)).toBeInTheDocument();
    const applyBtn = within(row).getByRole('button', { name: /Apply now/i });
    expect(applyBtn).toBeDisabled();
    expect(applyBtn).toHaveAttribute('title', expect.stringMatching(/Another image in this stack failed digest verification/));

    await act(async () => { fireEvent.click(within(row).getByRole('button', { name: 'Show details for mixed' })); });
    expect(screen.getByTestId('readiness-verification-warning')).toHaveTextContent('Registry unreachable');
  });

  it('collapses an expanded row and shows the changelog fallback when the registry has none', async () => {
    seed({ '1': { bare: true } }, { bare: preview('bare', { changelog: null }) });
    render(<AutoUpdateReadinessView />);
    await screen.findByTestId('readiness-table');

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Show details for bare' })); });
    expect(screen.getByText('No changelog available from the registry yet.')).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Hide details for bare' })); });
    expect(screen.queryByTestId('readiness-row-detail')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show details for bare' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows a distinct failed state, without Apply or a detail toggle, when the preview fetch fails', async () => {
    seed({ '1': { broken: true } }, {});
    mockedFetchForNode.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    render(<AutoUpdateReadinessView />);

    expect(await screen.findByText(/Preview failed\. Registry may be unreachable\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apply now/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /details for broken/i })).toBeNull();
  });

  it('switches to the card board, persists the choice, and restores it on remount', async () => {
    seed({ '1': { alpha: true } }, { alpha: preview('alpha') });
    const { unmount } = render(<AutoUpdateReadinessView />);
    await screen.findByTestId('readiness-table');

    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'Cards' })); });
    expect(screen.queryByTestId('readiness-table')).toBeNull();
    expect(screen.getByRole('button', { name: /Apply now/i })).toBeInTheDocument();
    expect(localStorage.getItem('sencho-readiness-view')).toBe('cards');
    unmount();

    render(<AutoUpdateReadinessView />);
    expect(await screen.findByRole('button', { name: /Apply now/i })).toBeInTheDocument();
    expect(screen.queryByTestId('readiness-table')).toBeNull();
    expect(screen.getByRole('radio', { name: 'Cards' })).toBeChecked();
  });

  it('hides the view toggle when there is nothing to list', async () => {
    seed({ '1': {} }, {});
    render(<AutoUpdateReadinessView />);

    expect(await screen.findByText('All stacks on current builds')).toBeInTheDocument();
    expect(screen.queryByRole('radiogroup', { name: 'Update view' })).toBeNull();
  });
});
