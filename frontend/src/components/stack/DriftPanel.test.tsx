/**
 * Covers the read-only drift panel: it renders each per-stack status, lists
 * findings with their expected/actual values, surfaces a parse error, shows a
 * retry state on load failure, and re-checks on demand.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ activeNode: { id: 1 }, nodes: [{ id: 1, name: 'local' }, { id: 2, name: 'edge-02' }] }),
}));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import DriftPanel from './DriftPanel';
import {
  absentRevision,
  driftItem,
  facets,
  liveRevision,
  missingApplicationLimitation,
  plainSource,
  target,
} from '@/__tests__/gitopsFixtures';

interface DriftReport {
  stack: string;
  status: string;
  hasComposeFile: boolean;
  hasContainers: boolean;
  findings: Array<{ kind: string; service: string; detail: string; expected?: string; actual?: string }>;
  parseError?: string;
  temporal?: { hasBaseline: boolean; sourceChanged: boolean; renderedChanged: boolean };
  ledger?: Array<{ service: string; kind: string; message: string; detectedAt: number; resolvedAt: number | null }>;
  lastCheckedAt?: number | null;
  gitopsRevision?: unknown;
}

function report(partial: Partial<DriftReport>): DriftReport {
  return { stack: 'web', status: 'in-sync', hasComposeFile: true, hasContainers: true, findings: [], ...partial };
}

function jsonRes(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body, text: async () => '' } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DriftPanel', () => {
  it('renders the in-sync status', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({ status: 'in-sync' })));
    render(<DriftPanel stackName="web" />);
    const status = await screen.findByTestId('drift-status');
    expect(status).toHaveAttribute('data-status', 'in-sync');
    expect(screen.getByText(/Runtime matches/i)).toBeInTheDocument();
    // A clean stack shows no findings section.
    expect(screen.queryByText(/findings/i)).not.toBeInTheDocument();
  });

  it('renders every finding kind with its label and expected/actual values', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'drifted',
      findings: [
        { kind: 'image-mismatch', service: 'web', detail: 'Service "web" runs a different image than compose declares.', expected: 'nginx:1.25', actual: 'nginx:1.24' },
        { kind: 'ports-mismatch', service: 'web', detail: 'Service "web" publishes different ports than compose declares.', expected: '8080/tcp', actual: '9090/tcp' },
        { kind: 'service-missing', service: 'db', detail: 'Service "db" is declared in compose but is not running.' },
        { kind: 'service-undeclared', service: 'sidecar', detail: 'Service "sidecar" is running but is not declared in compose.' },
      ],
    })));
    render(<DriftPanel stackName="web" />);
    const status = await screen.findByTestId('drift-status');
    expect(status).toHaveAttribute('data-status', 'drifted');
    expect(screen.getByText(/4 findings/)).toBeInTheDocument();
    // Finding-kind labels.
    expect(screen.getByText('image')).toBeInTheDocument();
    expect(screen.getByText('ports')).toBeInTheDocument();
    expect(screen.getByText('service missing')).toBeInTheDocument();
    expect(screen.getByText('undeclared')).toBeInTheDocument();
    // Comparison values for image and ports findings.
    expect(screen.getByText('nginx:1.25')).toBeInTheDocument();
    expect(screen.getByText('nginx:1.24')).toBeInTheDocument();
    expect(screen.getByText('8080/tcp')).toBeInTheDocument();
    expect(screen.getByText('9090/tcp')).toBeInTheDocument();
  });

  it('uses the singular noun for a single finding', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'drifted',
      findings: [{ kind: 'service-missing', service: 'db', detail: 'Service "db" is declared in compose but is not running.' }],
    })));
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-status');
    expect(screen.getByText(/1 finding$/)).toBeInTheDocument();
  });

  it('renders the missing-runtime status', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({ status: 'missing-runtime', hasContainers: false })));
    render(<DriftPanel stackName="web" />);
    const status = await screen.findByTestId('drift-status');
    expect(status).toHaveAttribute('data-status', 'missing-runtime');
  });

  it('renders the unreachable status', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({ status: 'unreachable', hasContainers: false })));
    render(<DriftPanel stackName="web" />);
    const status = await screen.findByTestId('drift-status');
    expect(status).toHaveAttribute('data-status', 'unreachable');
    expect(screen.getByText(/Docker is unreachable/i)).toBeInTheDocument();
  });

  it('surfaces a compose parse error', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'drifted', hasComposeFile: false, parseError: 'Could not parse compose file: bad yaml',
    })));
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-status');
    expect(screen.getByText(/Could not parse compose file/i)).toBeInTheDocument();
  });

  it('shows a retry state (not a status) when the load fails', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes({ error: 'down' }, false));
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-retry-btn');
    expect(screen.queryByTestId('drift-status')).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalled();
  });

  it('shows the retry state when the request throws', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('network'));
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-retry-btn');
    expect(screen.queryByTestId('drift-status')).not.toBeInTheDocument();
    expect(toast.error).toHaveBeenCalled();
  });

  it('retry refetches and recovers to a status', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(jsonRes({ error: 'down' }, false))
      .mockResolvedValueOnce(jsonRes(report({ status: 'in-sync' })));
    render(<DriftPanel stackName="web" />);
    fireEvent.click(await screen.findByTestId('drift-retry-btn'));
    const status = await screen.findByTestId('drift-status');
    expect(status).toHaveAttribute('data-status', 'in-sync');
    expect(screen.queryByTestId('drift-retry-btn')).not.toBeInTheDocument();
  });

  it('re-checks on demand via the recheck endpoint (a POST), not the read GET', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({ status: 'in-sync' })));
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-status');
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenLastCalledWith('/stacks/web/drift');
    fireEvent.click(screen.getByTestId('drift-recheck-btn'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(apiFetch).toHaveBeenLastCalledWith('/stacks/web/drift/recheck', { method: 'POST' });
  });

  it('omits the temporal card when the report carries no temporal field (older node)', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({ status: 'in-sync' }))); // no temporal field
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-status');
    expect(screen.queryByTestId('drift-temporal')).not.toBeInTheDocument();
  });

  it('shows "no deploy baseline" when the report has no temporal baseline', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'in-sync',
      temporal: { hasBaseline: false, sourceChanged: false, renderedChanged: false },
    })));
    render(<DriftPanel stackName="web" />);
    const temporal = await screen.findByTestId('drift-temporal');
    expect(temporal).toHaveAttribute('data-temporal', 'no-baseline');
  });

  it('flags a source change since the last deploy', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'in-sync',
      temporal: { hasBaseline: true, sourceChanged: true, renderedChanged: true },
    })));
    render(<DriftPanel stackName="web" />);
    const temporal = await screen.findByTestId('drift-temporal');
    expect(temporal).toHaveAttribute('data-temporal', 'source-changed');
    expect(screen.getByText(/changed since the last deploy/i)).toBeInTheDocument();
  });

  it('notes a formatting-only change when source changed but the model did not', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'in-sync',
      temporal: { hasBaseline: true, sourceChanged: true, renderedChanged: false },
    })));
    render(<DriftPanel stackName="web" />);
    const temporal = await screen.findByTestId('drift-temporal');
    expect(temporal).toHaveAttribute('data-temporal', 'source-changed');
    expect(screen.getByText(/formatting only/i)).toBeInTheDocument();
  });

  it('shows "matches last deploy" when the source is unchanged', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'in-sync',
      temporal: { hasBaseline: true, sourceChanged: false, renderedChanged: false },
    })));
    render(<DriftPanel stackName="web" />);
    const temporal = await screen.findByTestId('drift-temporal');
    expect(temporal).toHaveAttribute('data-temporal', 'matches');
  });

  it('renders the persisted drift history with open and resolved entries, labelled with when it was checked', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'drifted',
      findings: [{ kind: 'image-mismatch', service: 'web', detail: 'image differs' }],
      lastCheckedAt: Date.now(),
      ledger: [
        { service: 'web', kind: 'image-mismatch', message: 'image differs', detectedAt: Date.now(), resolvedAt: null },
        { service: 'db', kind: 'service-missing', message: 'db not running', detectedAt: Date.now() - 1000, resolvedAt: Date.now() },
      ],
    })));
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-status');
    expect(screen.getByText(/drift history/i)).toBeInTheDocument();
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByText('resolved')).toBeInTheDocument();
    // The history is timestamped so a stale row reads as history, not the live status.
    expect(screen.getByText(/checked/i)).toBeInTheDocument();
  });

  it('omits the last-checked label when the stack has never been reconciled', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'drifted',
      findings: [{ kind: 'image-mismatch', service: 'web', detail: 'image differs' }],
      lastCheckedAt: null,
      ledger: [
        { service: 'web', kind: 'image-mismatch', message: 'image differs', detectedAt: Date.now(), resolvedAt: null },
      ],
    })));
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-status');
    expect(screen.queryByText(/checked/i)).not.toBeInTheDocument();
  });

  it('labels a managed-path conflict without rendering the opaque service key', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      status: 'in-sync',
      ledger: [
        { service: 'deadbeefcafebabe', kind: 'managed-path-conflict', message: 'compose-primary local-modified', detectedAt: Date.now(), resolvedAt: null },
      ],
    })));
    render(<DriftPanel stackName="web" />);
    await screen.findByText('managed path');
    expect(screen.queryByText('deadbeefcafebabe')).not.toBeInTheDocument();
    expect(screen.getByText('compose-primary local-modified')).toBeInTheDocument();
  });
});

describe('DriftPanel GitOps state', () => {
  it('renders the source state and one card per target for a Direct stack', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      gitopsRevision: liveRevision({
        facets: facets({ source: plainSource('candidate_ready') }),
        targets: [target({ nodeId: 1, runtime: { status: 'applied_not_deployed' } })],
      }),
    })));
    render(<DriftPanel stackName="web" />);

    const source = await screen.findByTestId('gitops-source');
    expect(source).toHaveAttribute('data-state', 'candidate_ready');
    const targets = screen.getAllByTestId('gitops-target');
    expect(targets).toHaveLength(1);
    expect(targets[0]).toHaveAttribute('data-state', 'applied_not_deployed');
    expect(targets[0]).toHaveTextContent('local');
  });

  it('shows no source card for a Blueprint-owned stack, only its targets', async () => {
    // The drift route resolves through whatever manages the directory. A
    // Blueprint application has no Git source, and inventing one would be a
    // claim the model never made.
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      gitopsRevision: liveRevision({
        targetMode: 'inline_blueprint',
        blueprintId: 7,
        facets: facets({
          source: { status: 'not_applicable' },
          placement: { status: 'blueprint_bound', completion: 'unknown' },
        }),
        targets: [
          target({ nodeId: 1, runtime: { status: 'synced_and_healthy' } }),
          target({ nodeId: 2, runtime: { status: 'drifted' } }),
        ],
      }),
    })));
    render(<DriftPanel stackName="web" />);

    await waitFor(() => expect(screen.getAllByTestId('gitops-target')).toHaveLength(2));
    expect(screen.queryByTestId('gitops-source')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('gitops-target')[1]).toHaveTextContent('edge-02');
  });

  it('reports an application the projection could not reach', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      gitopsRevision: absentRevision([missingApplicationLimitation]),
    })));
    render(<DriftPanel stackName="web" />);

    expect(await screen.findByTestId('gitops-fault')).toHaveTextContent(missingApplicationLimitation.message);
  });

  it('renders nothing new for a stack the model was never asked about', async () => {
    // The common case by far: no Git source, no Blueprint. A section header over
    // an empty block would be worse than silence.
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({ gitopsRevision: absentRevision() })));
    render(<DriftPanel stackName="web" />);

    await screen.findByTestId('drift-status');
    expect(screen.queryByTestId('gitops-fault')).not.toBeInTheDocument();
    expect(screen.queryByTestId('gitops-source')).not.toBeInTheDocument();
    expect(screen.queryByText('gitops')).not.toBeInTheDocument();
  });

  it('renders exactly today output for a report from a node that predates the model', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({ status: 'drifted' })));
    render(<DriftPanel stackName="web" />);

    expect(await screen.findByTestId('drift-status')).toHaveAttribute('data-status', 'drifted');
    expect(screen.queryByTestId('gitops-source')).not.toBeInTheDocument();
    expect(screen.queryByTestId('gitops-fault')).not.toBeInTheDocument();
  });

  it('does not treat a live application caveat as a fault', async () => {
    // Live-arm limitations are caveats on state that is being reported. Reading
    // them as faults would recreate the conflation in the opposite direction.
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      gitopsRevision: liveRevision({
        limitations: [{ code: 'repo_identity_invalid', message: 'Repository identity could not be read.', evidence: null }],
      }),
    })));
    render(<DriftPanel stackName="web" />);

    await screen.findByTestId('gitops-source');
    expect(screen.queryByTestId('gitops-fault')).not.toBeInTheDocument();
  });

  it('renders a drift item as expected against observed', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      gitopsRevision: liveRevision({ drift: [driftItem()] }),
    })));
    render(<DriftPanel stackName="web" />);

    expect(await screen.findByText('gitops drift')).toBeInTheDocument();
    expect(screen.getByText('The running image is not the one this generation expects.')).toBeInTheDocument();
    expect(screen.getByText('generation gen-acce')).toBeInTheDocument();
    expect(screen.getByText('nginx@sha256:abc')).toBeInTheDocument();
  });

  it('names a target on a node this client has no record of', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({
      gitopsRevision: liveRevision({ targets: [target({ nodeId: 9 })] }),
    })));
    render(<DriftPanel stackName="web" />);

    expect(await screen.findByTestId('gitops-target')).toHaveTextContent('node 9');
  });

  it('renders no drift section while the backend derives no items', async () => {
    vi.mocked(apiFetch).mockResolvedValue(jsonRes(report({ gitopsRevision: liveRevision({ drift: [] }) })));
    render(<DriftPanel stackName="web" />);

    await screen.findByTestId('gitops-source');
    expect(screen.queryByText('gitops drift')).not.toBeInTheDocument();
  });
});
