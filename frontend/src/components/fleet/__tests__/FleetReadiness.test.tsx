import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { FleetReadiness } from '../FleetReadiness';
import { EMPTY_FINDINGS_FILTER, filterFindings } from '../readiness/findingsFilter';
import { SENCHO_OPEN_STACK_EVENT } from '@/lib/events';
import type {
  DomainState,
  FleetReadinessNode,
  FleetReadinessResponse,
  NodeDomainCell,
  ReadinessDomainKey,
  ReadinessFinding,
  ReadinessReasonCode,
} from '@/types/readiness';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@/lib/api';

function healthyCell(counts: Record<string, number> = {}): NodeDomainCell {
  return { state: 'healthy', reasonCode: null, counts, evidenceAgeMs: 1_000, source: 'live' };
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
      note: 'Proxy contact fresh (cached)',
      probedLive: true,
      latencyMs: 12,
    },
    state: 'healthy',
    cells: {},
    stackCount: 2,
    ...over,
  };
}

function finding(over: Partial<ReadinessFinding> & { id: string; code: ReadinessReasonCode }): ReadinessFinding {
  return {
    domain: 'updates',
    nodeId: 2,
    stack: null,
    severity: 'attention',
    count: 1,
    verdict: null,
    detail: null,
    target: { surface: 'node-details', nodeId: 2 },
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

function okResponse(body: FleetReadinessResponse): Response {
  return { ok: true, json: async () => body } as Response;
}

function mockResponse(body: FleetReadinessResponse) {
  vi.mocked(apiFetch).mockResolvedValue(okResponse(body));
}

/** The body rows of the node matrix, once the read has landed. */
async function matrixRows(): Promise<HTMLElement[]> {
  const section = await screen.findByRole('region', { name: 'Readiness by node' });
  return within(section).getAllByRole('row').slice(1);
}

/** The body rows of the findings table. */
function findingRows(): HTMLElement[] {
  const section = screen.getByRole('region', { name: 'Readiness findings' });
  return within(section).getAllByRole('row').slice(1);
}

function renderReadiness(props: Partial<Parameters<typeof FleetReadiness>[0]> = {}) {
  return render(
    <FleetReadiness refreshKey={0} onOpenNodeDetails={vi.fn()} onOpenNodeSecurity={vi.fn()} isAdmin {...props} />,
  );
}

describe('FleetReadiness', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the shared Fleet tab heading', async () => {
    mockResponse(response({ nodes: [node({ id: 1, name: 'Local', type: 'local', transport: 'local' })] }));
    renderReadiness();
    expect(await screen.findByRole('heading', { name: 'Fleet Readiness' })).toBeInTheDocument();
  });

  it('renders only the domains the payload carries, and names the withheld one', async () => {
    mockResponse(response({
      domains: ['connectivity', 'updates'],
      domainsOmitted: ['control'],
      nodes: [node({ id: 1, name: 'Local', cells: { connectivity: healthyCell(), updates: healthyCell() } })],
    }));
    renderReadiness({ isAdmin: false });

    expect(await screen.findByRole('columnheader', { name: /Connectivity/ })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: /Policy sync/ })).toBeNull();
    expect(screen.getByText('All clear')).toBeInTheDocument();
    expect(screen.getByText('Not evaluated for this account: Policy sync.')).toBeInTheDocument();
  });

  it('shows each healthy cell in its own domain words rather than a generic state', async () => {
    mockResponse(response({
      nodes: [node({
        id: 1,
        name: 'Edge',
        cells: {
          connectivity: healthyCell(),
          workloads: healthyCell({ running: 3 }),
          updates: healthyCell(),
          recovery: healthyCell(),
          security: healthyCell(),
          control: healthyCell({ resources: 2 }),
        },
      })],
    }));
    renderReadiness();

    const [row] = await matrixRows();
    for (const value of ['online', '3 running', 'ready', 'covered', 'clear', 'in sync']) {
      expect(within(row).getByText(value)).toBeInTheDocument();
    }
    expect(within(row).queryByText('healthy')).toBeNull();
  });

  it('names a problem cell by its reason, counting the items behind it', async () => {
    mockResponse(response({
      domains: ['connectivity', 'updates', 'security'],
      summary: {
        nodes: { attention: 1, degraded: 0, unavailable: 0, unknown: 0, healthy: 0 },
        findings: { attention: 2, degraded: 0, unavailable: 0, unknown: 1 },
      },
      findings: [
        finding({ id: 'u:2:a', code: 'update_blocked', stack: 'a' }),
        finding({ id: 'u:2:b', code: 'update_blocked', stack: 'b' }),
        finding({ id: 's:2', code: 'scans_never_completed', domain: 'security', severity: 'unknown' }),
      ],
      nodes: [node({
        id: 2,
        name: 'Edge',
        state: 'attention',
        cells: {
          connectivity: problemCell('node_unreachable', 'attention'),
          updates: problemCell('update_blocked', 'attention'),
          security: problemCell('scans_never_completed', 'unknown'),
        },
      })],
    }));
    renderReadiness();

    const [row] = await matrixRows();
    expect(within(row).getByText('offline')).toBeInTheDocument();
    expect(within(row).getByText('2 blocked')).toBeInTheDocument();
    expect(within(row).getByText('never scanned')).toBeInTheDocument();
    expect(within(row).queryByText('unknown')).toBeNull();
  });

  it('renders a domain that does not apply to a node as not applicable, never as a gap', async () => {
    mockResponse(response({
      domains: ['connectivity', 'control'],
      nodes: [node({ id: 1, name: 'Local', type: 'local', transport: 'local', cells: { connectivity: healthyCell() } })],
    }));
    renderReadiness();

    const [row] = await matrixRows();
    expect(within(row).getByText('local')).toBeInTheDocument();
    expect(within(row).getByTitle('Does not apply to this node')).toHaveTextContent('--');
  });

  it('renders a domain or state word this build does not know instead of failing', async () => {
    const futureDomain = 'drift' as ReadinessDomainKey;
    const futureCell = {
      state: 'drift',
      reasonCode: 'drift_detected',
      counts: {},
      evidenceAgeMs: null,
      source: 'live',
    } as unknown as NodeDomainCell;
    mockResponse(response({
      domains: ['updates', futureDomain],
      nodes: [node({ id: 1, name: 'Local', cells: { updates: healthyCell(), [futureDomain]: futureCell } })],
    }));
    renderReadiness();

    expect(await screen.findByRole('columnheader', { name: /drift/ })).toBeInTheDocument();
    const [row] = await matrixRows();
    // The unrecognized state is not a quiet one: it reads as unverified.
    expect(within(row).getByText('unverified')).toBeInTheDocument();
    expect(within(row).getByText('ready')).toBeInTheDocument();
  });

  it('headlines the fleet with its worst state and summarizes the node counts', async () => {
    mockResponse(response({
      summary: {
        nodes: { attention: 2, degraded: 0, unavailable: 0, unknown: 1, healthy: 1 },
        findings: { attention: 2, degraded: 0, unavailable: 0, unknown: 0 },
      },
      nodes: [node({ id: 1, name: 'A' }), node({ id: 2, name: 'B' }), node({ id: 3, name: 'C' }), node({ id: 4, name: 'D' })],
    }));
    renderReadiness();

    expect(await screen.findByText('Needs attention')).toBeInTheDocument();
    expect(screen.getByText('3 of 4 nodes have something to review.')).toBeInTheDocument();
  });

  it('routes a stack finding to that stack on its own node', async () => {
    mockResponse(response({
      findings: [finding({
        id: 'u:2:web:update_blocked',
        code: 'update_blocked',
        stack: 'web',
        verdict: { kind: 'update', value: 'blocked' },
        detail: 'Image digest is pinned by policy',
        target: { surface: 'stack', nodeId: 2, stackName: 'web' },
      })],
      nodes: [node({ id: 2, name: 'Edge', state: 'attention', cells: { updates: problemCell('update_blocked', 'attention') } })],
    }));
    const opened = vi.fn();
    window.addEventListener(SENCHO_OPEN_STACK_EVENT, opened);
    renderReadiness();

    await screen.findByText('Update is blocked');
    const [row] = findingRows();
    expect(within(row).getByText('Image digest is pinned by policy')).toBeInTheDocument();
    expect(within(row).getByText('update blocked')).toBeInTheDocument();
    fireEvent.click(within(row).getByRole('button', { name: /Open stack/ }));
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ nodeId: 2, stackName: 'web' });
    window.removeEventListener(SENCHO_OPEN_STACK_EVENT, opened);
  });

  it('opens Security on the node the finding is about', async () => {
    mockResponse(response({
      findings: [finding({
        id: 'security:2:scanner_unavailable',
        domain: 'security',
        code: 'scanner_unavailable',
        severity: 'unknown',
        target: { surface: 'security', tab: 'scanner' },
      })],
      nodes: [node({ id: 2, name: 'Edge', cells: { security: problemCell('scanner_unavailable', 'unknown') } })],
    }));
    const onOpenNodeSecurity = vi.fn();
    renderReadiness({ onOpenNodeSecurity });

    await screen.findByText('Security scanner is unavailable');
    fireEvent.click(within(findingRows()[0]).getByRole('button', { name: /Security/ }));
    expect(onOpenNodeSecurity).toHaveBeenCalledWith(2, 'scanner');
  });

  it('withholds the snapshots shortcut from an account that cannot open Snapshots', async () => {
    mockResponse(response({
      findings: [finding({
        id: 'recovery:2:snapshot_failed',
        domain: 'recovery',
        code: 'snapshot_failed',
        severity: 'degraded',
        target: { surface: 'fleet-snapshots' },
      })],
      nodes: [node({ id: 2, name: 'Edge', cells: { recovery: problemCell('snapshot_failed', 'degraded') } })],
    }));
    renderReadiness({ isAdmin: false });

    await screen.findByText('The latest fleet snapshot skipped this node');
    expect(within(findingRows()[0]).queryByRole('button', { name: /Snapshots/ })).toBeNull();
  });

  it('narrows the findings to one node and domain when a problem cell is clicked', async () => {
    mockResponse(response({
      domains: ['updates', 'security'],
      findings: [
        finding({ id: 'u:2:a', code: 'update_blocked', stack: 'a' }),
        finding({ id: 's:2', code: 'scans_never_completed', domain: 'security', severity: 'unknown' }),
      ],
      nodes: [node({
        id: 2,
        name: 'Edge',
        state: 'attention',
        cells: {
          updates: problemCell('update_blocked', 'attention'),
          security: problemCell('scans_never_completed', 'unknown'),
        },
      })],
    }));
    renderReadiness();

    const [row] = await matrixRows();
    expect(findingRows()).toHaveLength(2);
    fireEvent.click(within(row).getByRole('button', { name: '1 blocked' }));
    expect(findingRows()).toHaveLength(1);
    expect(screen.getByText('Update is blocked')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(findingRows()).toHaveLength(2);
  });

  it('narrows to the node when a clicked cell has no findings of its own', async () => {
    // An unreachable node's gated cells say "timed out", but the hub names the
    // cause once, on Connectivity, so those cells carry no findings.
    mockResponse(response({
      domains: ['connectivity', 'workloads'],
      findings: [
        finding({ id: 'connectivity:2:probe_timeout', domain: 'connectivity', code: 'probe_timeout' }),
        finding({ id: 'updates:3:x', code: 'update_blocked', nodeId: 3, stack: 'x' }),
      ],
      nodes: [
        node({
          id: 2,
          name: 'Edge',
          state: 'attention',
          cells: {
            connectivity: problemCell('probe_timeout', 'attention'),
            workloads: problemCell('probe_timeout'),
          },
        }),
        node({ id: 3, name: 'Nas', cells: { connectivity: healthyCell(), workloads: healthyCell({ running: 1 }) } }),
      ],
    }));
    renderReadiness();

    const [edgeRow] = await matrixRows();
    fireEvent.click(within(edgeRow).getAllByRole('button', { name: 'timed out' })[1]);
    const rows = findingRows();
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText('Node did not answer in time')).toBeInTheDocument();
  });

  it('reads a promised domain the row did not deliver as a gap, never as not applicable', async () => {
    mockResponse(response({
      domains: ['connectivity', 'workloads'],
      nodes: [node({ id: 1, name: 'Edge', cells: { connectivity: healthyCell() } })],
    }));
    renderReadiness();

    const [row] = await matrixRows();
    expect(within(row).getByText('not reported')).toBeInTheDocument();
    expect(within(row).queryByTitle('Does not apply to this node')).toBeNull();
  });

  it('recovers from a failed first read when Try again succeeds', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response)
      .mockResolvedValueOnce(okResponse(response({ nodes: [node({ id: 1, name: 'Edge', cells: { updates: healthyCell() } })] })));
    renderReadiness();

    fireEvent.click(await screen.findByRole('button', { name: /Try again/ }));
    expect(await matrixRows()).toHaveLength(1);
    expect(screen.queryByText('The readiness check could not be completed.')).toBeNull();
  });

  it('keeps the previous result on screen when a refresh fails, and says so', async () => {
    const body = response({ nodes: [node({ id: 1, name: 'Edge', cells: { updates: healthyCell() } })] });
    vi.mocked(apiFetch).mockResolvedValueOnce(okResponse(body));
    const { rerender } = renderReadiness();
    await matrixRows();

    vi.mocked(apiFetch).mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) } as Response);
    rerender(<FleetReadiness refreshKey={1} onOpenNodeDetails={vi.fn()} onOpenNodeSecurity={vi.fn()} isAdmin />);

    expect(await screen.findByText(/The readiness check could not be completed\. Showing the previous result\./)).toBeInTheDocument();
    expect(await matrixRows()).toHaveLength(1);
  });

  it('never lets a slow earlier answer overwrite a newer one', async () => {
    let resolveSlow: (value: Response) => void = () => undefined;
    const signals: AbortSignal[] = [];
    vi.mocked(apiFetch)
      .mockImplementationOnce((_path, init) => {
        signals.push(init!.signal!);
        return new Promise<Response>(resolve => { resolveSlow = resolve; });
      })
      .mockImplementationOnce(async (_path, init) => {
        signals.push(init!.signal!);
        return okResponse(response({ nodes: [node({ id: 1, name: 'Newer' })] }));
      });
    const { rerender } = renderReadiness();
    rerender(<FleetReadiness refreshKey={1} onOpenNodeDetails={vi.fn()} onOpenNodeSecurity={vi.fn()} isAdmin />);

    expect(await screen.findByText('Newer')).toBeInTheDocument();
    expect(signals[0].aborted).toBe(true);
    await act(async () => {
      resolveSlow(okResponse(response({ nodes: [node({ id: 1, name: 'Older' })] })));
    });
    expect(screen.queryByText('Older')).toBeNull();
    expect(screen.getByText('Newer')).toBeInTheDocument();
  });

  it('shows the empty state rather than a board when the fleet has no nodes', async () => {
    mockResponse(response({ nodes: [] }));
    renderReadiness();

    expect(await screen.findByText('No nodes yet')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('surfaces a failed first read with a retry instead of an empty board', async () => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: false, status: 500, json: async () => ({}) } as Response);
    renderReadiness();

    expect(await screen.findByText('The readiness check could not be completed.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeInTheDocument();
  });

  it('repeats the reason the server gave for refusing the read', async () => {
    vi.mocked(apiFetch).mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Permission denied.', code: 'PERMISSION_DENIED' }),
    } as Response);
    renderReadiness();

    expect(await screen.findByText('Permission denied.')).toBeInTheDocument();
  });
});

describe('filterFindings', () => {
  const names = new Map([[2, 'Edge'], [3, 'Nas']]);
  const findings = [
    finding({ id: 'r1', domain: 'recovery', code: 'rollback_partial', severity: 'degraded', verdict: { kind: 'rollback', value: 'partial' } }),
    finding({ id: 'r2', domain: 'recovery', code: 'rollback_not_ready', verdict: { kind: 'rollback', value: 'not_ready' }, nodeId: 3 }),
    finding({ id: 'u1', code: 'update_blocked', verdict: { kind: 'update', value: 'blocked' }, stack: 'web' }),
    finding({ id: 'u2', code: 'update_ready_with_warnings', severity: 'degraded', verdict: { kind: 'update', value: 'ready_with_warnings' } }),
    finding({ id: 'c1', domain: 'connectivity', code: 'node_unreachable', nodeId: 3 }),
  ];
  const ids = (list: ReadinessFinding[]) => list.map(item => item.id);

  it('surfaces the stacks whose rollback is partial or not ready', () => {
    expect(ids(filterFindings(findings, { ...EMPTY_FINDINGS_FILTER, verdict: 'rollback-weak' }, names))).toEqual(['r1', 'r2']);
  });

  it('surfaces updates that are blocked or need review, not ones that merely warn', () => {
    expect(ids(filterFindings(findings, { ...EMPTY_FINDINGS_FILTER, verdict: 'update-not-ready' }, names))).toEqual(['u1']);
  });

  it('combines node, domain, and state, and searches node and stack names', () => {
    expect(ids(filterFindings(findings, { ...EMPTY_FINDINGS_FILTER, nodeId: 3, domain: 'recovery' }, names))).toEqual(['r2']);
    expect(ids(filterFindings(findings, { ...EMPTY_FINDINGS_FILTER, severity: 'degraded' }, names))).toEqual(['r1', 'u2']);
    expect(ids(filterFindings(findings, { ...EMPTY_FINDINGS_FILTER, query: 'nas' }, names))).toEqual(['r2', 'c1']);
    expect(ids(filterFindings(findings, { ...EMPTY_FINDINGS_FILTER, query: 'WEB' }, names))).toEqual(['u1']);
  });
});
