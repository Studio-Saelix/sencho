/**
 * Covers what deleting a node reports back. Deleting a node re-places every
 * Blueprint that was targeting it, and the delete response carries that list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const nodeCtl = vi.hoisted(() => ({ refreshNodes: vi.fn() }));

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/context/NodeContext', () => ({
    useNodes: () => ({ nodes: [], refreshNodes: nodeCtl.refreshNodes }),
}));
vi.mock('@/components/ui/toast-store', () => ({
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { useNodeActions } from './useNodeActions';
import { absentRevision } from '@/__tests__/gitopsFixtures';
import type { Node } from '@/context/NodeContext';

const NODE = { id: 3, name: 'edge-02', type: 'remote' } as Node;

beforeEach(() => {
    vi.clearAllMocks();
});

// The hook owns the modal's open state, so the trigger and the modal have to
// live in one tree; driving it from a separate renderHook leaves the rendered
// modal reading a stale snapshot.
function Harness() {
    const { openDelete, NodeActionModals } = useNodeActions();
    return (
        <>
            <button onClick={() => openDelete(NODE)}>open delete</button>
            {NodeActionModals}
        </>
    );
}

async function deleteNode(gitopsRevisions: ReturnType<typeof absentRevision>[]) {
    vi.mocked(apiFetch).mockResolvedValue(
        new Response(JSON.stringify({ success: true, gitopsRevisions }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }),
    );
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'open delete' }));
    fireEvent.click(await screen.findByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/nodes/3', { method: 'DELETE' }));
}

describe('useNodeActions delete', () => {
    it('reports how many blueprints the deletion re-placed', async () => {
        await deleteNode([absentRevision(), absentRevision()]);
        await waitFor(() =>
            expect(toast.success).toHaveBeenCalledWith('Node "edge-02" deleted. 2 blueprints re-placed.'),
        );
    });

    it('uses the singular for one', async () => {
        await deleteNode([absentRevision()]);
        await waitFor(() =>
            expect(toast.success).toHaveBeenCalledWith('Node "edge-02" deleted. 1 blueprint re-placed.'),
        );
    });

    it('falls back to the plain message when the list is empty', async () => {
        // Empty means both "nothing moved" and "the projection faulted after the
        // delete committed", so it can never be reported as the former.
        await deleteNode([]);
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Node "edge-02" deleted'));
    });
});
