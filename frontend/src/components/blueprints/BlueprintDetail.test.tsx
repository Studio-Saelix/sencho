/**
 * Render-gate coverage for BlueprintDetail's action bar.
 *
 * Blueprint actions use distinct stack permissions. These tests lock the UI
 * gates so each role sees only actions accepted by the API.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { BlueprintSummary } from '@/lib/blueprintsApi';

vi.mock('@/lib/blueprintsApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/blueprintsApi')>();
    return { ...actual, getBlueprint: vi.fn(), applyBlueprint: vi.fn(), previewBlueprint: vi.fn() };
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

import { getBlueprint } from '@/lib/blueprintsApi';
import { BlueprintDetail } from './BlueprintDetail';

function summary(): BlueprintSummary {
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
        },
        deployments: [],
        statusCounts: {},
        effectiveApproval: 'pending',
    };
}

const noop = () => {};

beforeEach(() => {
    vi.mocked(getBlueprint).mockResolvedValue(summary());
});

describe('BlueprintDetail data fetching', () => {
    it('does not refetch when the parent re-renders with new callback identities', async () => {
        const { rerender } = render(
            <BlueprintDetail blueprintId={1} open onOpenChange={() => {}} onChanged={noop} canEdit distinctLabels={[]} />,
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
            <BlueprintDetail blueprintId={1} open onOpenChange={() => {}} onChanged={noop} canEdit distinctLabels={[]} />,
        );
        rerender(
            <BlueprintDetail blueprintId={1} open onOpenChange={() => {}} onChanged={noop} canEdit distinctLabels={[]} />,
        );
        await Promise.resolve();

        expect(vi.mocked(getBlueprint)).toHaveBeenCalledTimes(callsAfterLoad);
    });

    it('refetches when blueprintId changes while the sheet stays open', async () => {
        const { rerender } = render(
            <BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit distinctLabels={[]} />,
        );
        expect(await screen.findByText('Show compose source')).toBeInTheDocument();
        const callsAfterLoad = vi.mocked(getBlueprint).mock.calls.length;

        // Opening a different blueprint without closing the sheet must load the new one,
        // so blueprintId has to stay a refresh dependency.
        rerender(
            <BlueprintDetail blueprintId={2} open onOpenChange={noop} onChanged={noop} canEdit distinctLabels={[]} />,
        );
        await screen.findByText('Show compose source');

        expect(vi.mocked(getBlueprint)).toHaveBeenCalledTimes(callsAfterLoad + 1);
        expect(vi.mocked(getBlueprint)).toHaveBeenLastCalledWith(2);
    });

    it('opens the rollout preview dialog when Apply now is clicked', async () => {
        render(
            <BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit distinctLabels={[]} />,
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
            <BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit distinctLabels={[]} />,
        );

        expect(await screen.findByText('Show compose source')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /apply now/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^edit$/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument();
    });

    it('hides every mutating action for a non-admin (read-only)', async () => {
        render(
            <BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit={false} distinctLabels={[]} />,
        );

        expect(await screen.findByText('Show compose source')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /apply now/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
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
                distinctLabels={[]}
            />,
        );

        expect(await screen.findByText('Show compose source')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /apply now/i })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
    });
});
