/**
 * Render-gate coverage for BlueprintDetail's action bar.
 *
 * The Apply / Edit / Disable / Delete actions all hit admin-only routes
 * (e.g. POST /api/blueprints/:id/apply requires admin). This locks the UI gate:
 * an admin (canEdit) sees the action affordances; a non-admin viewer sees none
 * of them, so the sheet can never issue a request the API answers with 403.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { BlueprintSummary } from '@/lib/blueprintsApi';

vi.mock('@/lib/blueprintsApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/blueprintsApi')>();
    return { ...actual, getBlueprint: vi.fn(), applyBlueprint: vi.fn() };
});

vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ nodes: [] }) }));

vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

vi.mock('./BlueprintDeploymentTable', () => ({
    BlueprintDeploymentTable: () => <div data-testid="deployment-table" />,
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

    it('keeps the loaded body on screen while a refresh is in flight', async () => {
        let settleRefresh = () => {};
        vi.mocked(getBlueprint)
            .mockResolvedValueOnce(summary())
            .mockImplementationOnce(
                () => new Promise<BlueprintSummary>((resolve) => { settleRefresh = () => resolve(summary()); }),
            );

        render(
            <BlueprintDetail blueprintId={1} open onOpenChange={noop} onChanged={noop} canEdit distinctLabels={[]} />,
        );
        expect(await screen.findByText('Show compose source')).toBeInTheDocument();
        const callsAfterLoad = vi.mocked(getBlueprint).mock.calls.length;

        // Applying reloads the blueprint. The populated body must stay mounted instead
        // of collapsing to the loading skeleton while that reload is in flight.
        fireEvent.click(screen.getByRole('button', { name: /apply now/i }));
        await waitFor(() => expect(vi.mocked(getBlueprint).mock.calls.length).toBe(callsAfterLoad + 1));

        // The deployment table only renders in the loaded body branch, never in the
        // skeleton, so its presence proves the skeleton did not take over the refresh.
        expect(screen.getByText('Show compose source')).toBeInTheDocument();
        expect(screen.getByTestId('deployment-table')).toBeInTheDocument();

        settleRefresh();
        await screen.findByText('Show compose source');
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
});
