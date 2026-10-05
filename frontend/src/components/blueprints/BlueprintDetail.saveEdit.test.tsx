/**
 * Saving an edit commits staged node labels after the Blueprint itself, so a
 * label failure can never roll back or block the saved Blueprint.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { BlueprintSummary } from '@/lib/blueprintsApi';

vi.mock('@/lib/blueprintsApi', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/lib/blueprintsApi')>();
    return { ...actual, getBlueprint: vi.fn(), updateBlueprint: vi.fn(), addNodeLabel: vi.fn() };
});
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ nodes: [] }) }));
vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('./BlueprintDeploymentTable', () => ({ BlueprintDeploymentTable: () => <div /> }));
vi.mock('./RolloutPreviewDialog', () => ({ RolloutPreviewDialog: () => null }));
vi.mock('./BlueprintEditor', () => ({
    BlueprintEditor: ({ onSubmit }: { onSubmit: (input: unknown, options: unknown) => Promise<void> }) => (
        <button type="button" onClick={() => void onSubmit({ name: 'web' }, { intent: 'save', staged: [{ nodeId: 2, label: 'edge' }] })}>
            save edit
        </button>
    ),
}));

import { addNodeLabel, getBlueprint, updateBlueprint } from '@/lib/blueprintsApi';
import { toast } from '@/components/ui/toast-store';
import { absentRevision } from '@/__tests__/gitopsFixtures';
import { BlueprintDetail } from './BlueprintDetail';

const summary = {
    blueprint: {
        id: 1, name: 'web-blueprint', description: null, compose_content: 'services: {}\n',
        selector: { type: 'labels', any: ['edge'], all: [] }, drift_mode: 'suggest', classification: 'stateless',
        classification_reasons: [], enabled: true, revision: 1, created_at: 0, updated_at: 0, created_by: 'admin',
        pinned_node_id: null, content_origin: 'inline', application_id: null,
    },
    deployments: [], statusCounts: {}, effectiveApproval: 'pending', gitopsRevision: absentRevision(),
} as unknown as BlueprintSummary;

async function openEditor() {
    render(<BlueprintDetail blueprintId={1} open onOpenChange={() => {}} onChanged={() => {}} canEdit nodeLabels={{}} />);
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'save edit' }));
}

beforeEach(() => {
    vi.mocked(getBlueprint).mockResolvedValue(summary);
    vi.mocked(updateBlueprint).mockReset().mockResolvedValue(undefined as never);
    vi.mocked(addNodeLabel).mockReset().mockResolvedValue({ nodeId: 2, label: 'edge', gitopsRevisions: [] } as never);
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.warning).mockClear();
});

describe('BlueprintDetail edit save', () => {
    it('saves the Blueprint first, then adds the staged label and says so', async () => {
        await openEditor();
        await waitFor(() => expect(addNodeLabel).toHaveBeenCalledWith(2, 'edge'));
        expect(vi.mocked(updateBlueprint).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(addNodeLabel).mock.invocationCallOrder[0]);
        expect(toast.success).toHaveBeenCalledWith('Added 1 node label.');
    });

    it('warns without losing the save when a label cannot be added', async () => {
        vi.mocked(addNodeLabel).mockRejectedValueOnce(new Error('forbidden'));
        await openEditor();
        await waitFor(() => expect(toast.warning).toHaveBeenCalled());
        expect(vi.mocked(toast.warning).mock.calls[0][0]).toContain('Added 0 of 1 node label. forbidden.');
        expect(toast.success).toHaveBeenCalledWith('Blueprint saved');
    });

    it('adds no label when the Blueprint itself fails to save', async () => {
        vi.mocked(updateBlueprint).mockRejectedValueOnce(new Error('conflict'));
        await openEditor();
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith('conflict'));
        expect(addNodeLabel).not.toHaveBeenCalled();
    });
});
