/**
 * Render-gate coverage for BlueprintDetail's action bar.
 *
 * Blueprint actions use distinct stack permissions. These tests lock the UI
 * gates so each role sees only actions accepted by the API.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { BlueprintSummary } from '@/lib/blueprintsApi';

vi.mock('@/lib/blueprintsApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/blueprintsApi')>();
    return { ...actual, getBlueprint: vi.fn(), applyBlueprint: vi.fn(), previewBlueprint: vi.fn(), deleteBlueprint: vi.fn(), pinBlueprint: vi.fn(), updateBlueprint: vi.fn() };
});

vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ nodes: [] }) }));

vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

vi.mock('./BlueprintDeploymentTable', () => ({
    BlueprintDeploymentTable: () => <div data-testid="deployment-table" />,
}));

vi.mock('./RolloutPreviewDialog', () => ({
    RolloutPreviewDialog: ({ open }: { open: boolean }) => (
        open ? <div data-testid="rollout-preview-dialog">preview</div> : null
    ),
}));

vi.mock('./EvictionDialog', () => ({
    EvictionDialog: ({ open, nodeName }: { open: boolean; nodeName: string }) => (
        open ? <div data-testid="eviction-dialog">{nodeName}</div> : null
    ),
}));

vi.mock('./StateReviewDialog', () => ({
    StateReviewDialog: ({ open, nodeName }: { open: boolean; nodeName: string }) => (
        open ? <div data-testid="state-review-dialog">{nodeName}</div> : null
    ),
}));

vi.mock('./ConvertBlueprintDialog', () => ({
    ConvertBlueprintDialog: ({ open }: { open: boolean }) => (
        open ? <div data-testid="convert-dialog">convert</div> : null
    ),
}));

vi.mock('./DetachBlueprintDialog', () => ({
    DetachBlueprintDialog: ({ open }: { open: boolean }) => (
        open ? <div data-testid="detach-dialog">detach</div> : null
    ),
}));

vi.mock('./RetireBlueprintDialog', () => ({
    RetireBlueprintDialog: ({ open }: { open: boolean }) => (
        open ? <div data-testid="retire-dialog">retire</div> : null
    ),
}));

import { deleteBlueprint, getBlueprint, pinBlueprint, updateBlueprint } from '@/lib/blueprintsApi';
import { toast } from '@/components/ui/toast-store';
import { BlueprintDetail } from './BlueprintDetail';
import { absentRevision, facets, liveRevision, missingApplicationLimitation } from '@/__tests__/gitopsFixtures';
import type { FutureRolloutAuthorizationBinding } from '@/types/gitops';

function summary(overrides: Partial<BlueprintSummary> = {}): BlueprintSummary {
    return {
        blueprint: {
            id: 1,
            name: 'web-blueprint',
            description: null,
            compose_content: 'services:\n  web:\n    image: nginx\n',
            selector: { type: 'labels', any: ['prod'], all: [] },
            drift_mode: 'suggest',
            classification: 'stateless',
            classification_reasons: [],
            enabled: true,
            revision: 1,
            created_at: 0,
            updated_at: 0,
            created_by: 'admin',
            pinned_node_id: null,
            content_origin: 'inline',
            application_id: null,
        },
        deployments: [],
        statusCounts: {},
        effectiveApproval: 'pending',
        gitopsRevision: absentRevision(),
        ...overrides,
    };
}

const noop = () => {};

beforeEach(() => {
    vi.mocked(getBlueprint).mockResolvedValue(summary());
});

describe('BlueprintDetail data fetching', () => {
    it('does not refetch when the parent re-renders with new callback identities', async () => {
        const { rerender } = render(
            <BlueprintDetail blueprintId={1} open onOpenChange={() => {}} onChanged={noop} canEdit nodeLabels={{}} />,
        );

        // Let the initial load settle so the body content is on screen.
        expect(await screen.findByText('Show compose source')).toBeInTheDocument();
        const callsAfterLoad = vi.mocked(getBlueprint).mock.calls.length;

        // A parent re-render (e.g. the Fleet view's polling) hands the open sheet a
        // brand-new onOpenChange closure every render. Before the fix that closure was
        // a refresh dependency, so the load effect re-ran on every parent render and
        // flickered the body through its loading skeleton. It must now keep showing the
        // data it already has instead of refetching.
        rerender(
            <BlueprintDetail blueprintId={1} open onOpenChange={() => {}} onChanged={noop} canEdit nodeLabels={{}} />,
        );
        rerender(
            <BlueprintDetail blueprintId={1} open onOpenChange={() => {}} onChanged={noop} canEdit nodeLabels={{}} />,
        );
        await Promise.resolve();

        expect(vi.mocked(getBlueprint)).toHaveBeenCalledTimes(callsAfterLoad);
    });

    it('refetches when blueprintId changes while the sheet stays open', async () => {
        const { rerender } = render(
            <BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit nodeLabels={{}} />,
        );
        expect(await screen.findByText('Show compose source')).toBeInTheDocument();
        const callsAfterLoad = vi.mocked(getBlueprint).mock.calls.length;

        // Opening a different blueprint without closing the sheet must load the new one,
        // so blueprintId has to stay a refresh dependency.
        rerender(
            <BlueprintDetail blueprintId={2} open onOpenChange={noop} onChanged={noop} canEdit nodeLabels={{}} />,
        );
        await screen.findByText('Show compose source');

        expect(vi.mocked(getBlueprint)).toHaveBeenCalledTimes(callsAfterLoad + 1);
        expect(vi.mocked(getBlueprint)).toHaveBeenLastCalledWith(2);
    });

    it('opens the rollout preview dialog when Apply now is clicked', async () => {
        render(
            <BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit nodeLabels={{}} />,
        );
        expect(await screen.findByText('Show compose source')).toBeInTheDocument();
        const callsAfterLoad = vi.mocked(getBlueprint).mock.calls.length;

        fireEvent.click(screen.getByRole('button', { name: /apply now/i }));

        expect(screen.getByTestId('rollout-preview-dialog')).toBeInTheDocument();
        // Opening the dialog must not refetch the detail sheet body.
        expect(vi.mocked(getBlueprint)).toHaveBeenCalledTimes(callsAfterLoad);
        expect(screen.getByText('Show compose source')).toBeInTheDocument();
        expect(screen.getByTestId('deployment-table')).toBeInTheDocument();
    });
});

describe('BlueprintDetail action gating', () => {
    it('shows the Apply / Edit / Delete actions for an admin (canEdit)', async () => {
        render(
            <BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit nodeLabels={{}} />,
        );

        expect(await screen.findByText('Show compose source')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /apply now/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
    });

    it('hides every mutating action for a non-admin (read-only)', async () => {
        render(
            <BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit={false} nodeLabels={{}} />,
        );

        expect(await screen.findByText('Show compose source')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /apply now/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /convert to git/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /detach git/i })).not.toBeInTheDocument();
        // The detail is still viewable: the compose source and deployment table render.
        expect(screen.getByTestId('deployment-table')).toBeInTheDocument();
    });

    it('lets a deployer apply without exposing edit or delete', async () => {
        const can = vi.fn((action: string) => action === 'stack:create' || action === 'stack:deploy');
        render(
            <BlueprintDetail
                blueprintId={1}
                open
                onOpenChange={noop}
                onChanged={noop}
                canEdit={false}
                can={can}
                nodeLabels={{}}
            />,
        );

        expect(await screen.findByText('Show compose source')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /apply now/i })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
    });
});

describe('BlueprintDetail GitOps state', () => {
    function detail() {
        return (
            <BlueprintDetail
                blueprintId={1}
                open
                onOpenChange={noop}
                onChanged={noop}
                canEdit
                nodeLabels={{}}
            />
        );
    }

    it('reports a Blueprint whose application row could not be reached', async () => {
        vi.mocked(getBlueprint).mockResolvedValue(
            summary({ gitopsRevision: absentRevision([missingApplicationLimitation]) }),
        );
        render(detail());
        expect(await screen.findByTestId('gitops-fault')).toHaveTextContent(missingApplicationLimitation.message);
    });

    it('stays silent when there is simply nothing to project', async () => {
        vi.mocked(getBlueprint).mockResolvedValue(summary());
        render(detail());
        await screen.findByText('Show compose source');
        expect(screen.queryByTestId('gitops-fault')).not.toBeInTheDocument();
    });

    const rolloutBinding: FutureRolloutAuthorizationBinding = {
        rolloutCandidateId: 'rc-1',
        acceptedGenerationId: 'gen-accepted',
        artifactSetId: 'art-1',
        intentRevisionId: 'int-1',
        requiredNodeIds: [1],
        sourceAcceptanceRef: 'sa-1',
        placementApprovalRef: 'pa-1',
        preflightFingerprint: 'a'.repeat(64),
    };

    it('shows a blocked placement card with the redacted reason and no credential-shaped text', async () => {
        const reason = 'Registry credentials are missing for a required private image.';
        vi.mocked(getBlueprint).mockResolvedValue(summary({
            blueprint: {
                ...summary().blueprint,
                content_origin: 'git',
                application_id: 'app-web',
            },
            gitopsRevision: liveRevision({
                targetMode: 'blueprint',
                blueprintId: 1,
                facets: facets({
                    source: { status: 'not_applicable' },
                    placement: {
                        status: 'preflight_blocked',
                        reason,
                        binding: rolloutBinding,
                    },
                }),
            }),
        }));
        render(detail());
        const stage = await screen.findByTestId('gitops-placement');
        expect(stage).toHaveAttribute('data-state', 'preflight_blocked');
        // The blocked placement is the loudest stage, so the answer carries its redacted reason.
        const status = screen.getByTestId('gitops-status');
        expect(screen.getByTestId('gitops-answer')).toHaveTextContent(reason);
        expect(status.textContent).not.toMatch(/password|secret|token|Bearer|eyJ/i);
    });
});

describe('BlueprintDetail Git-managed content', () => {
    it('hides Apply now and offers Detach Git when content is Git-managed', async () => {
        vi.mocked(getBlueprint).mockResolvedValue(summary({
            blueprint: {
                ...summary().blueprint,
                content_origin: 'git',
                application_id: 'app-web',
            },
        }));
        render(
            <BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit nodeLabels={{}} />,
        );
        expect(await screen.findByText('Git-managed')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /apply now/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /convert to git/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: /retire to direct/i })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /detach git/i }));
        expect(screen.getByTestId('detach-dialog')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /retire to direct/i }));
        expect(screen.getByTestId('retire-dialog')).toBeInTheDocument();
    });

    it('hides Retire to Direct when non-withdrawn deployments exist', async () => {
        vi.mocked(getBlueprint).mockResolvedValue(summary({
            blueprint: {
                ...summary().blueprint,
                content_origin: 'git',
                application_id: 'app-web',
            },
            deployments: [{
                id: 1,
                blueprint_id: 1,
                node_id: 1,
                status: 'active',
                applied_revision: 1,
                last_deployed_at: 1,
                last_checked_at: null,
                last_drift_at: null,
                drift_summary: null,
                last_error: null,
            }],
        }));
        render(
            <BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit nodeLabels={{}} />,
        );
        await screen.findByText('Git-managed');
        expect(screen.queryByRole('button', { name: /retire to direct/i })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: /detach git/i })).toBeInTheDocument();
    });

    it('hides Apply now for a deployer when content is Git-managed', async () => {
        vi.mocked(getBlueprint).mockResolvedValue(summary({
            blueprint: {
                ...summary().blueprint,
                content_origin: 'git',
                application_id: 'app-web',
            },
        }));
        const can = vi.fn((action: string) => action === 'stack:create' || action === 'stack:deploy');
        render(
            <BlueprintDetail
                blueprintId={1}
                open
                onOpenChange={noop}
                onChanged={noop}
                canEdit={false}
                can={can}
                nodeLabels={{}}
            />,
        );
        expect(await screen.findByText('Git-managed')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /apply now/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /detach git/i })).not.toBeInTheDocument();
    });

    it('offers Convert to Git for Inline content', async () => {
        render(
            <BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit nodeLabels={{}} />,
        );
        expect(await screen.findByRole('button', { name: /convert to git/i })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /detach git/i })).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: /convert to git/i }));
        expect(screen.getByTestId('convert-dialog')).toBeInTheDocument();
    });
});

describe('BlueprintDetail review handoff', () => {
    it('opens the rollout preview once the Blueprint loads after Review rollout', async () => {
        render(
            <BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit reviewOnOpen nodeLabels={{}} />,
        );
        expect(await screen.findByTestId('rollout-preview-dialog')).toBeInTheDocument();
    });

    it('shows the sheet without a preview when the Blueprint was only saved', async () => {
        render(
            <BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit nodeLabels={{}} />,
        );
        expect(await screen.findByText('Show compose source')).toBeInTheDocument();
        expect(screen.queryByTestId('rollout-preview-dialog')).not.toBeInTheDocument();
    });
});

describe('BlueprintDetail delete', () => {
    it('keeps Delete disabled until the Blueprint name is typed, then deletes and closes', async () => {
        vi.mocked(deleteBlueprint).mockResolvedValue(undefined as never);
        const onChanged = vi.fn();
        const onOpenChange = vi.fn();
        render(
            <BlueprintDetail blueprintId={1} open onOpenChange={onOpenChange} onChanged={onChanged} canEdit nodeLabels={{}} />,
        );
        fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
        const confirm = await screen.findByRole('button', { name: 'Delete blueprint' });
        expect(confirm).toBeDisabled();
        fireEvent.change(screen.getByPlaceholderText('web-blueprint'), { target: { value: 'web-blueprint' } });
        expect(confirm).toBeEnabled();
        fireEvent.click(confirm);
        await waitFor(() => expect(deleteBlueprint).toHaveBeenCalledWith(1));
        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
        expect(onChanged).toHaveBeenCalled();
    });

    it('does not accept a near-miss name', async () => {
        render(
            <BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit nodeLabels={{}} />,
        );
        fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
        const confirm = await screen.findByRole('button', { name: 'Delete blueprint' });
        fireEvent.change(screen.getByPlaceholderText('web-blueprint'), { target: { value: 'Web-Blueprint' } });
        expect(confirm).toBeDisabled();
        fireEvent.change(screen.getByPlaceholderText('web-blueprint'), { target: { value: 'web' } });
        expect(confirm).toBeDisabled();
    });

    it('keeps the dialog open and reports the error when delete fails', async () => {
        vi.mocked(deleteBlueprint).mockRejectedValue(new Error('Live stateful deployments exist'));
        const onChanged = vi.fn();
        const onOpenChange = vi.fn();
        render(
            <BlueprintDetail blueprintId={1} open onOpenChange={onOpenChange} onChanged={onChanged} canEdit nodeLabels={{}} />,
        );
        fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
        fireEvent.change(await screen.findByPlaceholderText('web-blueprint'), { target: { value: 'web-blueprint' } });
        fireEvent.click(screen.getByRole('button', { name: 'Delete blueprint' }));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Live stateful deployments exist'));
        expect(screen.getByRole('button', { name: 'Delete blueprint' })).toBeEnabled();
        expect(screen.getByPlaceholderText('web-blueprint')).toHaveValue('web-blueprint');
        expect(onChanged).not.toHaveBeenCalled();
        expect(onOpenChange).not.toHaveBeenCalledWith(false);
    });
});

describe('BlueprintDetail status and actions', () => {
    const failedDeployment = {
        id: 1, blueprint_id: 1, node_id: 2, status: 'failed' as const, applied_revision: 1,
        last_deployed_at: null, last_checked_at: null, last_drift_at: null, drift_summary: null,
        last_error: 'Error response from daemon: port is already allocated',
    };

    it('leads with the Blueprint answer, and its verb opens the rollout plan', async () => {
        vi.mocked(getBlueprint).mockResolvedValue(summary({ deployments: [failedDeployment], effectiveApproval: 'approved' }));
        render(<BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit nodeLabels={{}} />);
        expect(await screen.findByTestId('blueprint-answer')).toHaveTextContent('failed');
        fireEvent.click(screen.getByTestId('blueprint-verb'));
        expect(screen.getByTestId('rollout-preview-dialog')).toBeInTheDocument();
    });

    it('states approval once, in the status path, not again in the footer', async () => {
        vi.mocked(getBlueprint).mockResolvedValue(summary({ effectiveApproval: 'approved' }));
        render(<BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit nodeLabels={{}} />);
        await screen.findByTestId('blueprint-status');
        const footer = screen.getByText(/^Updated/);
        expect(footer.textContent).toMatch(/^Updated/);
        expect(footer.textContent).not.toMatch(/approved|pending|reconciler/i);
    });

    it('moves Git conversion out of the toolbar and into the Content row', async () => {
        render(<BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit nodeLabels={{}} />);
        const convert = await screen.findByRole('button', { name: /convert to git/i });
        const apply = screen.getByRole('button', { name: /apply now/i });
        // Same container would mean they share the toolbar band.
        expect(convert.parentElement).not.toBe(apply.parentElement);
    });

    it('unpins a pinned Blueprint in place', async () => {
        vi.mocked(pinBlueprint).mockResolvedValue(undefined as never);
        const onChanged = vi.fn();
        const base = summary();
        vi.mocked(getBlueprint).mockResolvedValue(summary({ blueprint: { ...base.blueprint, pinned_node_id: 2 } }));
        render(<BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={onChanged} canEdit nodeLabels={{}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Unpin' }));
        await waitFor(() => expect(pinBlueprint).toHaveBeenCalledWith(1, null));
        await waitFor(() => expect(onChanged).toHaveBeenCalled());
    });

    it('hides Unpin from a session that cannot manage nodes', async () => {
        const base = summary();
        vi.mocked(getBlueprint).mockResolvedValue(summary({ blueprint: { ...base.blueprint, pinned_node_id: 2 } }));
        const can = vi.fn((action: string) => action !== 'node:manage');
        render(<BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit can={can} nodeLabels={{}} />);
        await screen.findByText(/Pinned to/);
        expect(screen.queryByRole('button', { name: 'Unpin' })).toBeNull();
    });
});

describe('BlueprintDetail status verbs and gating', () => {
    const row = (status: string, over: Record<string, unknown> = {}) => ({
        id: 1, blueprint_id: 1, node_id: 2, status, applied_revision: 1,
        last_deployed_at: null, last_checked_at: null, last_drift_at: null, drift_summary: null, last_error: null, ...over,
    });

    beforeEach(() => {
        vi.mocked(updateBlueprint).mockReset().mockResolvedValue(undefined as never);
    });

    it('opens the state review for the node the status names, even if the node list lacks it', async () => {
        vi.mocked(getBlueprint).mockResolvedValue(summary({ deployments: [row('pending_state_review')] as never }));
        render(<BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit nodeLabels={{}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Review state on node 2' }));
        expect(screen.getByTestId('state-review-dialog')).toHaveTextContent('node 2');
    });

    it('opens the eviction dialog from the Evict verb', async () => {
        vi.mocked(getBlueprint).mockResolvedValue(summary({ deployments: [row('evict_blocked')] as never }));
        render(<BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit nodeLabels={{}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Evict on node 2' }));
        expect(screen.getByTestId('eviction-dialog')).toBeInTheDocument();
    });

    it('turns the reconciler on from the status verb', async () => {
        const base = summary();
        vi.mocked(getBlueprint).mockResolvedValue(summary({
            blueprint: { ...base.blueprint, enabled: false }, effectiveApproval: 'approved', deployments: [row('active')] as never,
        }));
        render(<BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit nodeLabels={{}} />);
        fireEvent.click(await screen.findByTestId('blueprint-verb'));
        await waitFor(() => expect(updateBlueprint).toHaveBeenCalledWith(1, { enabled: true }));
    });

    it('offers Enable instead of Re-apply on a failed Blueprint that is switched off', async () => {
        const base = summary();
        vi.mocked(getBlueprint).mockResolvedValue(summary({
            blueprint: { ...base.blueprint, enabled: false }, deployments: [row('failed', { last_error: 'boom' })] as never,
        }));
        render(<BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit nodeLabels={{}} />);
        expect(await screen.findByTestId('blueprint-verb')).toHaveTextContent('Enable');
        expect(screen.queryByRole('button', { name: 'Re-apply' })).toBeNull();
    });

    it('offers no verb a read-only session could not run', async () => {
        vi.mocked(getBlueprint).mockResolvedValue(summary({ deployments: [row('failed', { last_error: 'boom' })] as never }));
        const can = vi.fn(() => false);
        render(<BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit={false} can={can} nodeLabels={{}} />);
        expect(await screen.findByTestId('blueprint-answer')).toHaveTextContent('failed');
        expect(screen.queryByTestId('blueprint-verb')).toBeNull();
    });

    it('reports a failed unpin and leaves the button usable', async () => {
        vi.mocked(pinBlueprint).mockRejectedValue(new Error('node offline'));
        const onChanged = vi.fn();
        const base = summary();
        vi.mocked(getBlueprint).mockResolvedValue(summary({ blueprint: { ...base.blueprint, pinned_node_id: 2 } }));
        render(<BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={onChanged} canEdit nodeLabels={{}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Unpin' }));
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('node offline'));
        expect(onChanged).not.toHaveBeenCalled();
        expect(screen.getByRole('button', { name: 'Unpin' })).toBeEnabled();
    });

    it('tells the operator the selector applies again after an unpin', async () => {
        vi.mocked(pinBlueprint).mockResolvedValue(undefined as never);
        const base = summary();
        vi.mocked(getBlueprint).mockResolvedValue(summary({ blueprint: { ...base.blueprint, pinned_node_id: 2 } }));
        render(<BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit nodeLabels={{}} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Unpin' }));
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Blueprint unpinned. Review the rollout to apply the selector.'));
    });

    it('keeps the GitOps status, with its conversion actions in the Content row, for Git content', async () => {
        const base = summary();
        vi.mocked(getBlueprint).mockResolvedValue(summary({
            blueprint: { ...base.blueprint, content_origin: 'git', application_id: 'app-web', enabled: false },
            gitopsRevision: liveRevision({
                targetMode: 'blueprint', blueprintId: 1,
                facets: facets({ source: { status: 'not_applicable' }, placement: { status: 'blueprint_bound', completion: 'unknown' } }),
            }),
        }));
        render(<BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit nodeLabels={{}} />);
        await screen.findByTestId('gitops-status');
        expect(screen.queryByTestId('blueprint-status')).toBeNull();
        expect(screen.getByRole('button', { name: /detach git/i })).toBeInTheDocument();
        // Without a Blueprint status, the footer still says the reconciler is off.
        expect(screen.getByText(/^Updated/).textContent).toMatch(/reconciler disabled/);
    });

    it('shows no status block for Git content with nothing to project', async () => {
        const base = summary();
        vi.mocked(getBlueprint).mockResolvedValue(summary({ blueprint: { ...base.blueprint, content_origin: 'git', application_id: 'app-web' } }));
        render(<BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit nodeLabels={{}} />);
        await screen.findByText('Git-managed');
        expect(screen.queryByTestId('blueprint-status')).toBeNull();
        expect(screen.queryByTestId('gitops-status')).toBeNull();
    });
});

describe('BlueprintDetail GitOps link', () => {
    const inlineGitOps = () => summary({
        gitopsRevision: liveRevision({
            targetMode: 'inline_blueprint',
            blueprintId: 1,
            facets: facets({ source: { status: 'not_applicable' }, placement: { status: 'blueprint_bound', completion: 'unknown' } }),
        }),
    });

    it('offers the link to the GitOps portfolio by default', async () => {
        vi.mocked(getBlueprint).mockResolvedValue(inlineGitOps());
        render(<BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit nodeLabels={{}} />);
        expect(await screen.findByRole('button', { name: 'Open in GitOps portfolio' })).toBeInTheDocument();
    });

    it('leaves the link out where the sheet already sits over the workplace', async () => {
        vi.mocked(getBlueprint).mockResolvedValue(inlineGitOps());
        render(<BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit nodeLabels={{}} showPortfolioLink={false} />);
        await screen.findByTestId('blueprint-status');
        expect(screen.queryByRole('button', { name: 'Open in GitOps portfolio' })).toBeNull();
    });
});

