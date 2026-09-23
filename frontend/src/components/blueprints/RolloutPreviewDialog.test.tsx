/**
 * RolloutPreviewDialog rendering: reachability notes, full warning lists, and
 * the composed GitOps authority evidence bound to the confirmation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BlueprintPreview } from '@/lib/blueprintsApi';
import type { GitOpsRevisionLive } from '@/types/gitops';
import { absentRevision, facets, liveRevision, missingApplicationLimitation, noApprovals } from '@/__tests__/gitopsFixtures';

vi.mock('@/lib/blueprintsApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/blueprintsApi')>();
    return { ...actual, previewBlueprint: vi.fn(), applyBlueprint: vi.fn() };
});

vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import { previewBlueprint, applyBlueprint } from '@/lib/blueprintsApi';
import { RolloutPreviewDialog } from './RolloutPreviewDialog';

/** An Inline Blueprint application with a recorded placement approval. */
function boundApplication(): GitOpsRevisionLive {
    return liveRevision({
        targetMode: 'inline_blueprint',
        applicationId: 'bp-app-1',
        stackName: null,
        blueprintId: 1,
        facets: facets({
            source: { status: 'not_applicable' },
            artifact: { status: 'not_applicable' },
            placement: { status: 'blueprint_bound', completion: 'unknown' },
            rollout: { status: 'rollout_not_executable', rolloutCandidateId: 'candidate-1' },
        }),
        approvals: { ...noApprovals, placementApprovalRef: 'placement-approval-1' },
    });
}

function previewFixture(overrides: Partial<BlueprintPreview> = {}): BlueprintPreview {
    return {
        blueprintId: 1,
        classification: 'stateless',
        matchedNodes: [{ id: 2, name: 'edge', type: 'remote' }],
        plannedDeployments: [],
        plannedDriftChecks: [],
        plannedEvictions: [],
        name: 'web',
        revision: 1,
        updatedAt: 0,
        driftMode: 'observe',
        stackName: 'web',
        approvalStatus: 'pending',
        effectiveApproval: 'pending',
        planFingerprint: 'abc',
        generatedAt: Date.now(),
        summary: { safe: 0, warning: 2, blocker: 1, total: 1 },
        changes: [{
            nodeId: 2,
            nodeName: 'edge',
            nodeType: 'remote',
            status: 'offline',
            action: 'create',
            severity: 'blocker',
            kind: 'executor',
            detail: 'New placement',
            reachabilityNote: 'Remote node cached as offline or unknown',
        }],
        confirmableActions: [{ nodeId: 2, action: 'create' }],
        executorActions: [{ nodeId: 2, action: 'create' }],
        unauthorizedActions: [],
        requirements: { variables: [], envFiles: [], composeSecrets: [] },
        compatibilityWarnings: ['uses named volumes'],
        healthNote: 'Reachability is from cached node status',
        blockers: [{
            id: 'change:2:create',
            message: 'edge: New placement [remote/offline: Remote node cached as offline or unknown]',
        }],
        warnings: [
            { id: 'compat:1', message: 'uses named volumes' },
            { id: 'req:1', message: 'Required variable DB_PASSWORD' },
        ],
        gitops: absentRevision(),
        gitopsFingerprint: null,
        ...overrides,
    };
}

function confirmablePreview(): Partial<BlueprintPreview> {
    return {
        gitops: boundApplication(),
        gitopsFingerprint: 'deadbeefcafebabe',
        summary: { safe: 1, warning: 0, blocker: 0, total: 1 },
        blockers: [],
        warnings: [],
        changes: [{
            nodeId: 2,
            nodeName: 'edge',
            nodeType: 'remote',
            status: 'online',
            action: 'create',
            severity: 'safe',
            kind: 'executor',
            detail: 'New placement',
            reachabilityNote: 'Local node',
        }],
    };
}

beforeEach(() => {
    vi.mocked(previewBlueprint).mockResolvedValue(previewFixture());
});

describe('RolloutPreviewDialog', () => {
    it('shows reachability note and does not truncate compatibility warnings', async () => {
        render(
            <RolloutPreviewDialog
                blueprintId={1}
                blueprintName="web"
                open
                onOpenChange={() => {}}
                onApplied={() => {}}
            />,
        );

        await waitFor(() => {
            expect(screen.getAllByText(/Remote node cached as offline/i).length).toBeGreaterThanOrEqual(1);
        });
        expect(screen.getByText(/Warnings \(2\)/i)).toBeInTheDocument();
        expect(screen.getByText('uses named volumes')).toBeInTheDocument();
        expect(screen.getByText('Required variable DB_PASSWORD')).toBeInTheDocument();
        expect(screen.getByText(/Blockers \(1\)/i)).toBeInTheDocument();
        expect(screen.getByText(/\(remote\/offline\)/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /confirm apply/i })).toBeDisabled();
    });

    it('renders the composed GitOps evidence and the evidence snapshot id', async () => {
        vi.mocked(previewBlueprint).mockResolvedValue(previewFixture(confirmablePreview()));

        render(
            <RolloutPreviewDialog
                blueprintId={1}
                blueprintName="web"
                open
                onOpenChange={() => {}}
                onApplied={() => {}}
            />,
        );

        await waitFor(() => expect(screen.getByTestId('gitops-approvals')).toBeInTheDocument());
        expect(screen.getByTestId('gitops-placement')).toHaveAttribute('data-state', 'blueprint_bound');
        expect(screen.getByTestId('gitops-rollout')).toHaveAttribute('data-state', 'rollout_not_executable');
        // An Inline Blueprint has no Git source or executable artifact set: the
        // facets are not applicable and must not be rendered as cards.
        expect(screen.queryByTestId('gitops-source')).toBeNull();
        expect(screen.queryByTestId('gitops-artifact')).toBeNull();
        expect(screen.getByText('deadbeef')).toBeInTheDocument();
    });

    it('confirms with the evidence fingerprint the preview was reviewed against', async () => {
        const user = userEvent.setup();
        vi.mocked(previewBlueprint).mockResolvedValue(previewFixture(confirmablePreview()));
        vi.mocked(applyBlueprint).mockResolvedValue({
            message: 'Rollout confirmed',
            blueprintId: 1,
            effectiveApproval: 'approved',
            outcomes: [],
            outcomeSummary: { total: 0, ok: 0, failed: 0, pending: 0, skipped: 0 },
        });

        render(
            <RolloutPreviewDialog
                blueprintId={1}
                blueprintName="web"
                open
                onOpenChange={() => {}}
                onApplied={() => {}}
            />,
        );

        const confirm = screen.getByRole('button', { name: /confirm apply/i });
        await waitFor(() => expect(confirm).toBeEnabled());
        await user.click(confirm);

        await waitFor(() => expect(applyBlueprint).toHaveBeenCalledWith(1, {
            planFingerprint: 'abc',
            gitopsFingerprint: 'deadbeefcafebabe',
            actions: [{ nodeId: 2, action: 'create' }],
        }));
    });

    it('qualifies the combined approval as legacy when the Blueprint has a live application', async () => {
        vi.mocked(previewBlueprint).mockResolvedValue(previewFixture(confirmablePreview()));

        render(
            <RolloutPreviewDialog
                blueprintId={1}
                blueprintName="web"
                open
                onOpenChange={() => {}}
                onApplied={() => {}}
            />,
        );

        await waitFor(() => expect(screen.getByText(/legacy combined: pending/i)).toBeInTheDocument());
    });

    it('closes instead of arming a stale preview when the 409 refresh fails', async () => {
        const user = userEvent.setup();
        const onOpenChange = vi.fn();
        vi.mocked(previewBlueprint)
            .mockResolvedValueOnce(previewFixture(confirmablePreview()))
            .mockRejectedValueOnce(new Error('refresh failed'));
        const conflict = new Error('Preview is stale') as Error & { status: number };
        conflict.status = 409;
        vi.mocked(applyBlueprint).mockRejectedValueOnce(conflict);

        render(
            <RolloutPreviewDialog
                blueprintId={1}
                blueprintName="web"
                open
                onOpenChange={onOpenChange}
                onApplied={() => {}}
            />,
        );

        const confirm = screen.getByRole('button', { name: /confirm apply/i });
        await waitFor(() => expect(confirm).toBeEnabled());
        await user.click(confirm);

        await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    });

    it('shows the projection fault when the application could not be derived', async () => {
        vi.mocked(previewBlueprint).mockResolvedValue(previewFixture({
            ...confirmablePreview(),
            gitops: absentRevision([missingApplicationLimitation]),
            gitopsFingerprint: 'faultdigest',
        }));

        render(
            <RolloutPreviewDialog
                blueprintId={1}
                blueprintName="web"
                open
                onOpenChange={() => {}}
                onApplied={() => {}}
            />,
        );

        await waitFor(() => expect(screen.getByTestId('gitops-fault')).toBeInTheDocument());
        expect(screen.getByText(/could not be read/i)).toBeInTheDocument();
        expect(screen.getByText('faultdig')).toBeInTheDocument();
    });

    it('re-arms on a refreshed preview after a stale refusal', async () => {
        const user = userEvent.setup();
        const onOpenChange = vi.fn();
        vi.mocked(previewBlueprint)
            .mockResolvedValueOnce(previewFixture(confirmablePreview()))
            .mockResolvedValueOnce(previewFixture({
                ...confirmablePreview(),
                planFingerprint: 'refreshed-plan',
                gitopsFingerprint: 'refresheddigest',
            }));
        const conflict = new Error('Preview is stale') as Error & { status: number };
        conflict.status = 409;
        vi.mocked(applyBlueprint)
            .mockRejectedValueOnce(conflict)
            .mockResolvedValueOnce({
                message: 'Rollout confirmed',
                blueprintId: 1,
                effectiveApproval: 'approved',
                outcomes: [],
                outcomeSummary: { total: 0, ok: 0, failed: 0, pending: 0, skipped: 0 },
            });

        render(
            <RolloutPreviewDialog
                blueprintId={1}
                blueprintName="web"
                open
                onOpenChange={onOpenChange}
                onApplied={() => {}}
            />,
        );

        const confirm = screen.getByRole('button', { name: /confirm apply/i });
        await waitFor(() => expect(confirm).toBeEnabled());
        await user.click(confirm);

        // The refreshed preview replaces the stale one and the dialog stays open.
        await waitFor(() => expect(screen.getByText('refreshe')).toBeInTheDocument());
        expect(onOpenChange).not.toHaveBeenCalledWith(false);

        await user.click(confirm);
        await waitFor(() => expect(applyBlueprint).toHaveBeenLastCalledWith(1, {
            planFingerprint: 'refreshed-plan',
            gitopsFingerprint: 'refresheddigest',
            actions: [{ nodeId: 2, action: 'create' }],
        }));
    });

    it('renders no evidence block and binds nothing when the Blueprint has no live application', async () => {
        const user = userEvent.setup();
        vi.mocked(previewBlueprint).mockResolvedValue(previewFixture({
            ...confirmablePreview(),
            gitops: absentRevision(),
            gitopsFingerprint: null,
        }));
        vi.mocked(applyBlueprint).mockResolvedValue({
            message: 'Rollout confirmed',
            blueprintId: 1,
            effectiveApproval: 'approved',
            outcomes: [],
            outcomeSummary: { total: 0, ok: 0, failed: 0, pending: 0, skipped: 0 },
        });

        render(
            <RolloutPreviewDialog
                blueprintId={1}
                blueprintName="web"
                open
                onOpenChange={() => {}}
                onApplied={() => {}}
            />,
        );

        const confirm = screen.getByRole('button', { name: /confirm apply/i });
        await waitFor(() => expect(confirm).toBeEnabled());
        expect(screen.queryByTestId('gitops-approvals')).toBeNull();
        expect(screen.queryByTestId('gitops-placement')).toBeNull();
        expect(screen.queryByText(/evidence snapshot/i)).toBeNull();
        expect(screen.queryByText(/legacy combined/i)).toBeNull();

        await user.click(confirm);
        await waitFor(() => expect(applyBlueprint).toHaveBeenCalledWith(1, {
            planFingerprint: 'abc',
            gitopsFingerprint: null,
            actions: [{ nodeId: 2, action: 'create' }],
        }));
    });
});
