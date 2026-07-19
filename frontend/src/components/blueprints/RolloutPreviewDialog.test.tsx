/**
 * RolloutPreviewDialog rendering: reachability notes and full warning lists.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { BlueprintPreview } from '@/lib/blueprintsApi';

vi.mock('@/lib/blueprintsApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/blueprintsApi')>();
    return { ...actual, previewBlueprint: vi.fn(), applyBlueprint: vi.fn() };
});

vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import { previewBlueprint } from '@/lib/blueprintsApi';
import { RolloutPreviewDialog } from './RolloutPreviewDialog';

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
        ...overrides,
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
});
