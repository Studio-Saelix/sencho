/**
 * The decomposed authority action row: which action each facet state offers,
 * who may see it, and what a write reports back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/context/NodeContext', () => ({
  useNodes: () => ({ nodes: [{ id: 1, name: 'local', type: 'local', is_default: true }] }),
}));
import { approvedScope, facets, liveRevision, noApprovals, plainSource, sourceIdentity, target, unapprovedScope } from '@/__tests__/gitopsFixtures';
import type { FutureRolloutAuthorizationBinding, GitOpsRevisionLive } from '@/types/gitops';
import type { PermissionAction } from '@/context/AuthContext';

vi.mock('@/lib/gitopsAuthorityApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/gitopsAuthorityApi')>();
  return {
    ...actual,
    acceptGitOpsSource: vi.fn(),
    fetchGitOpsSource: vi.fn(),
    authorizeGitOpsRollout: vi.fn(),
    setGitOpsRolloutAuthorizationPolicy: vi.fn(),
  };
});

vi.mock('@/components/blueprints/RolloutPreviewDialog', () => ({
  RolloutPreviewDialog: ({ open }: { open: boolean }) => (
    open ? <div data-testid="placement-dialog" /> : null
  ),
}));

vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import { acceptGitOpsSource, authorizeGitOpsRollout, fetchGitOpsSource, setGitOpsRolloutAuthorizationPolicy } from '@/lib/gitopsAuthorityApi';
import { toast } from '@/components/ui/toast-store';
import GitOpsAuthorityActions from './GitOpsAuthorityActions';

const binding: FutureRolloutAuthorizationBinding = {
  rolloutCandidateId: 'cand-1',
  acceptedGenerationId: 'gen-1',
  artifactSetId: 'art-1',
  intentRevisionId: 'intent-1',
  requiredNodeIds: [1],
  sourceAcceptanceRef: 'src-1',
  placementApprovalRef: 'place-1',
  preflightFingerprint: 'f'.repeat(64),
};

function blueprintRevision(overrides: Partial<GitOpsRevisionLive> = {}): GitOpsRevisionLive {
  return liveRevision({
    targetMode: 'blueprint',
    applicationId: 'app-1',
    stackName: null,
    blueprintId: 5,
    approvals: noApprovals,
    // No placement approval yet, so a confirmation says the acceptance does not
    // start a rollout. Tests that approve placement set the scope as well as
    // the ref, because the scope is what the confirmation reads.
    approvedRolloutScope: unapprovedScope,
    facets: facets({
      source: plainSource('application_generation_accepted', { candidateGenerationId: null }),
      placement: { status: 'placement_review_pending' },
      rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' },
    }),
    ...overrides,
  });
}

/**
 * An application whose placement approval froze `nodeIds`, which is what a
 * confirmation names as the rollout scope.
 */
function placementApproved(nodeIds: number[], overrides: Partial<GitOpsRevisionLive> = {}): GitOpsRevisionLive {
  return blueprintRevision({
    approvals: { ...noApprovals, placementApprovalRef: 'place-1' },
    approvedRolloutScope: approvedScope(nodeIds),
    ...overrides,
  });
}

function sourcePending(): GitOpsRevisionLive {
  return blueprintRevision({
    facets: facets({
      source: plainSource('source_review_pending'),
      placement: { status: 'source_acceptance_pending', sourceAcceptanceRef: null, candidateGenerationId: 'gen-candidate' },
      rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' },
    }),
  });
}

function placementPending(): GitOpsRevisionLive {
  return blueprintRevision({
    approvals: { ...noApprovals, sourceAcceptanceRef: 'src-1' },
  });
}

function rolloutPending(): GitOpsRevisionLive {
  return blueprintRevision({
    approvals: { ...noApprovals, sourceAcceptanceRef: 'src-1', placementApprovalRef: 'place-1' },
    facets: facets({
      source: plainSource('application_generation_accepted', { candidateGenerationId: null }),
      placement: { status: 'rollout_authorization_pending', rolloutAuthorizationRef: null, binding },
      rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' },
    }),
  });
}

/** An application whose placement policy is configured and read. */
function withPlacementPolicy(projection: GitOpsRevisionLive): GitOpsRevisionLive {
  return {
    ...projection,
    authorityPolicies: [
      {
        domain: 'placement',
        configured: 'bounded_auto',
        effectiveFrozen: null,
        decision: 'awaiting_operator',
        reason: null,
        decidedBy: null,
        decidedAt: null,
      },
    ],
  };
}

/** An application whose rollout authorization policy is configured and read. */
function withRolloutPolicy(projection: GitOpsRevisionLive): GitOpsRevisionLive {
  return {
    ...projection,
    authorityPolicies: [
      {
        domain: 'rollout_authorization',
        configured: 'manual',
        effectiveFrozen: null,
        decision: 'awaiting_operator',
        reason: null,
        decidedBy: null,
        decidedAt: null,
      },
    ],
  };
}

/** A Blueprint demoted to Inline, which is still placed but has no Git lifecycle. */
function asInline(projection: GitOpsRevisionLive): GitOpsRevisionLive {
  return { ...projection, targetMode: 'inline_blueprint' };
}

function renderActions(
  projection: GitOpsRevisionLive,
  can: (
    action: PermissionAction,
    resourceType?: string,
    resourceId?: string,
    nodeId?: number | null,
  ) => boolean = () => true,
  onChanged: () => void = () => {},
  blueprintEnabled = true,
) {
  return render(
    <GitOpsAuthorityActions
      applicationId="bp:5"
      blueprintId={5}
      blueprintName="web"
      projection={projection}
      onChanged={onChanged}
      can={can}
      blueprintEnabled={blueprintEnabled}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

/**
 * What Accept source sends for a fixture with no placement approval and no
 * rollout policy. The other confirmations assert their own claim, so this one
 * is only ever the default shape.
 */
const UNAPPROVED_CLAIM = { placementApprovalRef: null, rolloutMayStart: false };

async function confirmSourceAccept(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByTestId('gitops-action-accept-source'));
  const dialog = await screen.findByRole('alertdialog');
  await user.click(within(dialog).getByRole('button', { name: 'Accept source' }));
}

describe('GitOpsAuthorityActions', () => {
  it('accepts the reviewed source generation as the next step', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    vi.mocked(acceptGitOpsSource).mockResolvedValue({ ok: true, materialized: true, artifactResolved: true, dispatched: false, note: null });
    renderActions(sourcePending(), () => true, onChanged);

    await confirmSourceAccept(user);
    await waitFor(() => expect(acceptGitOpsSource).toHaveBeenCalledWith('bp:5', 'gen-candidate', UNAPPROVED_CLAIM));
    expect(toast.success).toHaveBeenCalledWith('Source revision accepted');
    expect(onChanged).toHaveBeenCalled();
  });

  it('asks before accepting a commit that rollout authorization can deploy', async () => {
    const user = userEvent.setup();
    vi.mocked(acceptGitOpsSource).mockResolvedValue({ ok: true, materialized: true, artifactResolved: true, dispatched: true, note: null });
    const pending = sourcePending();
    renderActions({
      ...pending,
      approvals: { ...pending.approvals, placementApprovalRef: 'place-1' },
      approvedRolloutScope: approvedScope([1]),
      authorityPolicies: [
        {
          domain: 'source',
          configured: 'manual',
          effectiveFrozen: null,
          decision: 'awaiting_operator',
          reason: null,
          decidedBy: null,
          decidedAt: null,
        },
        {
          domain: 'rollout_authorization',
          configured: 'automatic',
          effectiveFrozen: null,
          decision: 'policy_authorized',
          reason: null,
          decidedBy: null,
          decidedAt: null,
        },
      ],
    });

    await user.click(screen.getByTestId('gitops-action-accept-source'));
    expect(acceptGitOpsSource).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Accept a1b2c3d.');
    expect(dialog).toHaveTextContent('Placement is approved for local.');
    expect(dialog).toHaveTextContent('Rollout authorization can start that rollout.');
    expect(dialog).toHaveTextContent('Starting a rollout is not the same as it finishing.');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(acceptGitOpsSource).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();

    await confirmSourceAccept(user);
    // The request carries what the dialog read, so the server can refuse it if
    // the placement it named or the rollout it promised has moved on.
    await waitFor(() => expect(acceptGitOpsSource).toHaveBeenCalledWith(
      'bp:5',
      'gen-candidate',
      { placementApprovalRef: 'place-1', rolloutMayStart: true },
    ));
  });

  it('says the rollout stays waiting when authorization needs an operator', async () => {
    const user = userEvent.setup();
    renderActions({
      ...sourcePending(),
      approvals: { ...noApprovals, placementApprovalRef: 'place-1' },
      approvedRolloutScope: approvedScope([1]),
      authorityPolicies: [
        {
          domain: 'rollout_authorization',
          configured: 'manual',
          effectiveFrozen: null,
          decision: 'awaiting_operator',
          reason: null,
          decidedBy: null,
          decidedAt: null,
        },
      ],
    });

    await user.click(screen.getByTestId('gitops-action-accept-source'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Accept a1b2c3d.');
    expect(dialog).toHaveTextContent('Placement is approved for local.');
    expect(dialog).toHaveTextContent('The rollout stays waiting for you.');
    const acceptBody = screen.getByTestId('gitops-source-confirm-body');
    expect(acceptBody).toBeVisible();
    expect(acceptBody.closest('.sr-only')).toBeNull();
    expect(dialog).not.toHaveTextContent('can start a rollout');
    expect(acceptGitOpsSource).not.toHaveBeenCalled();
  });

  it('posts the generation that was named when Accept source opened', async () => {
    const user = userEvent.setup();
    vi.mocked(acceptGitOpsSource).mockResolvedValue({ ok: true, materialized: true, artifactResolved: true, dispatched: false, note: null });
    const view = renderActions(sourcePending());
    await user.click(screen.getByTestId('gitops-action-accept-source'));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Accept a1b2c3d.');

    const later = sourcePending();
    later.facets = {
      ...later.facets,
      source: plainSource('source_review_pending', {
        candidateGenerationId: 'gen-new',
        fetchedCommitSha: 'ffff000011112222333344445555666677778888',
      }),
    };
    view.rerender(
      <GitOpsAuthorityActions
        applicationId="bp:5"
        blueprintId={5}
        blueprintName="web"
        projection={later}
        onChanged={() => {}}
        can={() => true}
        blueprintEnabled
      />,
    );

    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Accept a1b2c3d.');
    expect(dialog).not.toHaveTextContent('ffff000');
    await user.click(within(dialog).getByRole('button', { name: 'Accept source' }));
    await waitFor(() => expect(acceptGitOpsSource).toHaveBeenCalledWith('bp:5', 'gen-candidate', UNAPPROVED_CLAIM));
    expect(acceptGitOpsSource).not.toHaveBeenCalledWith('bp:5', 'gen-new', expect.anything());
  });

  it('says acceptance does not start a rollout when placement is not approved', async () => {
    const user = userEvent.setup();
    renderActions(sourcePending());
    await user.click(screen.getByTestId('gitops-action-accept-source'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Placement is not approved yet, so this acceptance does not start a rollout.');
    expect(dialog).not.toHaveTextContent('Placement is approved');
    expect(dialog).not.toHaveTextContent('can start a rollout');
    expect(acceptGitOpsSource).not.toHaveBeenCalled();
  });

  // The scope a confirmation names is the placement approval's frozen set, and
// not the nodes a target row happens to exist on. The two disagree whenever
// placement has moved since the last rollout ran, which is exactly when a
// confirmation is worth reading: the observed set can name a node the rollout
// will withdraw from, and can omit one it will place on for the first time.
it('names the approved scope, not the observed targets', async () => {
    const user = userEvent.setup();
    renderActions(placementApproved([3], {
      facets: facets({
        source: plainSource('source_review_pending'),
        placement: { status: 'source_acceptance_pending', sourceAcceptanceRef: null, candidateGenerationId: 'gen-candidate' },
        rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' },
      }),
      targets: [
        target(),
        target({ nodeId: 2, stackName: 'retired', tombstoned: true }),
      ],
    }));

    await user.click(screen.getByTestId('gitops-action-accept-source'));
    const dialog = await screen.findByRole('alertdialog');
    // Node 1 still has an active observed target row and node 3 has none. The
    // approval names node 3, so the confirmation names node 3 and not node 1.
    expect(dialog).toHaveTextContent('Placement is approved for node 3.');
    expect(dialog).not.toHaveTextContent('node 1');
    expect(dialog).not.toHaveTextContent('node 2');
    expect(acceptGitOpsSource).not.toHaveBeenCalled();
  });

it('treats a projection carrying no scope field as unreadable, not as approved', async () => {
    // The mixed-fleet case: the control node runs this build, the projection
    // came from a node on an older one, so the field is absent. The scope
    // cannot be proven, and a confirmation must not claim an approval it could
    // not read. This is why the field is optional on the wire: dropping the
    // whole confirmation would be worse, since the action is still reachable.
    const user = userEvent.setup();
    const projection = placementApproved([3], {
      facets: facets({
        source: plainSource('source_review_pending'),
        placement: { status: 'source_acceptance_pending', sourceAcceptanceRef: null, candidateGenerationId: 'gen-candidate' },
        rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' },
      }),
    });
    delete projection.approvedRolloutScope;
    renderActions(projection);

    await user.click(screen.getByTestId('gitops-action-accept-source'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('The recorded placement approval cannot be read, so this acceptance does not start a rollout.');
    expect(dialog).not.toHaveTextContent('Placement is approved');
    expect(acceptGitOpsSource).not.toHaveBeenCalled();
  });

it('names every approved node in a multi-node scope', async () => {
    const user = userEvent.setup();
    renderActions(placementApproved([1, 3], {
      facets: facets({
        source: plainSource('source_review_pending'),
        placement: { status: 'source_acceptance_pending', sourceAcceptanceRef: null, candidateGenerationId: 'gen-candidate' },
        rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' },
      }),
    }));

    await user.click(screen.getByTestId('gitops-action-accept-source'));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Placement is approved for local, node 3.');
  });

it('says the scope is unreadable rather than naming a set it could not prove', async () => {
    const user = userEvent.setup();
    renderActions({
      ...placementApproved([3], {
        facets: facets({
          source: plainSource('source_review_pending'),
          placement: { status: 'source_acceptance_pending', sourceAcceptanceRef: null, candidateGenerationId: 'gen-candidate' },
          rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' },
        }),
      }),
      approvedRolloutScope: { status: 'unresolved', approvalRef: 'place-1', reason: 'approval_does_not_resolve' },
    });

    await user.click(screen.getByTestId('gitops-action-accept-source'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('The recorded placement approval cannot be read, so this acceptance does not start a rollout.');
    expect(dialog).not.toHaveTextContent('Placement is approved');
    expect(acceptGitOpsSource).not.toHaveBeenCalled();
  });

it('says an approval over no nodes approves no nodes, not an empty destination', async () => {
    const user = userEvent.setup();
    renderActions(placementApproved([], {
      facets: facets({
        source: plainSource('source_review_pending'),
        placement: { status: 'source_acceptance_pending', sourceAcceptanceRef: null, candidateGenerationId: 'gen-candidate' },
        rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' },
      }),
    }));

    await user.click(screen.getByTestId('gitops-action-accept-source'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Placement is approved, but for no nodes.');
    expect(dialog).not.toHaveTextContent('no targets');
    expect(acceptGitOpsSource).not.toHaveBeenCalled();
  });

it('says nothing is approved on the first placement, before any scope exists', async () => {
    const user = userEvent.setup();
    renderActions(blueprintRevision({
      facets: facets({
        source: plainSource('source_review_pending'),
        placement: { status: 'source_acceptance_pending', sourceAcceptanceRef: null, candidateGenerationId: 'gen-candidate' },
        rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' },
      }),
    }));

    await user.click(screen.getByTestId('gitops-action-accept-source'));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('Placement is not approved yet, so this acceptance does not start a rollout.');
    expect(dialog).not.toHaveTextContent('no targets');
    expect(acceptGitOpsSource).not.toHaveBeenCalled();
  });

  it('reports a refused source acceptance without refreshing', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    vi.mocked(acceptGitOpsSource).mockRejectedValue(new Error('candidate is blocked'));
    renderActions(sourcePending(), () => true, onChanged);

    await confirmSourceAccept(user);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('candidate is blocked'));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('warns with the note when acceptance leaves the artifact identity unresolved', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const note = 'the artifact identity could not be resolved yet; the next reconcile retries it';
    vi.mocked(acceptGitOpsSource).mockResolvedValue({
      ok: true,
      materialized: true,
      artifactResolved: false,
      dispatched: false,
      note,
    });
    renderActions(sourcePending(), () => true, onChanged);

    await confirmSourceAccept(user);

    // The acceptance stands; the note names what is still missing.
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(`Source revision accepted. ${note}`));
    expect(onChanged).toHaveBeenCalled();
  });

  it('opens the reviewed plan for placement approval', async () => {
    const user = userEvent.setup();
    renderActions(placementPending());
    await user.click(screen.getByTestId('gitops-action-approve-placement'));
    expect(await screen.findByTestId('placement-dialog')).toBeInTheDocument();
  });

  it('authorizes the rollout and reports a started dispatch', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    vi.mocked(authorizeGitOpsRollout).mockResolvedValue({ dispatched: true, note: null });
    renderActions(rolloutPending(), () => true, onChanged);

    await user.click(screen.getByTestId('gitops-action-authorize-rollout'));
    await waitFor(() => expect(authorizeGitOpsRollout).toHaveBeenCalledWith('bp:5'));
    expect(toast.success).toHaveBeenCalledWith('Rollout authorized and started');
    expect(onChanged).toHaveBeenCalled();
  });

  it('keeps a granted authorization visible as a warning when the rollout did not start', async () => {
    const user = userEvent.setup();
    vi.mocked(authorizeGitOpsRollout).mockResolvedValue({
      dispatched: false,
      note: 'Deploy to node 2 is already in progress.',
    });
    renderActions(rolloutPending());

    await user.click(screen.getByTestId('gitops-action-authorize-rollout'));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('Deploy to node 2 is already in progress.'));
  });

  it('offers no placement approval without stack:create and stack:deploy', () => {
    renderActions(placementPending(), () => false);
    expect(screen.queryByTestId('gitops-authority-actions')).toBeNull();
  });

  it('offers no rollout authorization without stack:deploy', () => {
    renderActions(rolloutPending(), action => action !== 'stack:deploy');
    expect(screen.queryByTestId('gitops-action-authorize-rollout')).toBeNull();
    expect(screen.getByTestId('gitops-action-pull-source')).toBeInTheDocument();
  });

  it('offers no source acceptance without stack:create', () => {
    // Asserted on the button rather than on the row: the row also carries the
    // placement policy control, which is gated on deploy rather than create, so
    // the row itself is legitimately present for a session that may not accept
    // a source.
    renderActions(sourcePending(), action => action !== 'stack:create');
    expect(screen.queryByTestId('gitops-action-accept-source')).toBeNull();
  });

  it('offers the placement policy to a session that may deploy but not create', () => {
    // The control configures a decision the operator may not themselves take, so
    // it follows deploy rather than create. Asserted because getting this
    // backwards hides the one control that stops automatic placement.
    renderActions(withPlacementPolicy(sourcePending()), action => action !== 'stack:create');
    expect(screen.getByTestId('gitops-action-placement-policy')).toBeInTheDocument();
  });

  it('withholds the placement policy from a session that may not deploy', () => {
    renderActions(withPlacementPolicy(sourcePending()), action => action !== 'stack:deploy');
    expect(screen.queryByTestId('gitops-action-placement-policy')).toBeNull();
  });

  it('offers the placement policy to a demoted Blueprint, which is still placed', () => {
    // The gap this closes. A Blueprint demoted back to Inline keeps its
    // placement policy and the placement decision keeps evaluating it, but the
    // control was behind a Git-mode gate, so an operator had a live automatic
    // decision and no way to reach it from the interface.
    const demoted = withPlacementPolicy(sourcePending());
    const asInline: GitOpsRevisionLive = { ...demoted, targetMode: 'inline_blueprint' };
    renderActions(asInline);
    expect(screen.getByTestId('gitops-action-placement-policy')).toBeInTheDocument();
  });

  it('offers the rollout authorization policy to an Inline Blueprint and writes it', async () => {
    // The mode where no rollout controls row exists. An Inline Blueprint acts
    // on a policy placement approval only while this policy is automatic, so
    // without this control the operator could configure bounded automatic
    // placement and never let it act.
    const user = userEvent.setup();
    const onChanged = vi.fn();
    vi.mocked(setGitOpsRolloutAuthorizationPolicy).mockResolvedValue(undefined);
    renderActions(asInline(withRolloutPolicy(sourcePending())), () => true, onChanged);

    await user.click(screen.getByTestId('gitops-action-rollout-policy'));
    await user.click(screen.getByRole('radio', { name: 'Automatic' }));
    await user.click(screen.getByTestId('gitops-policy-confirm'));

    await waitFor(() => expect(setGitOpsRolloutAuthorizationPolicy).toHaveBeenCalledWith('bp:5', 'automatic'));
    expect(onChanged).toHaveBeenCalled();
  });

  it('does not put the inline rollout control on a Git-managed application', () => {
    // A Git-managed application keeps the control in its rollout overflow; a
    // second affordance in the authority row would be the same write twice.
    renderActions(withRolloutPolicy(blueprintRevision()));
    expect(screen.queryByTestId('gitops-action-rollout-policy')).toBeNull();
  });

  it('withholds the inline rollout policy from a session that may not deploy', () => {
    renderActions(asInline(withRolloutPolicy(sourcePending())), action => action !== 'stack:deploy');
    expect(screen.queryByTestId('gitops-action-rollout-policy')).toBeNull();
  });

  it('offers no Git lifecycle action to a demoted Blueprint', () => {
    // The other half. Those actions act on a Git generation the demoted
    // application does not have, and the routes refuse one, so a button that
    // always 409s is worse than no button.
    const demoted = withPlacementPolicy(sourcePending());
    const asInline: GitOpsRevisionLive = { ...demoted, targetMode: 'inline_blueprint' };
    renderActions(asInline);
    expect(screen.queryByTestId('gitops-action-accept-source')).toBeNull();
    expect(screen.queryByTestId('gitops-action-pull-source')).toBeNull();
    expect(screen.queryByTestId('gitops-action-authorize-rollout')).toBeNull();
  });

  it('renders no policy control for an application that reports none', () => {
    // A build or projection that carries no reads must not invent a control
    // whose current value is unknown, since saving would overwrite whatever the
    // server is enforcing.
    renderActions(sourcePending());
    expect(screen.queryByTestId('gitops-action-placement-policy')).toBeNull();
  });

  it('offers source acceptance for a newer candidate after an earlier acceptance', async () => {
    const user = userEvent.setup();
    vi.mocked(acceptGitOpsSource).mockResolvedValue({ ok: true, materialized: true, artifactResolved: true, dispatched: false, note: null });
    renderActions(blueprintRevision({
      approvals: { ...noApprovals, sourceAcceptanceRef: 'src-old', placementApprovalRef: 'place-old' },
      facets: facets({
        source: plainSource('candidate_ready', { candidateGenerationId: 'gen-new' }),
        placement: { status: 'blueprint_bound', completion: 'unknown' },
        rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' },
      }),
    }));

    await confirmSourceAccept(user);
    await waitFor(() => expect(acceptGitOpsSource).toHaveBeenCalledWith('bp:5', 'gen-new', UNAPPROVED_CLAIM));
  });

  it('withholds placement and rollout while the Blueprint is disabled', () => {
    const { unmount } = renderActions(placementPending(), () => true, () => {}, false);
    expect(screen.getByTestId('gitops-authority-actions')).toHaveTextContent('Blueprint disabled');
    expect(screen.getByTestId('gitops-action-approve-placement')).toBeDisabled();
    unmount();

    renderActions(rolloutPending(), () => true, () => {}, false);
    expect(screen.getByTestId('gitops-action-authorize-rollout')).toBeDisabled();
  });

  it('keeps source acceptance available while the Blueprint is disabled', () => {
    renderActions(sourcePending(), () => true, () => {}, false);
    expect(screen.getByTestId('gitops-action-accept-source')).toBeEnabled();
  });

  it('offers Pull source on a Blueprint and hides it while the source is suspended', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    vi.mocked(fetchGitOpsSource).mockResolvedValue({
      outcome: 'pending_review',
      reason: 'A newer commit is waiting.',
      nextAction: 'review',
      commitSha: 'abc1234ffff',
      candidateGenerationId: 'gen-2',
      authority: { status: 'not_applicable', rollout: null, note: null },
    });
    const view = renderActions(
      blueprintRevision({
        configuredSourceStackName: 'bookstack',
        facets: facets({
          source: plainSource('application_generation_accepted', { candidateGenerationId: null }),
          placement: { status: 'blueprint_bound', completion: 'unknown' },
          rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' },
        }),
      }),
      (action, resourceType, resourceId, nodeId) =>
        action === 'stack:edit' && resourceType === 'stack' && resourceId === 'bookstack' && nodeId === 1,
      onChanged,
    );
    await user.click(screen.getByTestId('gitops-action-pull-source'));
    await waitFor(() => expect(fetchGitOpsSource).toHaveBeenCalledWith('bp:5', null));
    expect(toast.success).toHaveBeenCalledWith('Pulled abc1234');
    expect(onChanged).toHaveBeenCalled();
    expect(screen.queryByTestId('gitops-action-accept-source')).toBeNull();
    view.unmount();

    renderActions(blueprintRevision({
      configuredSourceStackName: 'bookstack',
      facets: facets({
        source: {
          ...sourceIdentity({ candidateGenerationId: null }),
          status: 'source_suspended',
          suspendedAt: 1,
          suspendedReason: null,
        },
        placement: { status: 'blueprint_bound', completion: 'unknown' },
        rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' },
      }),
    }), (action) => action === 'stack:edit');
    expect(screen.queryByTestId('gitops-action-pull-source')).toBeNull();
  });

  function pullable(sourceConfigured: string, rolloutConfigured = 'manual'): GitOpsRevisionLive {
    return blueprintRevision({
      configuredSourceStackName: 'bookstack',
      authorityPolicies: [
        {
          domain: 'source',
          configured: sourceConfigured,
          effectiveFrozen: null,
          decision: 'awaiting_operator',
          reason: null,
          decidedBy: null,
          decidedAt: null,
        },
        {
          domain: 'rollout_authorization',
          configured: rolloutConfigured,
          effectiveFrozen: null,
          decision: 'awaiting_operator',
          reason: null,
          decidedBy: null,
          decidedAt: null,
        },
      ],
      facets: facets({
        source: plainSource('application_generation_accepted', { candidateGenerationId: null }),
        placement: { status: 'blueprint_bound', completion: 'unknown' },
        rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' },
      }),
    });
  }

  const canEditSource = (
    action: PermissionAction,
    resourceType?: string,
    resourceId?: string,
    nodeId?: number | null,
  ) => action === 'stack:edit' && resourceType === 'stack' && resourceId === 'bookstack' && nodeId === 1;

  function unknownSource(stage: 'fetch_started' | 'apply_started'): GitOpsRevisionLive {
    return blueprintRevision({
      configuredSourceStackName: 'bookstack',
      facets: facets({
        source: {
          ...sourceIdentity({ candidateGenerationId: 'gen-interrupted' }),
          status: 'source_unknown',
          interruptedStage: stage,
          interruptedAt: 1,
          interruptedOperationId: 'op-1',
          interruptedGenerationId: 'gen-interrupted',
        },
        placement: { status: 'blueprint_bound', completion: 'unknown' },
        rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' },
      }),
    });
  }

  it('withholds Pull source during an interrupted apply and keeps it for an interrupted fetch', () => {
    const hidden = renderActions(unknownSource('apply_started'), canEditSource);
    expect(screen.queryByTestId('gitops-action-pull-source')).toBeNull();
    hidden.unmount();

    renderActions(unknownSource('fetch_started'), canEditSource);
    expect(screen.getByTestId('gitops-action-pull-source')).toBeEnabled();
  });

  it('keeps Pull source when an interrupted apply no longer names the current candidate', () => {
    renderActions(blueprintRevision({
      configuredSourceStackName: 'bookstack',
      facets: facets({
        source: {
          ...sourceIdentity({ candidateGenerationId: 'gen-new' }),
          status: 'source_unknown',
          interruptedStage: 'apply_started',
          interruptedAt: 1,
          interruptedOperationId: 'op-1',
          interruptedGenerationId: 'gen-old',
        },
        placement: { status: 'blueprint_bound', completion: 'unknown' },
        rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' },
      }),
    }), canEditSource);
    expect(screen.getByTestId('gitops-action-pull-source')).toBeEnabled();
  });

  it('pulls a manual source immediately', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchGitOpsSource).mockResolvedValue({
      outcome: 'pending_review',
      reason: 'A newer commit is waiting.',
      nextAction: 'review',
      commitSha: 'abc1234ffff',
      candidateGenerationId: 'gen-2',
      authority: { status: 'not_applicable', rollout: null, note: null },
    });
    renderActions(pullable('manual'), canEditSource);
    await user.click(screen.getByTestId('gitops-action-pull-source'));
    await waitFor(() => expect(fetchGitOpsSource).toHaveBeenCalledWith('bp:5', null));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('pulls a review source immediately', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchGitOpsSource).mockResolvedValue({
      outcome: 'pending_review',
      reason: 'A newer commit is waiting.',
      nextAction: 'review',
      commitSha: 'abc1234ffff',
      candidateGenerationId: 'gen-2',
      authority: { status: 'not_applicable', rollout: null, note: null },
    });
    renderActions(pullable('review'), canEditSource);
    await user.click(screen.getByTestId('gitops-action-pull-source'));
    await waitFor(() => expect(fetchGitOpsSource).toHaveBeenCalledWith('bp:5', null));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(toast.success).toHaveBeenCalledWith('Pulled abc1234');
  });

  // The automatic pull is the only confirmation before a request that can both
// record a commit and start a rollout, so it has to name the destination. The
// next commit is not knowable before the fetch, which is no reason to hide the
// placement scope the operator already approved.
it('names the approved rollout scope before an automatic pull', async () => {
    const user = userEvent.setup();
    renderActions({ ...pullable('automatic', 'automatic'), approvedRolloutScope: approvedScope([1, 3]) }, canEditSource);
    await user.click(screen.getByTestId('gitops-action-pull-source'));
    expect(fetchGitOpsSource).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('The next commit goes to the approved nodes: local, node 3.');
    const pullBody = screen.getByTestId('gitops-source-confirm-body');
    expect(pullBody).toBeVisible();
    expect(pullBody.closest('.sr-only')).toBeNull();
    expect(dialog).toHaveTextContent('Starting a rollout is not the same as it finishing.');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(fetchGitOpsSource).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

it('keeps an observed target outside the approval out of the pull confirmation', async () => {
    const user = userEvent.setup();
    renderActions({
      ...pullable('automatic', 'automatic'),
      approvedRolloutScope: approvedScope([3]),
      targets: [target(), target({ nodeId: 3, stackName: 'other' })],
    }, canEditSource);
    await user.click(screen.getByTestId('gitops-action-pull-source'));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('The next commit goes to the approved nodes: node 3.');
    expect(dialog).not.toHaveTextContent('local');
    expect(fetchGitOpsSource).not.toHaveBeenCalled();
  });

it('says the destination is unreadable rather than implying a reviewed one', async () => {
    // Two ways the scope can be unproven, both of which must read as "this
    // cannot deploy" rather than as a destination: an approval the projection
    // could not resolve, and a projection from a node carrying no scope field.
    const user = userEvent.setup();
    const unresolved = {
      ...pullable('automatic', 'automatic'),
      approvedRolloutScope: { status: 'unresolved' as const, approvalRef: 'place-1', reason: 'no_candidate' as const },
    };
    renderActions(unresolved, canEditSource);
    await user.click(screen.getByTestId('gitops-action-pull-source'));
    let dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('The recorded placement approval cannot be read, so this cannot start a rollout.');
    expect(dialog).not.toHaveTextContent('approved nodes:');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(fetchGitOpsSource).not.toHaveBeenCalled();

    const legacy = { ...pullable('automatic', 'automatic') };
    delete legacy.approvedRolloutScope;
    renderActions(legacy, canEditSource);
    await user.click(screen.getAllByTestId('gitops-action-pull-source')[1]);
    dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('The recorded placement approval cannot be read, so this cannot start a rollout.');
    expect(fetchGitOpsSource).not.toHaveBeenCalled();
  });

it('says the pull cannot deploy when placement is approved for no nodes', async () => {
    // A Blueprint withdrawn from every node still holds a standing approval.
    // "Approved for no nodes" would read as a destination rather than as the
    // absence of one.
    const user = userEvent.setup();
    renderActions({ ...pullable('automatic', 'automatic'), approvedRolloutScope: approvedScope([]) }, canEditSource);
    await user.click(screen.getByTestId('gitops-action-pull-source'));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'The placement approves no nodes, so this cannot deploy anything.',
    );
    expect(fetchGitOpsSource).not.toHaveBeenCalled();
  });

it('asks before an automatic pull and does not fetch when cancelled', async () => {
    const user = userEvent.setup();
    renderActions({ ...pullable('automatic', 'automatic'), approvedRolloutScope: approvedScope([1]) }, canEditSource);
    await user.click(screen.getByTestId('gitops-action-pull-source'));
    expect(fetchGitOpsSource).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('Starting a rollout is not the same as it finishing.');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(fetchGitOpsSource).not.toHaveBeenCalled();
  });

  // A confirmation is only binding if the request carries what it read. Both
  // dialogs freeze their claim the moment they open, so a projection refresh
  // underneath one cannot turn the words the operator agreed to into a request
  // for somewhere else.
  it('sends the automatic pull the placement and the rollout promise it showed', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchGitOpsSource).mockResolvedValue({
      outcome: 'candidate_already_fetched',
      reason: 'A candidate is awaiting acceptance.',
      nextAction: 'none',
      commitSha: 'abc1234ffff',
      candidateGenerationId: 'gen-2',
      authority: { status: 'accepted', rollout: 'started', note: null },
    });
    renderActions({ ...pullable('automatic', 'automatic'), approvedRolloutScope: approvedScope([1, 3], 'place-9') }, canEditSource);
    await user.click(screen.getByTestId('gitops-action-pull-source'));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent('The next commit goes to the approved nodes: local, node 3.');
    await user.click(within(dialog).getByRole('button', { name: 'Pull source' }));

    await waitFor(() => expect(fetchGitOpsSource).toHaveBeenCalledWith('bp:5', {
      placementApprovalRef: 'place-9',
      rolloutMayStart: true,
    }));
  });

  it('sends the accept the placement and the rollout promise it showed', async () => {
    const user = userEvent.setup();
    vi.mocked(acceptGitOpsSource).mockResolvedValue({ ok: true, materialized: true, artifactResolved: true, dispatched: false, note: null });
    renderActions(placementApproved([3], {
      facets: facets({
        source: plainSource('source_review_pending'),
        placement: { status: 'source_acceptance_pending', sourceAcceptanceRef: null, candidateGenerationId: 'gen-candidate' },
        rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'cand-1' },
      }),
    }));
    await confirmSourceAccept(user);

    await waitFor(() => expect(acceptGitOpsSource).toHaveBeenCalledWith('bp:5', 'gen-candidate', {
      placementApprovalRef: 'place-1',
      rolloutMayStart: false,
    }));
  });

  it('reports a confirmation the server refused rather than a successful acceptance', async () => {
    // The reviewed placement was replaced between the dialog and the request.
    // Nothing was accepted, so the operator must not be told it was.
    const user = userEvent.setup();
    vi.mocked(acceptGitOpsSource).mockRejectedValue(
      new Error('The approved placement changed since you reviewed it; review the current approval and confirm again.'),
    );
    renderActions(sourcePending());
    await confirmSourceAccept(user);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
      'The approved placement changed since you reviewed it; review the current approval and confirm again.',
    ));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('reports an accepted automatic pull as started, held, or accepted', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchGitOpsSource).mockResolvedValue({
      outcome: 'candidate_already_fetched',
      reason: 'A candidate is awaiting acceptance.',
      nextAction: 'review',
      commitSha: 'abc1234ffff',
      candidateGenerationId: 'gen-2',
      authority: { status: 'accepted', rollout: 'started', note: null },
    });
    const started = renderActions(pullable('automatic', 'automatic'), canEditSource);
    await user.click(screen.getByTestId('gitops-action-pull-source'));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Pull source' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Source revision accepted and the rollout started'));
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringMatching(/complet/i));
    started.unmount();

    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.warning).mockClear();
    vi.mocked(fetchGitOpsSource).mockResolvedValue({
      outcome: 'candidate_already_fetched',
      reason: 'A candidate is awaiting acceptance.',
      nextAction: 'review',
      commitSha: 'abc1234ffff',
      candidateGenerationId: 'gen-2',
      authority: { status: 'accepted', rollout: 'held', note: 'The rollout is paused.' },
    });
    const heldRollout = renderActions(pullable('automatic'), canEditSource);
    await user.click(screen.getByTestId('gitops-action-pull-source'));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('The rollout stays waiting for you.');
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Pull source' }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('Source revision accepted. The rollout is paused.'));
    expect(toast.success).not.toHaveBeenCalled();
    heldRollout.unmount();

    vi.mocked(toast.warning).mockClear();
    vi.mocked(fetchGitOpsSource).mockResolvedValue({
      outcome: 'candidate_already_fetched',
      reason: 'A candidate is awaiting acceptance.',
      nextAction: 'none',
      commitSha: 'abc1234ffff',
      candidateGenerationId: 'gen-2',
      authority: { status: 'held', rollout: null, note: 'The security policy did not allow this candidate, so it was not accepted.' },
    });
    renderActions(pullable('automatic'), canEditSource);
    await user.click(screen.getByTestId('gitops-action-pull-source'));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Pull source' }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      'Source pulled. The security policy did not allow this candidate, so it was not accepted.',
    ));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('warns when an automatic pull accepts but does not start the rollout', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchGitOpsSource).mockResolvedValue({
      outcome: 'candidate_already_fetched',
      reason: 'ok',
      nextAction: 'none',
      commitSha: 'abc1234ffff',
      candidateGenerationId: 'gen-2',
      authority: { status: 'accepted', rollout: 'not_started', note: 'The rollout is paused.' },
    });
    renderActions(pullable('automatic', 'automatic'), canEditSource);
    await user.click(screen.getByTestId('gitops-action-pull-source'));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Pull source' }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('Source revision accepted. The rollout is paused.'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('warns when an automatic pull is still preparing or starting, and does not call that a failure', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchGitOpsSource).mockResolvedValue({
      outcome: 'candidate_already_fetched',
      reason: 'ok',
      nextAction: 'none',
      commitSha: 'abc1234ffff',
      candidateGenerationId: 'gen-2',
      authority: {
        status: 'accepted',
        rollout: 'not_started',
        note: 'Preparation is still running; the rollout becomes authorizable when it completes.',
      },
    });
    const preparing = renderActions(pullable('automatic', 'automatic'), canEditSource);
    await user.click(screen.getByTestId('gitops-action-pull-source'));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Pull source' }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      'Source revision accepted. Preparation is still running; the rollout becomes authorizable when it completes.',
    ));
    expect(toast.error).not.toHaveBeenCalled();
    preparing.unmount();

    vi.mocked(toast.warning).mockClear();
    vi.mocked(fetchGitOpsSource).mockResolvedValue({
      outcome: 'candidate_already_fetched',
      reason: 'ok',
      nextAction: 'none',
      commitSha: 'abc1234ffff',
      candidateGenerationId: 'gen-2',
      authority: {
        status: 'accepted',
        rollout: 'not_started',
        note: 'The rollout is starting; watch the application for progress.',
      },
    });
    renderActions(pullable('automatic', 'automatic'), canEditSource);
    await user.click(screen.getByTestId('gitops-action-pull-source'));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Pull source' }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      'Source revision accepted. The rollout is starting; watch the application for progress.',
    ));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('warns with a preparation refusal or a transient failure, and does not call that a failure', async () => {
    const user = userEvent.setup();
    const refusal = 'The artifact identity cannot be resolved for this content: the accepted generation materializes 2 compose files, which this freeze cannot model.';
    vi.mocked(fetchGitOpsSource).mockResolvedValue({
      outcome: 'candidate_already_fetched',
      reason: 'ok',
      nextAction: 'none',
      commitSha: 'abc1234ffff',
      candidateGenerationId: 'gen-2',
      authority: { status: 'accepted', rollout: 'not_started', note: refusal },
    });
    const refused = renderActions(pullable('automatic', 'automatic'), canEditSource);
    await user.click(screen.getByTestId('gitops-action-pull-source'));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Pull source' }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(`Source revision accepted. ${refusal}`));
    expect(toast.error).not.toHaveBeenCalled();
    refused.unmount();

    vi.mocked(toast.warning).mockClear();
    const transient = 'The accepted generation could not be materialized yet; the next reconcile retries it.';
    vi.mocked(fetchGitOpsSource).mockResolvedValue({
      outcome: 'candidate_already_fetched',
      reason: 'ok',
      nextAction: 'none',
      commitSha: 'abc1234ffff',
      candidateGenerationId: 'gen-2',
      authority: { status: 'accepted', rollout: 'not_started', note: transient },
    });
    renderActions(pullable('automatic', 'automatic'), canEditSource);
    await user.click(screen.getByTestId('gitops-action-pull-source'));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Pull source' }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(`Source revision accepted. ${transient}`));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('does not claim a pull when nothing changed and acceptance is held', async () => {
    const user = userEvent.setup();
    vi.mocked(fetchGitOpsSource).mockResolvedValue({
      outcome: 'no_source_change',
      reason: 'ok',
      nextAction: 'none',
      commitSha: 'abc1234ffff',
      candidateGenerationId: null,
      authority: { status: 'held', rollout: null, note: 'The security policy did not allow this candidate, so it was not accepted.' },
    });
    renderActions(pullable('automatic'), canEditSource);
    await user.click(screen.getByTestId('gitops-action-pull-source'));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Pull source' }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith(
      'The security policy did not allow this candidate, so it was not accepted.',
    ));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('offers nothing for a Direct or Inline application', () => {
    const direct = liveRevision({
      facets: facets({
        source: plainSource('candidate_ready'),
        placement: { status: 'unbound_direct' },
      }),
    });
    renderActions(direct);
    expect(screen.queryByTestId('gitops-authority-actions')).toBeNull();
  });
});
