/**
 * Covers the read-only drift panel: it renders each per-stack status, lists
 * findings with their expected/actual values, surfaces a parse error, shows a
 * retry state on load failure, and re-checks on demand.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

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
  liveArtifact,
  liveRevision,
  missingApplicationLimitation,
  plainSource,
  portfolioRow,
  sourceIdentity,
  portfolioTarget,
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

function jsonRes(body: unknown, ok = true, status = ok ? 200 : 500) {
  return { ok, status, json: async () => body, text: async () => '' } as unknown as Response;
}

/**
 * Answer the two reads this tab makes, so a test states only the one it cares
 * about.
 *
 * The portfolio read defaults to "this stack has no GitOps application", which
 * is the ordinary answer for a stack outside GitOps. Every case below that
 * predates the posture block is such a stack, so that default is what keeps
 * them asserting about the drift report rather than about a posture they never
 * set up.
 */
function mockDriftReads(
  drift: unknown,
  options: { driftOk?: boolean; portfolio?: { application: unknown; ok?: boolean; status?: number } } = {},
): void {
  vi.mocked(apiFetch).mockImplementation(async (path: string) => {
    // The posture read is the by-id detail route; the list query is not used
    // here, so anything under /gitops/applications is the posture read.
    if (String(path).startsWith('/gitops/applications')) {
      const ok = options.portfolio?.ok ?? true;
      return jsonRes({ application: options.portfolio?.application }, ok, options.portfolio?.status ?? (ok ? 200 : 500));
    }
    return jsonRes(drift, options.driftOk ?? true);
  });
}

/** The drift read fails outright, and the portfolio read still answers. */
function mockFailedDriftRead(options: { portfolio?: { application: unknown; ok?: boolean } } = {}): void {
  mockDriftReads({ error: 'down' }, { driftOk: false, ...options });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DriftPanel', () => {
  it('renders the in-sync status', async () => {
    mockDriftReads(report({ status: 'in-sync' }));
    render(<DriftPanel stackName="web" />);
    const status = await screen.findByTestId('drift-status');
    expect(status).toHaveAttribute('data-status', 'in-sync');
    expect(screen.getByText(/Runtime matches/i)).toBeInTheDocument();
    // A clean stack shows no findings section.
    expect(screen.queryByText(/findings/i)).not.toBeInTheDocument();
  });

  it('renders every finding kind with its label and expected/actual values', async () => {
    mockDriftReads(report({
      status: 'drifted',
      findings: [
        { kind: 'image-mismatch', service: 'web', detail: 'Service "web" runs a different image than compose declares.', expected: 'nginx:1.25', actual: 'nginx:1.24' },
        { kind: 'ports-mismatch', service: 'web', detail: 'Service "web" publishes different ports than compose declares.', expected: '8080/tcp', actual: '9090/tcp' },
        { kind: 'service-missing', service: 'db', detail: 'Service "db" is declared in compose but is not running.' },
        { kind: 'service-undeclared', service: 'sidecar', detail: 'Service "sidecar" is running but is not declared in compose.' },
      ],
    }));
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
    mockDriftReads(report({
      status: 'drifted',
      findings: [{ kind: 'service-missing', service: 'db', detail: 'Service "db" is declared in compose but is not running.' }],
    }));
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-status');
    expect(screen.getByText(/1 finding$/)).toBeInTheDocument();
  });

  it('renders the missing-runtime status', async () => {
    mockDriftReads(report({ status: 'missing-runtime', hasContainers: false }));
    render(<DriftPanel stackName="web" />);
    const status = await screen.findByTestId('drift-status');
    expect(status).toHaveAttribute('data-status', 'missing-runtime');
  });

  it('renders the unreachable status', async () => {
    mockDriftReads(report({ status: 'unreachable', hasContainers: false }));
    render(<DriftPanel stackName="web" />);
    const status = await screen.findByTestId('drift-status');
    expect(status).toHaveAttribute('data-status', 'unreachable');
    expect(screen.getByText(/Docker is unreachable/i)).toBeInTheDocument();
  });

  it('surfaces a compose parse error', async () => {
    mockDriftReads(report({
      parseError: 'Could not parse compose file: services.web.image must be a string',
    }));
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-status');
    expect(screen.getByText(/Could not parse compose file/i)).toBeInTheDocument();
  });

  it('shows a retry state (not a status) when the load fails', async () => {
    mockFailedDriftRead();
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
    // Routed by path rather than queued, because the tab reads two endpoints
    // and a positional queue would hand the retry's answer to the wrong one.
    let attempts = 0;
    vi.mocked(apiFetch).mockImplementation(async (path: string) => {
      if (String(path).startsWith('/gitops/applications')) return jsonRes({ application: undefined });
      attempts += 1;
      return attempts === 1 ? jsonRes({ error: 'down' }, false) : jsonRes(report({ status: 'in-sync' }));
    });
    render(<DriftPanel stackName="web" />);
    fireEvent.click(await screen.findByTestId('drift-retry-btn'));
    const status = await screen.findByTestId('drift-status');
    expect(status).toHaveAttribute('data-status', 'in-sync');
    expect(screen.queryByTestId('drift-retry-btn')).not.toBeInTheDocument();
  });

  it('re-checks on demand via the recheck endpoint (a POST), not the read GET', async () => {
    mockDriftReads(report({ status: 'in-sync' }));
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-status');
    // Counted per path rather than in total: the tab also reads the portfolio
    // for the posture, so a total would stop being about the drift read.
    const driftReads = () => vi.mocked(apiFetch).mock.calls.filter(([path]) => path === '/stacks/web/drift').length;
    const recheckPosts = () => vi.mocked(apiFetch).mock.calls.filter(([path]) => path === '/stacks/web/drift/recheck').length;
    expect(driftReads()).toBe(1);
    expect(recheckPosts()).toBe(0);
    fireEvent.click(screen.getByTestId('drift-recheck-btn'));
    await waitFor(() => expect(recheckPosts()).toBe(1));
    // The re-check is the write, so it must not read the passive endpoint again.
    expect(driftReads()).toBe(1);
    expect(apiFetch).toHaveBeenLastCalledWith('/stacks/web/drift/recheck', { method: 'POST' });
  });

  it('omits the temporal card when the report carries no temporal field (older node)', async () => {
    mockDriftReads(report({ status: 'in-sync' })); // no temporal field
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-status');
    expect(screen.queryByTestId('drift-temporal')).not.toBeInTheDocument();
  });

  it('shows "no deploy baseline" when the report has no temporal baseline', async () => {
    mockDriftReads(report({
      status: 'in-sync',
      temporal: { hasBaseline: false, sourceChanged: false, renderedChanged: false },
    }));
    render(<DriftPanel stackName="web" />);
    const temporal = await screen.findByTestId('drift-temporal');
    expect(temporal).toHaveAttribute('data-temporal', 'no-baseline');
  });

  it('flags a source change since the last deploy', async () => {
    mockDriftReads(report({
      status: 'in-sync',
      temporal: { hasBaseline: true, sourceChanged: true, renderedChanged: true },
    }));
    render(<DriftPanel stackName="web" />);
    const temporal = await screen.findByTestId('drift-temporal');
    expect(temporal).toHaveAttribute('data-temporal', 'source-changed');
    expect(screen.getByText(/changed since the last deploy/i)).toBeInTheDocument();
  });

  it('notes a formatting-only change when source changed but the model did not', async () => {
    mockDriftReads(report({
      status: 'in-sync',
      temporal: { hasBaseline: true, sourceChanged: true, renderedChanged: false },
    }));
    render(<DriftPanel stackName="web" />);
    const temporal = await screen.findByTestId('drift-temporal');
    expect(temporal).toHaveAttribute('data-temporal', 'source-changed');
    expect(screen.getByText(/formatting only/i)).toBeInTheDocument();
  });

  it('shows "matches last deploy" when the source is unchanged', async () => {
    mockDriftReads(report({
      status: 'in-sync',
      temporal: { hasBaseline: true, sourceChanged: false, renderedChanged: false },
    }));
    render(<DriftPanel stackName="web" />);
    const temporal = await screen.findByTestId('drift-temporal');
    expect(temporal).toHaveAttribute('data-temporal', 'matches');
  });

  it('renders the persisted drift history with open and resolved entries, labelled with when it was checked', async () => {
    mockDriftReads(report({
      status: 'drifted',
      findings: [{ kind: 'image-mismatch', service: 'web', detail: 'image differs' }],
      lastCheckedAt: Date.now(),
      ledger: [
        { service: 'web', kind: 'image-mismatch', message: 'image differs', detectedAt: Date.now(), resolvedAt: null },
        { service: 'db', kind: 'service-missing', message: 'db not running', detectedAt: Date.now() - 1000, resolvedAt: Date.now() },
      ],
    }));
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-status');
    expect(screen.getByText(/drift history/i)).toBeInTheDocument();
    expect(screen.getByText('open')).toBeInTheDocument();
    expect(screen.getByText('resolved')).toBeInTheDocument();
    // The history is timestamped so a stale row reads as history, not the live status.
    expect(screen.getByText(/checked/i)).toBeInTheDocument();
  });

  it('omits the last-checked label when the stack has never been reconciled', async () => {
    mockDriftReads(report({
      status: 'drifted',
      findings: [{ kind: 'image-mismatch', service: 'web', detail: 'image differs' }],
      lastCheckedAt: null,
      ledger: [
        { service: 'web', kind: 'image-mismatch', message: 'image differs', detectedAt: Date.now(), resolvedAt: null },
      ],
    }));
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-status');
    expect(screen.queryByText(/checked/i)).not.toBeInTheDocument();
  });

  it('labels a managed-path conflict without rendering the opaque service key', async () => {
    mockDriftReads(report({
      status: 'in-sync',
      ledger: [
        { service: 'deadbeefcafebabe', kind: 'managed-path-conflict', message: 'compose-primary local-modified', detectedAt: Date.now(), resolvedAt: null },
      ],
    }));
    render(<DriftPanel stackName="web" />);
    await screen.findByText('managed path');
    expect(screen.queryByText('deadbeefcafebabe')).not.toBeInTheDocument();
    expect(screen.getByText('compose-primary local-modified')).toBeInTheDocument();
  });
});

describe('DriftPanel GitOps state', () => {
  it('renders the source state and one card per target for a Direct stack', async () => {
    mockDriftReads(report({
      gitopsRevision: liveRevision({
        facets: facets({ source: plainSource('candidate_ready') }),
        targets: [target({ nodeId: 1, runtime: { status: 'applied_not_deployed' } })],
      }),
    }));
    render(<DriftPanel stackName="web" />);

    const source = await screen.findByTestId('gitops-source');
    expect(source).toHaveAttribute('data-state', 'candidate_ready');
    const targets = screen.getAllByTestId('gitops-target');
    expect(targets).toHaveLength(1);
    expect(targets[0]).toHaveAttribute('data-state', 'applied_not_deployed');
    expect(targets[0]).toHaveTextContent('local');
    expect(screen.queryByTestId('gitops-artifact')).not.toBeInTheDocument();
  });

  it('renders an artifact card for a live artifact facet', async () => {
    mockDriftReads(report({
      gitopsRevision: liveRevision({
        facets: facets({
          source: plainSource('application_generation_accepted', { candidateGenerationId: null }),
          artifact: liveArtifact(),
        }),
      }),
    }));
    render(<DriftPanel stackName="web" />);

    const card = await screen.findByTestId('gitops-artifact');
    expect(card).toHaveAttribute('data-state', 'artifact_exact');
  });

  it('omits the artifact card when identity does not apply', async () => {
    mockDriftReads(report({
      gitopsRevision: liveRevision({
        facets: facets({ source: plainSource('candidate_ready') }),
      }),
    }));
    render(<DriftPanel stackName="web" />);

    await screen.findByTestId('gitops-source');
    expect(screen.queryByTestId('gitops-artifact')).not.toBeInTheDocument();
  });

  it('shows no source card for a Blueprint-owned stack, only its targets', async () => {
    // The drift route resolves through whatever manages the directory. A
    // Blueprint application has no Git source, and inventing one would be a
    // claim the model never made.
    mockDriftReads(report({
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
    }));
    render(<DriftPanel stackName="web" />);

    await waitFor(() => expect(screen.getAllByTestId('gitops-target')).toHaveLength(2));
    expect(screen.queryByTestId('gitops-source')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('gitops-target')[1]).toHaveTextContent('edge-02');
  });

  it('reports an application the projection could not reach', async () => {
    mockDriftReads(report({
      gitopsRevision: absentRevision([missingApplicationLimitation]),
    }));
    render(<DriftPanel stackName="web" />);

    expect(await screen.findByTestId('gitops-fault')).toHaveTextContent(missingApplicationLimitation.message);
  });

  it('renders nothing new for a stack the model was never asked about', async () => {
    // The common case by far: no Git source, no Blueprint. A section header over
    // an empty block would be worse than silence.
    mockDriftReads(report({ gitopsRevision: absentRevision() }));
    render(<DriftPanel stackName="web" />);

    await screen.findByTestId('drift-status');
    expect(screen.queryByTestId('gitops-fault')).not.toBeInTheDocument();
    expect(screen.queryByTestId('gitops-source')).not.toBeInTheDocument();
    expect(screen.queryByText('gitops')).not.toBeInTheDocument();
  });

  it('renders exactly today output for a report from a node that predates the model', async () => {
    mockDriftReads(report({ status: 'drifted' }));
    render(<DriftPanel stackName="web" />);

    expect(await screen.findByTestId('drift-status')).toHaveAttribute('data-status', 'drifted');
    expect(screen.queryByTestId('gitops-source')).not.toBeInTheDocument();
    expect(screen.queryByTestId('gitops-fault')).not.toBeInTheDocument();
  });

  it('does not treat a live application caveat as a fault', async () => {
    // Live-arm limitations are caveats on state that is being reported. Reading
    // them as faults would recreate the conflation in the opposite direction.
    mockDriftReads(report({
      gitopsRevision: liveRevision({
        limitations: [{ code: 'repo_identity_invalid', message: 'Repository identity could not be read.', evidence: null }],
      }),
    }));
    render(<DriftPanel stackName="web" />);

    await screen.findByTestId('gitops-source');
    expect(screen.queryByTestId('gitops-fault')).not.toBeInTheDocument();
  });

  it('renders a drift item as expected against observed', async () => {
    mockDriftReads(report({
      gitopsRevision: liveRevision({ drift: [driftItem()] }),
    }));
    render(<DriftPanel stackName="web" />);

    expect(await screen.findByText('gitops drift')).toBeInTheDocument();
    // The backend now emits the runtime artifact drift item with artifact_set
    // expected identity and the reason describes the artifact mismatch.
    expect(screen.getByText('the running workload reports an artifact identity other than the expected artifact set')).toBeInTheDocument();
    // identityRefLabel formats artifact_set as "artifact <id> · <qualification>"
    expect(screen.getByText('artifact art-acce · exact')).toBeInTheDocument();
    // runtime_artifact identity is rendered as-is
    expect(screen.getByText('nginx@sha256:abc')).toBeInTheDocument();
  });

  it('names a target on a node this client has no record of', async () => {
    mockDriftReads(report({
      gitopsRevision: liveRevision({ targets: [target({ nodeId: 9 })] }),
    }));
    render(<DriftPanel stackName="web" />);

    expect(await screen.findByTestId('gitops-target')).toHaveTextContent('node 9');
  });

  it('renders no drift section while the backend derives no items', async () => {
    mockDriftReads(report({ gitopsRevision: liveRevision({ drift: [] }) }));
    render(<DriftPanel stackName="web" />);

    await screen.findByTestId('gitops-source');
    expect(screen.queryByText('gitops drift')).not.toBeInTheDocument();
  });

  it('renders placement and rollout cards, using the redacted reason as the preflight line', async () => {
    mockDriftReads(report({
      gitopsRevision: liveRevision({
        facets: facets({
          placement: {
            status: 'preflight_blocked',
            reason: 'Image scan is still running.',
            binding: {
              rolloutCandidateId: 'rc-1',
              acceptedGenerationId: 'gen-accepted',
              artifactSetId: 'art-1',
              intentRevisionId: 'int-1',
              requiredNodeIds: [1],
              sourceAcceptanceRef: 'src-acceptance-1',
              placementApprovalRef: 'plc-approval-1',
              preflightFingerprint: 'fp-1',
            },
          },
          rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'rc-1' },
        }),
      }),
    }));
    render(<DriftPanel stackName="web" />);

    const placement = await screen.findByTestId('gitops-placement');
    expect(placement).toHaveAttribute('data-state', 'preflight_blocked');
    expect(placement).toHaveTextContent('Image scan is still running.');
    expect(screen.getByTestId('gitops-rollout')).toHaveAttribute('data-state', 'rollout_not_executable');
  });

  it('renders the approval chips from the recorded refs and the facets', async () => {
    mockDriftReads(report({
      gitopsRevision: liveRevision({
        approvals: {
          sourceAcceptanceRef: 'src-acceptance-1',
          placementApprovalRef: null,
          rolloutAuthorizationRef: null,
          legacyCombinedApprovalRef: null,
        },
        facets: facets({
          placement: { status: 'placement_review_pending' },
          rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'rc-1' },
        }),
      }),
    }));
    render(<DriftPanel stackName="web" />);

    const chips = await screen.findByTestId('gitops-approvals');
    const source = within(chips).getByText('source accepted');
    expect(source.closest('[data-approval]')).toHaveAttribute('data-state', 'granted');
    const placement = within(chips).getByText('placement approval pending');
    expect(placement.closest('[data-approval]')).toHaveAttribute('data-state', 'pending');
    // No rollout ref and no facet saying it is outstanding: no rollout chip.
    expect(within(chips).queryByText(/rollout/)).not.toBeInTheDocument();
  });
});

/**
 * The tab must not report an application as settled while the portfolio reports
 * it unsettled.
 *
 * Each case drives the two reads the way a real install answers them: a
 * node-local revision whose facet cards all read healthy, next to a portfolio
 * row that cannot settle the application. Before the posture was shown here,
 * the first of these rendered as a clean tab with nothing to look at, which is
 * the contradiction this suite exists to prevent.
 */
describe('DriftPanel shows the canonical posture', () => {
  const healthyRevision = () => liveRevision({
    facets: facets({ source: plainSource('application_generation_accepted') }),
    targets: [target({ nodeId: 1, runtime: { status: 'synced_and_healthy' } })],
  });

  const renderWith = async (row: unknown) => {
    mockDriftReads(
      report({ status: 'in-sync', gitopsRevision: healthyRevision() }),
      { portfolio: { application: row } },
    );
    render(<DriftPanel stackName="web" />);
    return screen.findByTestId('gitops-posture');
  };

  it.each([
    ['converged', 'converged'],
    ['converged_qualified', 'converged · qualified'],
    ['failed', 'failed'],
    ['attention', 'needs attention'],
    ['in_progress', 'in progress'],
    ['unknown', 'unknown'],
  ] as const)('reports the %s posture the portfolio computed', async (posture, label) => {
    const card = await renderWith(portfolioRow({ posture }));
    expect(card).toHaveAttribute('data-posture', posture);
    expect(card).toHaveTextContent(label);
  });

  it('says converged only when the evidence behind it is current', async () => {
    // The one combination that may read as settled: every target reached, and
    // its evidence recorded against the generation now intended.
    const card = await renderWith(portfolioRow({
      posture: 'converged',
      targets: [portfolioTarget({ evidence: 'fresh' })],
      evidence: { partial: false, unreachableNodes: [], unknown: false },
    }));
    expect(card).toHaveAttribute('data-posture', 'converged');
    expect(card).toHaveTextContent(/complete, and current evidence/i);
    expect(card).toHaveTextContent('converged');
  });

  it('never reads as settled while a target holds stale evidence', async () => {
    const card = await renderWith(portfolioRow({
      posture: 'unknown',
      attention: ['target_stale'],
      targets: [portfolioTarget({ evidence: 'stale' })],
    }));
    expect(card).toHaveAttribute('data-posture', 'unknown');
    expect(card).not.toHaveTextContent('converged');
    const freshness = await screen.findByTestId('gitops-target-evidence');
    expect(freshness).toHaveAttribute('data-evidence', 'stale');
    expect(freshness).toHaveTextContent('evidence stale');
  });

  it('never reads as settled while a target is unknown', async () => {
    const card = await renderWith(portfolioRow({
      posture: 'unknown',
      targets: [portfolioTarget({ evidence: 'unknown' })],
    }));
    expect(card).toHaveAttribute('data-posture', 'unknown');
    const freshness = await screen.findByTestId('gitops-target-evidence');
    expect(freshness).toHaveAttribute('data-evidence', 'unknown');
    expect(freshness).toHaveTextContent('evidence unknown');
  });

  it('names a target the portfolio could not reach', async () => {
    const card = await renderWith(portfolioRow({
      posture: 'attention',
      attention: ['target_unreachable'],
      evidence: { partial: true, unreachableNodes: [7], unknown: false },
      targets: [portfolioTarget({ nodeId: 1, connectivity: 'unreachable', evidence: 'unknown' })],
    }));
    expect(card).toHaveTextContent('Not reached: node 7.');
    expect(card).toHaveTextContent('evidence behind this is incomplete');
  });

  it('reports a recorded health failure as failed, and the target evidence as fresh', async () => {
    // The health verdict is current and complete; it simply says the workload
    // is failing. Fresh evidence plus a failed posture is the case where the
    // posture, not the evidence quality, is the reason not to call it settled.
    const card = await renderWith(portfolioRow({
      posture: 'failed',
      attention: ['health_failed'],
      healthStatus: 'failed',
      targets: [portfolioTarget({ health: 'failed', evidence: 'fresh' })],
    }));
    expect(card).toHaveAttribute('data-posture', 'failed');
    expect(card).toHaveTextContent('Something was proven wrong');
    const freshness = await screen.findByTestId('gitops-target-evidence');
    expect(freshness).toHaveAttribute('data-evidence', 'fresh');
  });

  it('excludes tombstoned target history from the freshness it shows', async () => {
    // A withdrawn target is not current state. The portfolio excludes it, and
    // the target card must not resurrect it as an evidence claim.
    mockDriftReads(
      report({
        status: 'in-sync',
        gitopsRevision: liveRevision({
          facets: facets({ source: plainSource('application_generation_accepted') }),
          targets: [target({ nodeId: 1, runtime: { status: 'synced_and_healthy' } })],
        }),
      }),
      { portfolio: { application: portfolioRow({ targets: [portfolioTarget({ tombstoned: true, evidence: 'stale' })] }) } },
    );
    render(<DriftPanel stackName="web" />);
    const card = await screen.findByTestId('gitops-posture');
    expect(card).toHaveAttribute('data-posture', 'converged');
    // The live target has no portfolio entry, so it reads as unknown rather
    // than inheriting the tombstoned target's stale evidence.
    const freshness = await screen.findByTestId('gitops-target-evidence');
    expect(freshness).toHaveAttribute('data-evidence', 'unknown');
  });

  it('says the posture is unreadable when the read was permitted and the server could not answer', async () => {
    // Reporting this as "no GitOps application" would let a clean-looking tab
    // stand in for an answer Sencho could not give, so a genuine fault still
    // warns.
    mockDriftReads(
      report({ status: 'in-sync', gitopsRevision: healthyRevision() }),
      { portfolio: { application: undefined, ok: false, status: 500 } },
    );
    render(<DriftPanel stackName="web" />);
    const card = await screen.findByTestId('gitops-posture');
    expect(card).toHaveAttribute('data-posture', 'unreadable');
    expect(card).toHaveTextContent('describe one node, not the application');
    expect(card).not.toHaveTextContent('converged');
  });

  it.each([
    // The portfolio route answers 403 for a Blueprint the caller cannot read
    // without the fleet-wide node grant, and 404 both for a missing application
    // and for one outside the caller's grants. Neither status describes a fault
    // in the state of the world, so neither earns a warning: warning about one
    // would tell a stack-scoped operator that something is wrong with a stack they
    // are fully entitled to read. The tab keeps the node-local view it always had
    // and says nothing.
    ['403', 403],
    ['404', 404],
  ])('shows no posture and no warning on a %s', async (_label, status) => {
    mockDriftReads(
      report({ status: 'in-sync', gitopsRevision: healthyRevision() }),
      { portfolio: { application: undefined, ok: false, status } },
    );
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-status');
    await waitFor(() => expect(screen.queryByTestId('gitops-posture')).not.toBeInTheDocument());
    expect(screen.getByTestId('drift-status')).toBeInTheDocument();
  });

  it('never attempts the posture read for a detached stack', async () => {
    // A detached Direct stack still projects a revision, because the tab is
    // useful for reading what a stack was. The portfolio lists live applications
    // only, so building an id here would 404 into a warning about an application
    // the portfolio does not list.
    mockDriftReads(report({
      status: 'in-sync',
      gitopsRevision: liveRevision({
        targetMode: 'direct',
        lifecycleStatus: 'detached',
        applicationId: 'app-detached',
        blueprintId: null,
        // A detached application's source facet is `not_live`, which is the
        // status the deriver projects for an application no longer live.
        facets: facets({ source: { ...sourceIdentity(), status: 'not_live', lifecycleStatus: 'detached' } }),
      }),
    }));
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-status');
    await waitFor(() => expect(screen.queryByTestId('gitops-posture')).not.toBeInTheDocument());
    const postureCalls = vi.mocked(apiFetch).mock.calls.filter(([path]) => String(path).startsWith('/gitops/applications'));
    expect(postureCalls).toHaveLength(0);
  });

  it('shows no posture at all for a stack with no GitOps application', async () => {
    mockDriftReads(report({ status: 'in-sync' }));
    render(<DriftPanel stackName="web" />);
    await screen.findByTestId('drift-status');
    expect(screen.queryByTestId('gitops-posture')).not.toBeInTheDocument();
  });

  it('renders a posture this build has no wording for as an explicit unknown', async () => {
    // A tab left open across a Sencho upgrade holds this build's JavaScript
    // against a newer backend, which can report a posture value this build has
    // never seen. The sibling application view defends against that; the tab
    // must too, because a throw here takes the whole tab down.
    const card = await renderWith({
      ...portfolioRow(),
      posture: 'settled_by_a_newer_build',
    } as unknown as ReturnType<typeof portfolioRow>);
    expect(card).toHaveAttribute('data-posture', 'settled_by_a_newer_build');
    expect(card).toHaveTextContent('unknown');
    expect(card).toHaveTextContent('does not know');
  });

  it('shows the age of the evidence behind each drift item', async () => {    mockDriftReads(
      report({
        status: 'drifted',
        gitopsRevision: liveRevision({
          drift: [driftItem({ freshnessAt: Date.now() - 3_600_000 })],
        }),
      }),
    );
    render(<DriftPanel stackName="web" />);
    const freshness = await screen.findByTestId('gitops-drift-freshness');
    expect(freshness).toHaveTextContent(/evidence .*ago/);
  });

  it('says a drift item is undated rather than implying a recent check', async () => {
    mockDriftReads(
      report({
        status: 'drifted',
        gitopsRevision: liveRevision({ drift: [driftItem({ freshnessAt: null })] }),
      }),
    );
    render(<DriftPanel stackName="web" />);
    const freshness = await screen.findByTestId('gitops-drift-freshness');
    expect(freshness).toHaveTextContent('evidence undated');
  });
});
