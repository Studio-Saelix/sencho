import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from '@/components/ui/toast-store';
import type { FindingDismissal } from '@/types/findingDismissal';
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
  fetchForNode: vi.fn(),
  withDeploySession: (_id: string, options: object = {}) => options,
}));
vi.mock('@/context/DeployFeedbackContext', () => ({
  useDeployFeedback: () => ({
    runWithLog: async (_params: unknown, run: (started: Promise<void>, sessionId: string) => Promise<unknown>) =>
      run(Promise.resolve(), 'test-session'),
  }),
}));
vi.mock('@/lib/fleetSyncApi', () => ({
  fetchFleetSyncStatuses: vi.fn(),
  resetFleetSyncAnchor: vi.fn(),
}));

import { apiFetch, fetchForNode } from '@/lib/api';
import { fetchFleetSyncStatuses, resetFleetSyncAnchor } from '@/lib/fleetSyncApi';
import { useFleetReadiness } from '../readiness/useFleetReadiness';

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
    fingerprint: 'fp',
    dismissPolicy: 'any',
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
    dismissals: [],
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

type HarnessProps = Omit<Parameters<typeof FleetReadiness>[0], 'readiness' | 'canDismiss' | 'canRun'> & {
  refreshKey: number;
  canDismiss?: Parameters<typeof FleetReadiness>[0]['canDismiss'];
  canRun?: Parameters<typeof FleetReadiness>[0]['canRun'];
};

/** Stands in for the Fleet shell, which owns the readiness check and hands it to the tab. */
function Harness({ refreshKey, canDismiss = () => true, canRun = () => true, ...props }: HarnessProps) {
  return <FleetReadiness readiness={useFleetReadiness(refreshKey)} canDismiss={canDismiss} canRun={canRun} {...props} />;
}

function renderReadiness(props: Partial<HarnessProps> = {}) {
  return render(
    <Harness refreshKey={0} onOpenNodeDetails={vi.fn()} onOpenNodeSecurity={vi.fn()} isAdmin {...props} />,
  );
}

describe('FleetReadiness', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('carries no heading of its own under the Fleet masthead', async () => {
    mockResponse(response({ nodes: [node({ id: 1, name: 'Local', type: 'local', transport: 'local' })] }));
    renderReadiness();
    expect(await screen.findByRole('region', { name: 'Readiness summary' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Fleet Readiness' })).toBeNull();
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
    const summary = screen.getByRole('region', { name: 'Readiness summary' });
    expect(summary).toHaveTextContent('2 attention · 1 unverified · 1 of 4 healthy');
  });

  it('reads an all-healthy fleet as all clear, dropping zero-count segments', async () => {
    mockResponse(response({
      summary: {
        nodes: { attention: 0, degraded: 0, unavailable: 0, unknown: 0, healthy: 2 },
        findings: { attention: 0, degraded: 0, unavailable: 0, unknown: 0 },
      },
      findings: [finding({ id: 'only', code: 'update_blocked' })],
      nodes: [node({ id: 1, name: 'A' }), node({ id: 2, name: 'B' })],
    }));
    renderReadiness();

    const summary = await screen.findByRole('region', { name: 'Readiness summary' });
    expect(within(summary).getByText('All clear')).toBeInTheDocument();
    expect(summary).toHaveTextContent('2 of 2 healthy · 1 finding');
    expect(summary).not.toHaveTextContent('attention');
  });

  it('names degraded nodes when nothing needs attention', async () => {
    mockResponse(response({
      summary: {
        nodes: { attention: 0, degraded: 1, unavailable: 0, unknown: 0, healthy: 1 },
        findings: { attention: 0, degraded: 0, unavailable: 0, unknown: 0 },
      },
      nodes: [node({ id: 1, name: 'A' }), node({ id: 2, name: 'B' })],
    }));
    renderReadiness();

    const summary = await screen.findByRole('region', { name: 'Readiness summary' });
    expect(within(summary).getByText('Degraded')).toBeInTheDocument();
    expect(summary).toHaveTextContent('1 degraded · 1 of 2 healthy');
  });

  it('says checking over existing data while a refresh is in flight', async () => {
    mockResponse(response({ nodes: [node({ id: 1, name: 'A' })] }));
    const { rerender } = renderReadiness();
    await matrixRows();

    vi.mocked(apiFetch).mockImplementationOnce(() => new Promise<Response>(() => undefined));
    rerender(<Harness refreshKey={1} onOpenNodeDetails={vi.fn()} onOpenNodeSecurity={vi.fn()} isAdmin />);

    expect(await screen.findByText('checking')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Readiness findings' })).toBeInTheDocument();
  });

  it('holds the skeleton back until the check has been slow, so a fast answer never flashes it', async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(apiFetch).mockImplementation(() => new Promise<Response>(() => undefined));
      renderReadiness();
      expect(screen.queryByLabelText('Checking readiness')).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(300); });
      expect(screen.getByLabelText('Checking readiness')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
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
        id: 'security:2:posture_action_needed',
        domain: 'security',
        code: 'posture_action_needed',
        severity: 'attention',
        dismissPolicy: 'none',
        target: { surface: 'security', tab: 'scanner' },
      })],
      nodes: [node({ id: 2, name: 'Edge', cells: { security: problemCell('posture_action_needed', 'attention') } })],
    }));
    const onOpenNodeSecurity = vi.fn();
    renderReadiness({ onOpenNodeSecurity });

    await screen.findAllByText('Security needs action');
    fireEvent.click(within(findingRows()[0]).getByRole('button', { name: /^Open Security/ }));
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
    rerender(<Harness refreshKey={1} onOpenNodeDetails={vi.fn()} onOpenNodeSecurity={vi.fn()} isAdmin />);

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
    rerender(<Harness refreshKey={1} onOpenNodeDetails={vi.fn()} onOpenNodeSecurity={vi.fn()} isAdmin />);

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

describe('FleetReadiness dismissals', () => {
  const STOPPED = finding({
    id: 'workloads:2:api:workloads_exited',
    domain: 'workloads',
    code: 'workloads_exited',
    stack: 'api',
    target: { surface: 'stack', nodeId: 2, stackName: 'api' },
    fingerprint: 'fp-api',
  });
  const SLOW = finding({ id: 'connectivity:2:probe_timeout', domain: 'connectivity', code: 'probe_timeout', severity: 'unavailable', dismissPolicy: 'timed' });

  function dismissalFor(f: ReadinessFinding, over: Partial<FindingDismissal> = {}): FindingDismissal {
    return {
      id: 7, nodeId: f.nodeId, surface: 'readiness', findingKey: f.id, fingerprint: f.fingerprint,
      severity: f.severity, count: f.count, mode: 'until_change', expiresAt: null,
      createdBy: 'alice', createdAt: Date.now() - 3_600_000, ...over,
    };
  }

  function board(over: Partial<FleetReadinessResponse> = {}) {
    return response({
      findings: [STOPPED, SLOW],
      nodes: [node({ id: 2, name: 'Edge', state: 'attention', cells: { workloads: problemCell('workloads_exited', 'attention') } })],
      ...over,
    });
  }

  /** Answers the readiness read, and any dismissal call with the given reply. */
  function mockServer(reply: (url: string, init?: RequestInit) => Response, read: FleetReadinessResponse) {
    vi.mocked(apiFetch).mockImplementation(async (url: string, init?: RequestInit) => (
      url.startsWith('/fleet/dismissals') ? reply(url, init) : okResponse(read)
    ));
  }

  const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;

  it('sets a dismissed finding aside, names it, and leaves the matrix untouched', async () => {
    mockResponse(board({ dismissals: [dismissalFor(STOPPED)] }));
    renderReadiness();

    await screen.findByText('Node did not answer in time');
    expect(screen.queryByText('Stack is stopped')).toBeNull();
    expect(findingRows()).toHaveLength(1);
    expect(screen.getByText(/1 finding · 1 dismissed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /1 dismissed/ })).toBeInTheDocument();
    // The cell still says what the evidence says: the dismissed stack is still counted.
    const matrix = await matrixRows();
    expect(within(matrix[0]).getByText('1 exited')).toBeInTheDocument();
  });

  it('shows a dismissed finding again as soon as it changes', async () => {
    mockResponse(board({ dismissals: [dismissalFor(STOPPED, { fingerprint: 'an-older-state' })] }));
    renderReadiness();

    expect(await screen.findByText('Stack is stopped')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dismissed/ })).toBeNull();
  });

  it('shows a dismissed finding again once it gets worse', async () => {
    mockResponse(board({ dismissals: [dismissalFor(STOPPED, { severity: 'degraded', mode: 'forever' })] }));
    renderReadiness();

    expect(await screen.findByText('Stack is stopped')).toBeInTheDocument();
  });

  it('dismisses in one click, moves the row at once, and offers Undo', async () => {
    const success = vi.spyOn(toast, 'success').mockReturnValue('t');
    mockServer(() => json({ dismissal: dismissalFor(STOPPED), kept: false }, 201), board());
    renderReadiness();

    await screen.findByText('Stack is stopped');
    const row = findingRows().find(candidate => within(candidate).queryByText('Stack is stopped'))!;
    fireEvent.click(within(row).getByRole('button', { name: 'Dismiss: Stack is stopped' }));

    await waitFor(() => expect(screen.queryByText('Stack is stopped')).toBeNull());
    const post = vi.mocked(apiFetch).mock.calls.find(([url]) => url === '/fleet/dismissals/readiness')!;
    expect(post[1]).toMatchObject({ method: 'POST', localOnly: true });
    expect(JSON.parse(post[1]!.body as string)).toEqual({ findingId: STOPPED.id, fingerprint: 'fp-api', count: 1, mode: 'until_change' });
    expect(screen.getByRole('button', { name: /1 dismissed/ })).toBeInTheDocument();
    expect(success).toHaveBeenCalledWith(expect.stringContaining('returns if it changes'), expect.objectContaining({
      action: expect.objectContaining({ label: 'Undo' }),
    }));
  });

  it('puts the finding back when Undo is chosen', async () => {
    const success = vi.spyOn(toast, 'success').mockReturnValue('t');
    mockServer((_url, init) => (init?.method === 'DELETE'
      ? ({ ok: true, status: 204, json: async () => ({}) }) as Response
      : json({ dismissal: dismissalFor(STOPPED), kept: false }, 201)), board());
    renderReadiness();

    await screen.findByText('Stack is stopped');
    fireEvent.click(within(findingRows().find(candidate => within(candidate).queryByText('Stack is stopped'))!).getByRole('button', { name: 'Dismiss: Stack is stopped' }));
    await waitFor(() => expect(screen.queryByText('Stack is stopped')).toBeNull());

    const undo = (success.mock.calls[0][1] as { action: { onClick: () => void } }).action.onClick;
    await act(async () => { undo(); });

    expect(await screen.findByText('Stack is stopped')).toBeInTheDocument();
    expect(vi.mocked(apiFetch)).toHaveBeenCalledWith('/fleet/dismissals/7', { method: 'DELETE', localOnly: true });
  });

  it('restores from the dismissed list', async () => {
    mockServer(() => ({ ok: true, status: 204, json: async () => ({}) }) as Response, board({ dismissals: [dismissalFor(STOPPED)] }));
    renderReadiness();

    fireEvent.click(await screen.findByRole('button', { name: /1 dismissed/ }));
    expect(await screen.findByText(/dismissed by alice/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

    expect(await screen.findByText('Stack is stopped')).toBeInTheDocument();
  });

  it('omits Dismiss for an account that cannot dismiss, and for a finding resolved elsewhere', async () => {
    const posture = finding({ id: 'security:2:posture_action_needed', domain: 'security', code: 'posture_action_needed', dismissPolicy: 'none' });
    mockResponse(board({ findings: [STOPPED, posture] }));
    renderReadiness({ canDismiss: candidate => candidate.id !== STOPPED.id });

    await screen.findByText('Security needs action');
    expect(screen.queryAllByRole('button', { name: /^Dismiss/ })).toHaveLength(0);
  });

  it('dismisses a finding about missing evidence for a set time only, never until it changes or permanently', async () => {
    const user = userEvent.setup();
    mockServer(() => json({ dismissal: dismissalFor(SLOW, { mode: 'days', expiresAt: Date.now() + 7 * 86_400_000 }), kept: false }, 201), board({ findings: [SLOW] }));
    renderReadiness();

    await screen.findByText('Node did not answer in time');
    await user.click(screen.getByRole('button', { name: 'More ways to dismiss' }));
    expect(await screen.findByRole('menuitem', { name: 'Dismiss for 30 days' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Dismiss permanently' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Dismiss until it changes' })).toBeNull();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Dismiss: Node did not answer in time' }));
    const post = vi.mocked(apiFetch).mock.calls.find(([url]) => url === '/fleet/dismissals/readiness')!;
    expect(JSON.parse(post[1]!.body as string)).toEqual({ findingId: SLOW.id, fingerprint: 'fp', count: 1, mode: 'days', days: 7 });
  });

  it('offers a permanent dismissal for an ordinary finding', async () => {
    const user = userEvent.setup();
    mockResponse(board({ findings: [STOPPED] }));
    renderReadiness();

    await screen.findByText('Stack is stopped');
    await user.click(screen.getByRole('button', { name: 'More ways to dismiss' }));
    expect(await screen.findByRole('menuitem', { name: 'Dismiss permanently' })).toBeInTheDocument();
  });

  it('says so, and re-reads, when the finding was already resolved', async () => {
    const info = vi.spyOn(toast, 'info').mockReturnValue('t');
    mockServer(() => json({ error: 'That finding is no longer present.', code: 'FINDING_GONE' }, 409), board());
    renderReadiness();

    await screen.findByText('Stack is stopped');
    fireEvent.click(within(findingRows().find(candidate => within(candidate).queryByText('Stack is stopped'))!).getByRole('button', { name: 'Dismiss: Stack is stopped' }));

    await waitFor(() => expect(info).toHaveBeenCalledWith('That finding is already resolved.'));
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter(([url]) => url === '/fleet/readiness').length).toBeGreaterThan(1));
  });

  it('says so, and re-reads, when the finding changed before the dismissal reached the server', async () => {
    const info = vi.spyOn(toast, 'info').mockReturnValue('t');
    mockServer(() => json({ error: 'That finding changed. Review it again.', code: 'FINDING_CHANGED' }, 409), board());
    renderReadiness();

    await screen.findByText('Stack is stopped');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss: Stack is stopped' }));

    await waitFor(() => expect(info).toHaveBeenCalledWith('That finding just changed, so it was not dismissed.'));
    expect(screen.getByText('Stack is stopped')).toBeInTheDocument();
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter(([url]) => url === '/fleet/readiness').length).toBeGreaterThan(1));
  });

  it('keeps the finding listed and reports the failure when dismissing fails', async () => {
    const error = vi.spyOn(toast, 'error').mockReturnValue('t');
    mockServer(() => json({ error: 'Permission denied.' }, 403), board());
    renderReadiness();

    await screen.findByText('Stack is stopped');
    fireEvent.click(within(findingRows().find(candidate => within(candidate).queryByText('Stack is stopped'))!).getByRole('button', { name: 'Dismiss: Stack is stopped' }));

    await waitFor(() => expect(error).toHaveBeenCalledWith('Permission denied.'));
    expect(screen.getByText('Stack is stopped')).toBeInTheDocument();
  });

  it('opens the dismissed list when everything in view is dismissed', async () => {
    mockResponse(board({ findings: [STOPPED], dismissals: [dismissalFor(STOPPED)] }));
    renderReadiness();

    expect(await screen.findByText('Everything here is dismissed.')).toBeInTheDocument();
    // The list opens by itself, because the table above it has nothing to show.
    expect(screen.getByRole('button', { name: /1 dismissed/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/dismissed by alice/)).toBeInTheDocument();
  });

  it('counts only the findings still in view, never a negative number', async () => {
    mockResponse(board({ dismissals: [dismissalFor(STOPPED), dismissalFor(SLOW, { id: 8, mode: 'days', expiresAt: Date.now() + 86_400_000 })] }));
    renderReadiness();

    expect(await screen.findByText(/0 findings · 2 dismissed/)).toBeInTheDocument();
  });

  it('re-reads the list instead of reporting a failure when the server accepted a dismissal but the reply is unreadable', async () => {
    const info = vi.spyOn(toast, 'info').mockReturnValue('t');
    const error = vi.spyOn(toast, 'error').mockReturnValue('t');
    mockServer(() => ({ ok: true, status: 201, json: async () => ({ unexpected: true }) }) as Response, board());
    renderReadiness();

    await screen.findByText('Stack is stopped');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss: Stack is stopped' }));

    await waitFor(() => expect(info).toHaveBeenCalledWith('Dismissed. Refreshing the list.'));
    expect(error).not.toHaveBeenCalled();
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter(([url]) => url === '/fleet/readiness').length).toBeGreaterThan(1));
  });
});


describe('FleetReadiness resolving verbs', () => {
  const verbFinding = (over: Partial<ReadinessFinding> & { id: string; code: ReadinessReasonCode }) => finding({
    domain: 'workloads',
    nodeId: 2,
    stack: 'web',
    target: { surface: 'stack', nodeId: 2, stackName: 'web' },
    ...over,
  });

  function showFindings(findings: ReadinessFinding[]) {
    mockResponse(response({ findings, nodes: [node({ id: 2, name: 'Edge' })] }));
  }

  const readinessReads = () => vi.mocked(apiFetch).mock.calls.filter(([url]) => url === '/fleet/readiness').length;

  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(fetchForNode).mockReset();
    vi.mocked(fetchFleetSyncStatuses).mockReset();
    vi.mocked(resetFleetSyncAnchor).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts the stack on its own node in one click, then re-reads the check', async () => {
    showFindings([verbFinding({ id: 'workloads:2:web:workloads_exited', code: 'workloads_exited' })]);
    vi.mocked(fetchForNode).mockResolvedValue({ ok: true, json: async () => ({ success: true }) } as Response);
    const success = vi.spyOn(toast, 'success');
    renderReadiness();

    const button = await screen.findByRole('button', { name: /^Start stack/ });
    const before = readinessReads();
    fireEvent.click(button);

    await waitFor(() => expect(fetchForNode).toHaveBeenCalledWith('/stacks/web/start', 2, { method: 'POST' }));
    await waitFor(() => expect(success).toHaveBeenCalledWith('Started web'));
    await waitFor(() => expect(readinessReads()).toBeGreaterThan(before));
  });

  it('offers to open the stack when its containers are gone', async () => {
    showFindings([verbFinding({ id: 'workloads:2:web:workloads_exited', code: 'workloads_exited' })]);
    vi.mocked(fetchForNode).mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'No containers found for this stack.' }),
    } as Response);
    const error = vi.spyOn(toast, 'error');
    renderReadiness();

    fireEvent.click(await screen.findByRole('button', { name: /^Start stack/ }));

    await waitFor(() => expect(error).toHaveBeenCalledWith(
      'web has no containers to start.',
      expect.objectContaining({ action: expect.objectContaining({ label: 'Open stack' }) }),
    ));
  });

  it('keeps the named navigation when the account cannot run the verb', async () => {
    showFindings([verbFinding({ id: 'workloads:2:web:workloads_exited', code: 'workloads_exited' })]);
    renderReadiness({ canRun: () => false });

    expect(await screen.findByRole('button', { name: /^Open stack/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Start stack/ })).toBeNull();
  });

  it('tests the connection against the hub-held node record', async () => {
    showFindings([finding({
      id: 'connectivity:2:node_unreachable',
      domain: 'connectivity',
      code: 'node_unreachable',
      severity: 'unavailable',
    })]);
    renderReadiness();
    vi.mocked(apiFetch).mockImplementation(async (url: string) => (
      url === '/nodes/2/test'
        ? ({ ok: true, json: async () => ({ success: true }) } as Response)
        : okResponse(response({ nodes: [node({ id: 2, name: 'Edge' })] }))
    ));

    fireEvent.click(await screen.findByRole('button', { name: /^Test connection/ }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/nodes/2/test', { method: 'POST', localOnly: true }));
  });

  it('checks again by re-reading the readiness check', async () => {
    showFindings([finding({ id: 'workloads:2:workloads_unknown', domain: 'workloads', code: 'workloads_unknown', severity: 'unknown' })]);
    renderReadiness();

    const button = await screen.findByRole('button', { name: /^Check again/ });
    const before = readinessReads();
    fireEvent.click(button);

    await waitFor(() => expect(readinessReads()).toBeGreaterThan(before));
  });

  it('offers the update review only when an update is known and the verdict is not blocked', async () => {
    showFindings([
      verbFinding({
        id: 'updates:2:web:update_review_required',
        domain: 'updates',
        code: 'update_review_required',
        hasUpdate: true,
        topReasonId: 'preflight',
        verdict: { kind: 'update', value: 'review_required' },
      }),
      verbFinding({
        id: 'updates:2:api:update_review_required',
        domain: 'updates',
        stack: 'api',
        code: 'update_review_required',
        hasUpdate: false,
        verdict: { kind: 'update', value: 'review_required' },
        target: { surface: 'stack', nodeId: 2, stackName: 'api' },
      }),
      verbFinding({
        id: 'updates:2:db:update_blocked',
        domain: 'updates',
        stack: 'db',
        code: 'update_blocked',
        hasUpdate: true,
        verdict: { kind: 'update', value: 'blocked' },
        target: { surface: 'stack', nodeId: 2, stackName: 'db' },
      }),
    ]);
    renderReadiness();

    expect(await screen.findAllByRole('button', { name: /^Review update/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /^Open stack/ })).toHaveLength(2);
  });

  it('captures a recovery point only when the compose source is what is missing', async () => {
    showFindings([
      verbFinding({
        id: 'recovery:2:web:rollback_not_ready',
        domain: 'recovery',
        code: 'rollback_not_ready',
        topReasonId: 'compose_source',
        verdict: { kind: 'rollback', value: 'not_ready' },
      }),
      verbFinding({
        id: 'recovery:2:api:rollback_not_ready',
        domain: 'recovery',
        stack: 'api',
        code: 'rollback_not_ready',
        topReasonId: 'volume_data',
        verdict: { kind: 'rollback', value: 'not_ready' },
        target: { surface: 'stack', nodeId: 2, stackName: 'api' },
      }),
    ]);
    renderReadiness();

    expect(await screen.findAllByRole('button', { name: /^Capture recovery point/ })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /^Open stack/ })).toHaveLength(1);
  });

  it('installs the scanner only after a confirmation', async () => {
    showFindings([finding({
      id: 'security:2:scanner_unavailable',
      domain: 'security',
      code: 'scanner_unavailable',
      severity: 'unknown',
      target: { surface: 'security', tab: 'scanner' },
    })]);
    vi.mocked(fetchForNode).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    renderReadiness();

    fireEvent.click(await screen.findByRole('button', { name: /^Install scanner/ }));
    expect(fetchForNode).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: 'Install' }));
    await waitFor(() => expect(fetchForNode).toHaveBeenCalledWith('/security/trivy-install', 2, { method: 'POST' }));
  });

  it('names the hub a node is anchored to before re-anchoring it', async () => {
    showFindings([finding({
      id: 'control:2:control_paused',
      domain: 'control',
      code: 'control_paused',
      severity: 'attention',
    })]);
    vi.mocked(fetchFleetSyncStatuses).mockResolvedValue([{
      node_id: 2,
      resource: 'policy',
      last_success_at: null,
      last_failure_at: null,
      last_error: null,
      sticky_error_code: 'CONTROL_IDENTITY_MISMATCH',
      sticky_error_expected: 'abcdef0123456789',
      sticky_error_got: null,
    }]);
    vi.mocked(resetFleetSyncAnchor).mockResolvedValue(undefined);
    renderReadiness();

    fireEvent.click(await screen.findByRole('button', { name: /^Re-anchor to this hub/ }));
    expect(await screen.findByText(/abcdef012345/)).toBeInTheDocument();
    expect(resetFleetSyncAnchor).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Re-anchor' }));
    await waitFor(() => expect(resetFleetSyncAnchor).toHaveBeenCalledWith(2));
  });
});
