import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FleetNodeOverview } from '../useFleetHeartbeat';

const useFleetHeartbeatMock = vi.fn();
vi.mock('../useFleetHeartbeat', () => ({
  useFleetHeartbeat: () => useFleetHeartbeatMock(),
}));

const useMeshDataPlaneMock = vi.fn();
vi.mock('../useMeshDataPlane', () => ({
  useMeshDataPlane: () => useMeshDataPlaneMock(),
}));

vi.mock('@/components/fleet/MeshDataPlaneBanner', () => ({
  MeshDataPlaneBanner: () => <div data-testid="mesh-banner" />,
}));

import { FleetHeartbeat } from '../FleetHeartbeat';

function overviewNode(overrides: Partial<FleetNodeOverview> = {}): FleetNodeOverview {
  return {
    id: 1,
    name: 'node',
    type: 'remote',
    status: 'online',
    stats: null,
    ...overrides,
  };
}

function renderHeartbeat(nodes: FleetNodeOverview[], loading = false, error: string | null = null) {
  useFleetHeartbeatMock.mockReturnValue({ nodes, loading, error });
  return render(<FleetHeartbeat onOpenNode={vi.fn()} />);
}

/** Rendered row labels, taken from the DOM rather than from the hook's array. */
function rowLabels(): string[] {
  return Array.from(document.querySelectorAll('button[aria-label^="Open "]'))
    .map(el => el.getAttribute('aria-label')!);
}

/** Row names only; the label also carries the node's status. */
function rowOrder(): string[] {
  return rowLabels().map(label => label.replace(/^Open /, '').replace(/ \(.+\) in Fleet$/, ''));
}

beforeEach(() => {
  useFleetHeartbeatMock.mockReset();
  useMeshDataPlaneMock.mockReset();
  useMeshDataPlaneMock.mockReturnValue({ status: null });
});

describe('FleetHeartbeat header', () => {
  it('names each problem state separately instead of calling them all unreachable', () => {
    renderHeartbeat([
      overviewNode({ id: 1, name: 'edge-a', status: 'online' }),
      overviewNode({ id: 2, name: 'edge-b', status: 'offline' }),
      overviewNode({ id: 3, name: 'edge-c', status: 'unknown' }),
    ]);

    const header = screen.getByText(/3 nodes/);
    expect(header.textContent).toContain('1 offline');
    expect(header.textContent).toContain('1 unknown');
    expect(header.textContent).not.toContain('unreachable');
  });

  it('omits the problem clauses when every node is online', () => {
    renderHeartbeat([
      overviewNode({ id: 1, name: 'edge-a', status: 'online' }),
      overviewNode({ id: 2, name: 'edge-b', status: 'online' }),
    ]);

    const header = screen.getByText(/2 nodes/);
    expect(header.textContent).not.toContain('offline');
    expect(header.textContent).not.toContain('unknown');
  });

  it('counts a single unknown node without claiming it is offline', () => {
    renderHeartbeat([overviewNode({ id: 1, name: 'edge-a', status: 'unknown' })]);

    const header = screen.getByText(/1 node/);
    expect(header.textContent).toContain('1 unknown');
    expect(header.textContent).not.toContain('offline');
  });
});

describe('FleetHeartbeat row order', () => {
  it('orders offline, then unknown, then online remotes, then local, by name within a band', () => {
    renderHeartbeat([
      overviewNode({ id: 1, name: 'mid', status: 'online', type: 'remote' }),
      overviewNode({ id: 2, name: 'zeta-off', status: 'offline', type: 'remote' }),
      overviewNode({ id: 3, name: 'local', status: 'online', type: 'local' }),
      overviewNode({ id: 4, name: 'alpha-off', status: 'offline', type: 'remote' }),
      overviewNode({ id: 5, name: 'beta-unk', status: 'unknown', type: 'remote' }),
    ]);

    // A node we failed to reach outranks one we could not classify, and the
    // local node, the one already on screen, comes last.
    expect(rowOrder()).toEqual(['alpha-off', 'zeta-off', 'beta-unk', 'mid', 'local']);
  });

  it('keeps the order stable across polls', () => {
    const nodes = [
      overviewNode({ id: 1, name: 'beta', status: 'unknown', type: 'remote' }),
      overviewNode({ id: 2, name: 'alpha', status: 'unknown', type: 'remote' }),
    ];
    const first = renderHeartbeat(nodes);
    const firstOrder = rowOrder();
    first.unmount();

    renderHeartbeat([...nodes].reverse());
    expect(rowOrder()).toEqual(firstOrder);
  });
});

describe('FleetHeartbeat rows', () => {
  it('reports the clicked node id', () => {
    const onOpenNode = vi.fn();
    useFleetHeartbeatMock.mockReturnValue({
      nodes: [overviewNode({ id: 42, name: 'edge-a' })],
      loading: false,
      error: null,
    });
    render(<FleetHeartbeat onOpenNode={onOpenNode} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open edge-a (online) in Fleet' }));
    expect(onOpenNode).toHaveBeenCalledWith(42);
  });

  it('carries the node status in the accessible name', () => {
    // The status dot is decorative, so the label is the only place a screen
    // reader learns whether a row is worth opening.
    renderHeartbeat([
      overviewNode({ id: 2, name: 'edge-b', status: 'offline' }),
      overviewNode({ id: 3, name: 'edge-c', status: 'unknown' }),
    ]);

    expect(rowLabels()).toEqual([
      'Open edge-b (offline) in Fleet',
      'Open edge-c (unknown) in Fleet',
    ]);
  });

  it('renders an empty state when no node is registered', () => {
    renderHeartbeat([]);
    expect(screen.getByText('No nodes registered.')).toBeDefined();
  });

  it('opens a node from the keyboard, once per press', async () => {
    const user = userEvent.setup();
    const onOpenNode = vi.fn();
    useFleetHeartbeatMock.mockReturnValue({ nodes: [overviewNode({ id: 7, name: 'edge-a' })], loading: false, error: null });
    render(<FleetHeartbeat onOpenNode={onOpenNode} />);

    screen.getByRole('button', { name: 'Open edge-a (online) in Fleet' }).focus();
    await user.keyboard(' ');
    expect(onOpenNode).toHaveBeenCalledTimes(1);
    expect(onOpenNode).toHaveBeenCalledWith(7);
  });

  it('keeps the table semantics: rows stay rows and cells keep their headers', () => {
    renderHeartbeat([overviewNode({ id: 1, name: 'edge-a' })]);
    expect(screen.getAllByRole('row')).toHaveLength(2);
    expect(screen.getByRole('columnheader', { name: 'Node' })).toBeInTheDocument();
  });

  it('shows latency while a node answers and how long it has been silent once it stops', () => {
    renderHeartbeat([
      overviewNode({ id: 1, name: 'edge-a', status: 'online', latency_ms: 42 }),
      overviewNode({ id: 2, name: 'edge-b', status: 'offline', last_successful_contact: null }),
      overviewNode({ id: 3, name: 'edge-c', status: 'online', mode: 'pilot_agent' }),
    ]);

    expect(screen.getByText('42 ms')).toBeInTheDocument();
    expect(screen.getByText('never reached')).toBeInTheDocument();
    expect(screen.getByText('tunnel')).toBeInTheDocument();
  });

  it('keeps the last answer on screen and marks it stale when a later poll fails', () => {
    renderHeartbeat([overviewNode({ id: 1, name: 'edge-a' })], false, 'Failed to load fleet overview');

    expect(rowOrder()).toEqual(['edge-a']);
    expect(screen.getByText(/^1 node/).textContent).toContain('stale');
    expect(screen.getByText(/could not be refreshed \(Failed to load fleet overview\)/)).toBeInTheDocument();
  });

  it('keeps a mesh failure in the header and the body', () => {
    useMeshDataPlaneMock.mockReturnValue({ status: { ok: false, reason: 'sidecar_down' } });
    renderHeartbeat([overviewNode({ id: 1, name: 'edge-a' })]);

    expect(screen.getByText(/1 node/).textContent).toContain('mesh down');
    expect(screen.getByTestId('mesh-banner')).toBeInTheDocument();
  });

  it('renders the error state without any rows', () => {
    renderHeartbeat([], false, 'Failed to load fleet overview');
    expect(screen.getByText('Unable to load fleet status.')).toBeDefined();
    expect(rowOrder()).toEqual([]);
  });
});
