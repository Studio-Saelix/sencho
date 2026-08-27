/**
 * Covers what adding a label reports back. Adding a label is exactly what makes
 * a Blueprint selector match a new node, so the response's re-placement list is
 * usually non-empty and is the one node mutation worth surfacing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/lib/blueprintsApi', () => ({
    addNodeLabel: vi.fn(),
    removeNodeLabel: vi.fn(),
    getLabelsForNode: vi.fn(),
    listDistinctLabels: vi.fn(),
}));
vi.mock('@/components/ui/toast-store', () => ({
    toast: { success: vi.fn(), error: vi.fn() },
}));

import { addNodeLabel, getLabelsForNode, listDistinctLabels } from '@/lib/blueprintsApi';
import { toast } from '@/components/ui/toast-store';
import { NodeLabelPicker } from './NodeLabelPicker';
import { absentRevision } from '@/__tests__/gitopsFixtures';

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getLabelsForNode).mockResolvedValue([]);
    vi.mocked(listDistinctLabels).mockResolvedValue([]);
});

async function addLabel(gitopsRevisions: ReturnType<typeof absentRevision>[]) {
    vi.mocked(addNodeLabel).mockResolvedValue({ nodeId: 1, label: 'prod', gitopsRevisions });
    render(<NodeLabelPicker nodeId={1} />);
    fireEvent.click(await screen.findByLabelText('Add label'));
    fireEvent.change(await screen.findByPlaceholderText('prod'), { target: { value: 'prod' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(addNodeLabel).toHaveBeenCalledWith(1, 'prod'));
}

describe('NodeLabelPicker', () => {
    it('reports how many blueprints the new label re-placed', async () => {
        await addLabel([absentRevision(), absentRevision()]);
        await waitFor(() =>
            expect(toast.success).toHaveBeenCalledWith('Label added. 2 blueprints re-placed.'),
        );
    });

    it('uses the singular for one', async () => {
        await addLabel([absentRevision()]);
        await waitFor(() =>
            expect(toast.success).toHaveBeenCalledWith('Label added. 1 blueprint re-placed.'),
        );
    });

    it('says nothing when the list is empty', async () => {
        // Empty means both "nothing moved" and "the projection faulted after the
        // write committed", so it can never be reported as the former.
        await addLabel([]);
        await waitFor(() => expect(getLabelsForNode).toHaveBeenCalledTimes(2));
        expect(toast.success).not.toHaveBeenCalled();
    });
});
