import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { FleetReadiness } from '../FleetReadiness';
import type {
  DomainState,
  FleetReadinessNode,
  FleetReadinessResponse,
  NodeDomainCell,
  ReadinessDomainKey,
  ReadinessReasonCode,
} from '@/types/readiness';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';

function healthyCell(): NodeDomainCell {
  return { state: 'healthy', reasonCode: null, counts: { running: 3 }, evidenceAgeMs: 1_000, source: 'live' };
}

function problemCell(
  reasonCode: ReadinessReasonCode,
  state: Exclude<DomainState, 'healthy'> = 'unavailable',
): NodeDomainCell {
  return { state, reasonCode, counts: {}, evidenceAgeMs: null, source: 'stored' };
}

function node(over: Partial<FleetReadinessNode> & { id: number; name: string }): FleetReadinessNode {
  return {
    type: 'remote',
    mode: 'proxy',
    transport: 'proxy',
    reachability: {
      status: 'online',
      contactAt: Date.now(),
      contactSource: 'last_successful_contact',
      note: 'Remote node can be probed directly',
      probedLive: true,
      latencyMs: 12,
    },
    cells: {},
    stackCount: 2,
    ...over,
  };
}

function response(over: Partial<FleetReadinessResponse> = {}): FleetReadinessResponse {
  return {
    generatedAt: Date.now(),
    domains: ['connectivity', 'workloads', 'updates', 'recovery', 'security', 'control'],
    domainsOmitted: [],
    summary: {
      nodes: { attention: 0, degraded: 0, unavailable: 0, unknown: 0, healthy: 1 },
      findings: { attention: 0, degraded: 0, unavailable: 0, unknown: 0 },
    },
    findings: [],
    nodes: [],
    ...over,
  };
}

function mockResponse(body: FleetReadinessResponse) {
  vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => body } as Response);
}

/** The body rows of the matrix, in payload order, once the read has landed. */
async function matrixRows(): Promise<HTMLElement[]> {
  await screen.findByRole('table');
  return screen.getAllByRole('row').slice(1);
}

describe('FleetReadiness', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('renders only the domains the payload carries, so a withheld domain is not a column', async () => {
    mockResponse(response({
      domains: ['connectivity', 'workloads', 'updates', 'recovery', 'security'],
      domainsOmitted: ['control'],
      nodes: [node({
        id: 1,
        name: 'Local',
        cells: {
          connectivity: healthyCell(),
          workloads: healthyCell(),
          updates: healthyCell(),
          recovery: healthyCell(),
          security: healthyCell(),
        },
      })],
    }));
    render(<FleetReadiness onOpenNodeDetails={vi.fn()} isAdmin />);

    expect(await screen.findByRole('columnheader', { name: /Connectivity/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Security/ })).toBeInTheDocument();
    // Control is withheld from this caller, so the row is never laid out for it.
    expect(screen.queryByRole('columnheader', { name: /Control/ })).toBeNull();
  });

  it('names the withheld domain rather than letting the visible ones speak for the fleet', async () => {
    mockResponse(response({
      domains: ['connectivity', 'updates'],
      domainsOmitted: ['control'],
      nodes: [node({
        id: 1,
        name: 'Local',
        cells: { connectivity: healthyCell(), updates: healthyCell() },
      })],
    }));
    render(<FleetReadiness onOpenNodeDetails={vi.fn()} isAdmin={false} />);

    // Every visible domain is healthy, so the headline says so. An operator
    // reading that as a statement about the whole fleet is the misread this
    // sentence exists to prevent: the domain they were not given is named.
    expect(await screen.findByText('All clear')).toBeInTheDocument();
    expect(screen.getByText('Not evaluated for this account: Control.')).toBeInTheDocument();
  });

  it('reads each row from its own cells, so a node without tier-2 evidence does not change its neighbour', async () => {
    mockResponse(response({
      domains: ['updates', 'recovery'],
      summary: {
        nodes: { attention: 0, degraded: 0, unavailable: 1, unknown: 0, healthy: 1 },
        findings: { attention: 0, degraded: 0, unavailable: 2, unknown: 0 },
      },
      nodes: [
        node({
          id: 1,
          name: 'Local',
          type: 'local',
          cells: { updates: healthyCell(), recovery: healthyCell() },
        }),
        node({
          id: 2,
          name: 'Edge',
          cells: {
            updates: problemCell('capability_absent'),
            recovery: problemCell('capability_absent'),
          },
        }),
      ],
    }));
    render(<FleetReadiness onOpenNodeDetails={vi.fn()} isAdmin />);

    const [localRow, edgeRow] = await matrixRows();
    // The node that answered renders live verdicts.
    expect(within(localRow).getAllByText('healthy')).toHaveLength(2);
    expect(within(localRow).queryByText('unavailable')).toBeNull();
    // The node that does not report them yet says so, in its own two columns.
    expect(within(edgeRow).getAllByText('unavailable')).toHaveLength(2);
    expect(within(edgeRow).queryByText('healthy')).toBeNull();
  });

  it('renders a domain the payload promised but the node did not report as unavailable, never healthy', async () => {
    mockResponse(response({
      domains: ['connectivity', 'workloads', 'security'],
      summary: {
        nodes: { attention: 0, degraded: 0, unavailable: 1, unknown: 0, healthy: 0 },
        findings: { attention: 0, degraded: 0, unavailable: 3, unknown: 0 },
      },
      nodes: [node({ id: 1, name: 'Edge', cells: {} })],
    }));
    render(<FleetReadiness onOpenNodeDetails={vi.fn()} isAdmin />);

    const [row] = await matrixRows();
    expect(within(row).getAllByText('unavailable')).toHaveLength(3);
    expect(within(row).queryByText('healthy')).toBeNull();
  });

  it('renders a domain or state word this build does not know instead of failing', async () => {
    // A hub newer than the bundle that is rendering it can add a column and a
    // state word. Neither table has an entry for them, and the surface still has
    // to show the row it was given rather than take the shell down with it.
    const futureDomain = 'drift' as ReadinessDomainKey;
    const futureCell = {
      state: 'drift',
      reasonCode: 'capability_absent',
      counts: {},
      evidenceAgeMs: null,
      source: 'live',
    } as unknown as NodeDomainCell;
    mockResponse(response({
      domains: ['updates', futureDomain],
      nodes: [node({
        id: 1,
        name: 'Local',
        cells: { updates: healthyCell(), [futureDomain]: futureCell },
      })],
    }));
    render(<FleetReadiness onOpenNodeDetails={vi.fn()} isAdmin />);

    // The unknown domain keeps its own column, under the hub's own word for it.
    expect(await screen.findByRole('columnheader', { name: /drift/ })).toBeInTheDocument();
    const [row] = await matrixRows();
    // The unknown state is not a quiet one: it reads as unknown, beside the
    // healthy neighbour it shares a row with.
    expect(within(row).getAllByText('unknown')).toHaveLength(1);
    expect(within(row).getAllByText('healthy')).toHaveLength(1);
  });

  it('headlines the fleet with its worst state and counts the nodes in that phrase', async () => {
    mockResponse(response({
      summary: {
        nodes: { attention: 2, degraded: 0, unavailable: 0, unknown: 0, healthy: 1 },
        findings: { attention: 2, degraded: 0, unavailable: 0, unknown: 0 },
      },
      nodes: [node({ id: 1, name: 'Local' }), node({ id: 2, name: 'Edge' }), node({ id: 3, name: 'Nas' })],
    }));
    render(<FleetReadiness onOpenNodeDetails={vi.fn()} isAdmin />);

    expect(await screen.findByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('2 nodes need attention · 1 healthy')).toBeInTheDocument();
  });

  it('shows the empty state rather than a board when the fleet has no nodes', async () => {
    mockResponse(response({ nodes: [] }));
    render(<FleetReadiness onOpenNodeDetails={vi.fn()} isAdmin />);

    expect(await screen.findByText('No nodes yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('surfaces a failed read instead of an empty board', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response);
    render(<FleetReadiness onOpenNodeDetails={vi.fn()} isAdmin />);

    expect(await screen.findByText('The readiness check could not be completed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });

  it('repeats the reason the server gave for refusing the read', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Permission denied.', code: 'PERMISSION_DENIED' }),
    } as Response);
    render(<FleetReadiness onOpenNodeDetails={vi.fn()} isAdmin />);

    // The server's sentence is what distinguishes a refusal from a fault, and
    // only one of the two is worth offering a retry for.
    expect(await screen.findByText('Permission denied.')).toBeInTheDocument();
    expect(screen.queryByText('The readiness check could not be completed.')).toBeNull();
  });

  it('falls back to its own sentence when the failure body is unreadable', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => { throw new Error('not JSON'); },
    } as unknown as Response);
    render(<FleetReadiness onOpenNodeDetails={vi.fn()} isAdmin />);

    // An intermediary can answer with something that is not the route's JSON,
    // and a board that renders nothing at all would be worse than the generic
    // sentence.
    expect(await screen.findByText('The readiness check could not be completed.')).toBeInTheDocument();
  });
});
