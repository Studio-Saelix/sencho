import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  absentRevision,
  driftItem,
  facets,
  liveRevision,
  missingApplicationLimitation,
  noApprovals,
  target,
} from '@/__tests__/gitopsFixtures';
import { apiFetch } from '@/lib/api';
import { SENCHO_NAVIGATE_EVENT, SENCHO_OPEN_STACK_EVENT } from '@/lib/events';
import { ATTENTION_LABEL } from '@/lib/gitopsPortfolio';
import { PLACEMENT_STATE, ROLLOUT_STATE } from '@/lib/gitopsState';
import GitOpsApplicationDetail from './GitOpsApplicationDetail';
import { GitOpsApplicationView } from './GitOpsApplicationView';
import { detailResponse } from './applicationFixtures';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);

afterEach(() => {
  mockFetch.mockReset();
  vi.restoreAllMocks();
});

const blueprintProjection = liveRevision({
  targetMode: 'blueprint',
  applicationId: 'app-bp',
  stackName: null,
  blueprintId: 3,
  rolloutGenerationId: 'rollgen-0001-abcdef',
  approvals: { ...noApprovals, sourceAcceptanceRef: 'src-accept-123456', placementApprovalRef: 'place-approve-99' },
  facets: facets({
    placement: { status: 'placement_review_pending' },
    rollout: { status: 'rollout_paused', pauseAt: 1, pauseReason: 'canary health gate failed' },
  }),
  targets: [
    target({ nodeId: 2, stackName: 'shop', observedArtifactIdentity: { kind: 'qualified', identity: 'shop@sha256:111', observedAt: 1 } }),
    target({ nodeId: 3, stackName: 'shop', runtime: { status: 'deploying' }, connectivity: 'unreachable' }),
  ],
  drift: [driftItem()],
});

const blueprintRow = {
  id: 'bp:3',
  targetMode: 'blueprint' as const,
  name: 'shop',
  stackName: null,
  blueprintId: 3,
  nodeId: null,
  nodeName: null,
  targets: [
    { nodeId: 2, nodeName: 'edge-a', stackName: 'shop', runtime: 'synced_and_healthy', health: 'passed', connectivity: 'reachable', evidence: 'fresh' as const },
    { nodeId: 3, nodeName: 'edge-b', stackName: 'shop', runtime: 'deploying', health: 'unknown', connectivity: 'unreachable', evidence: 'stale' as const },
  ],
  attention: ['placement_review_pending'],
  evidence: { partial: true, unreachableNodes: [3], unknown: false },
};

describe('GitOpsApplicationDetail', () => {
  it('renders a Direct application: identity, source card, and its one target', () => {
    render(<GitOpsApplicationDetail detail={detailResponse()} />);

    expect(screen.getByText('Direct node')).toBeInTheDocument();
    expect(screen.getByText('example.test/acme/infra')).toBeInTheDocument();
    expect(screen.getAllByText('a1b2c3d')).toHaveLength(2);
    expect(screen.getByTestId('gitops-source')).toHaveAttribute('data-state', 'candidate_ready');
    expect(screen.getByTestId('gitops-placement')).toHaveAttribute('data-state', 'unbound_direct');
    expect(screen.queryByTestId('gitops-rollout')).toBeNull();
    expect(screen.queryByText('Rollout generation')).toBeNull();
    const targets = screen.getAllByTestId('gitops-target');
    expect(targets).toHaveLength(1);
    expect(within(targets[0]).getByText('local · bookstack')).toBeInTheDocument();
  });

  it('renders a Blueprint application with decomposed authority, placement and rollout apart', () => {
    render(<GitOpsApplicationDetail detail={detailResponse(blueprintRow, blueprintProjection)} />);

    const chips = screen.getByTestId('gitops-approvals');
    expect(within(chips).getByText('source accepted')).toBeInTheDocument();
    expect(within(chips).getByText('placement approved')).toBeInTheDocument();

    expect(screen.getByTestId('gitops-placement')).toHaveTextContent(PLACEMENT_STATE.placement_review_pending.label);
    const rollout = screen.getByTestId('gitops-rollout');
    expect(rollout).toHaveTextContent(ROLLOUT_STATE.rollout_paused.label);
    expect(rollout).toHaveTextContent('canary health gate failed');

    expect(screen.getByText('#3')).toBeInTheDocument();
    expect(screen.getByText('rollgen-')).toHaveAttribute('title', 'rollgen-0001-abcdef');
  });

  it('keeps every target visible, with node names and observed artifact evidence', () => {
    render(<GitOpsApplicationDetail detail={detailResponse(blueprintRow, blueprintProjection)} />);

    const targets = screen.getAllByTestId('gitops-target');
    expect(targets.map(t => t.getAttribute('data-state'))).toEqual(['synced_and_healthy', 'deploying']);
    expect(targets[0]).toHaveTextContent('edge-a · shop');
    expect(targets[0]).toHaveTextContent('observed shop@sha256:111 (qualified)');
    expect(targets[1]).toHaveTextContent('edge-b · shop');
    expect(targets[1]).toHaveTextContent('unreachable');
  });

  it('keeps a target whose status this build does not know, and says so', () => {
    const unknownRuntime = JSON.parse('{"status":"from_a_newer_node"}') as ReturnType<typeof target>['runtime'];
    const projection = liveRevision({ targets: [target({ runtime: unknownRuntime })] });
    render(<GitOpsApplicationDetail detail={detailResponse({}, projection)} />);

    const card = screen.getByTestId('gitops-target');
    expect(card).toHaveAttribute('data-state', 'from_a_newer_node');
    expect(card).toHaveTextContent('unrecognized state');
    expect(card).toHaveTextContent('"from_a_newer_node"');
  });

  it('names a target mode and an observed artifact kind this build does not know', () => {
    const unknownMode = JSON.parse('"from_a_newer_node"') as ReturnType<typeof detailResponse>['application']['targetMode'];
    const unknownObserved = JSON.parse('{"kind":"from_a_newer_node"}') as ReturnType<typeof target>['observedArtifactIdentity'];
    const projection = liveRevision({ targets: [target({ observedArtifactIdentity: unknownObserved })] });
    render(<GitOpsApplicationDetail detail={detailResponse({ targetMode: unknownMode }, projection)} />);

    expect(screen.getByText('unrecognized (from_a_newer_node)')).toBeInTheDocument();
    expect(screen.getByTestId('gitops-target')).toHaveTextContent('observed artifact of unrecognized kind "from_a_newer_node"');
  });

  it('states partial evidence by node, and keeps attention reasons inline', () => {
    render(<GitOpsApplicationDetail detail={detailResponse(blueprintRow, blueprintProjection)} />);

    expect(screen.getByTestId('gitops-application-evidence')).toHaveTextContent('edge-b could not be reached');
    const attention = screen.getByTestId('gitops-application-attention');
    const label = ATTENTION_LABEL.placement_review_pending;
    expect(label).toBeDefined();
    expect(attention).toHaveTextContent(label!.line);
  });

  it('renders classified drift through the shared drift row', () => {
    render(<GitOpsApplicationDetail detail={detailResponse(blueprintRow, blueprintProjection)} />);
    expect(screen.getByText(driftItem().reason)).toBeInTheDocument();
  });

  it('says there is no revision state rather than inventing facets', () => {
    render(<GitOpsApplicationDetail detail={detailResponse({}, absentRevision())} />);
    expect(screen.getByTestId('gitops-no-revision')).toBeInTheDocument();
    expect(screen.queryByTestId('gitops-source')).toBeNull();
    expect(screen.queryByTestId('gitops-approvals')).toBeNull();
    expect(screen.queryByTestId('gitops-target')).toBeNull();
  });

  it('shows a fault, not the empty state, when the projection could not reach the application', () => {
    render(<GitOpsApplicationDetail detail={detailResponse({}, absentRevision([missingApplicationLimitation]))} />);
    expect(screen.getByTestId('gitops-fault')).toHaveTextContent(missingApplicationLimitation.message);
    expect(screen.queryByTestId('gitops-no-revision')).toBeNull();
  });
});

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

describe('GitOpsApplicationView', () => {
  it('hands a Direct application off to its stack Git panel', async () => {
    mockFetch.mockResolvedValueOnce(ok(detailResponse()));
    const listener = vi.fn();
    window.addEventListener(SENCHO_OPEN_STACK_EVENT, listener);

    render(<GitOpsApplicationView id="1:app-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /open stack/i }));

    expect(screen.getByRole('heading', { name: 'bookstack' })).toBeInTheDocument();
    expect(screen.getByTestId('gitops-application-posture')).toHaveTextContent('converged');
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ nodeId: 1, stackName: 'bookstack', destination: 'git' });
    window.removeEventListener(SENCHO_OPEN_STACK_EVENT, listener);
  });

  it('hands a Blueprint application off to the Fleet deployments tab', async () => {
    mockFetch.mockResolvedValueOnce(ok(detailResponse(blueprintRow, blueprintProjection)));
    const listener = vi.fn();
    window.addEventListener(SENCHO_NAVIGATE_EVENT, listener);

    render(<GitOpsApplicationView id="bp:3" />);
    fireEvent.click(await screen.findByRole('button', { name: /open blueprint deployments/i }));

    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ view: 'fleet', fleetTab: 'deployments' });
    window.removeEventListener(SENCHO_NAVIGATE_EVENT, listener);
  });

  it('explains an unreadable application and still offers a retry, since a node may be mid-transition', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: 'Application not found' }) } as unknown as Response);
    render(<GitOpsApplicationView id="1:gone" />);
    await waitFor(() => expect(screen.getByTestId('gitops-application-error')).toHaveAttribute('data-error', 'not_readable'));
    expect(screen.getByText('This application is not available')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /all applications/i })).toBeInTheDocument();
  });

  it('offers no retry for a node too old to answer, and retries an unreachable one', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 502, json: async () => ({ error: 'too old', code: 'node_unsupported' }),
    } as unknown as Response);
    const { unmount } = render(<GitOpsApplicationView id="2:a" />);
    await waitFor(() => expect(screen.getByTestId('gitops-application-error')).toHaveAttribute('data-error', 'unsupported'));
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    unmount();

    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({ error: 'Owning node is unreachable' }) } as unknown as Response);
    render(<GitOpsApplicationView id="2:a" />);
    await waitFor(() => expect(screen.getByTestId('gitops-application-error')).toHaveAttribute('data-error', 'unreachable'));
    mockFetch.mockResolvedValueOnce(ok(detailResponse()));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'bookstack' })).toBeInTheDocument();
  });

  it('shows a last-known banner with a retry when a refresh fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce(ok(detailResponse()));
    render(<GitOpsApplicationView id="1:app-1" />);
    await screen.findByRole('heading', { name: 'bookstack' });

    mockFetch.mockRejectedValueOnce(new Error('network down'));
    window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'gitops' } }));
    expect(await screen.findByText(/last refresh failed/i)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'bookstack' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('names a posture this build does not know instead of dropping the chip', async () => {
    const unknownPosture = JSON.parse('"from_a_newer_node"') as ReturnType<typeof detailResponse>['application']['posture'];
    mockFetch.mockResolvedValueOnce(ok(detailResponse({ posture: unknownPosture })));
    render(<GitOpsApplicationView id="1:app-1" />);
    expect(await screen.findByTestId('gitops-application-posture')).toHaveTextContent('unrecognized (from_a_newer_node)');
  });

  it('explains a malformed link without a retry, and a server failure with one', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, json: async () => ({ error: 'Application id is not a portfolio id' }) } as unknown as Response);
    const { unmount } = render(<GitOpsApplicationView id="nonsense" />);
    await waitFor(() => expect(screen.getByTestId('gitops-application-error')).toHaveAttribute('data-error', 'invalid_link'));
    expect(screen.getByText('This link does not point to a GitOps application')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    unmount();

    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'hub exploded' }) } as unknown as Response);
    render(<GitOpsApplicationView id="1:app-1" />);
    await waitFor(() => expect(screen.getByTestId('gitops-application-error')).toHaveAttribute('data-error', 'failed'));
    expect(screen.getByText('hub exploded')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('offers no hand-off when the row names no surface that could open it', async () => {
    mockFetch.mockResolvedValueOnce(ok(detailResponse({ nodeId: null })));
    render(<GitOpsApplicationView id="1:app-1" />);
    await screen.findByRole('heading', { name: 'bookstack' });
    expect(screen.queryByRole('button', { name: /open stack/i })).toBeNull();
  });
});
