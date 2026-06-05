/**
 * Render-gate coverage for MeshOptInSheet's opt-in/out controls.
 *
 * Opting a stack in or out is admin-only on the backend
 * (POST /api/mesh/nodes/:id/stacks/:stack/opt-in|opt-out require admin). This
 * test locks the matching UI gate: a manager sees Add/Remove buttons, a
 * non-manager sees the membership read-only with a hint. The read-only branch
 * must never issue the admin-only mutation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MeshStackEntry } from '@/types/mesh';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import { apiFetch } from '@/lib/api';
import { MeshOptInSheet } from './MeshOptInSheet';

const STACKS: MeshStackEntry[] = [
    { name: 'web', optedIn: true },
    { name: 'db', optedIn: false },
];

beforeEach(() => {
    vi.mocked(apiFetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ stacks: STACKS }),
    } as unknown as Response);
});

function renderSheet(canManage: boolean) {
    return render(
        <MeshOptInSheet
            open={true}
            onOpenChange={() => {}}
            nodeId={1}
            nodeName="node-alpha"
            onChanged={() => {}}
            canManage={canManage}
        />,
    );
}

describe('MeshOptInSheet canManage gate', () => {
    it('shows opt-in/out controls for a manager', async () => {
        renderSheet(true);
        expect(await screen.findByText('web')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Remove from mesh/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Add to mesh/i })).toBeInTheDocument();
        expect(screen.queryByText(/Changing mesh membership requires an administrator/i)).not.toBeInTheDocument();
    });

    it('renders the membership read-only for a non-manager', async () => {
        renderSheet(false);
        expect(await screen.findByText('web')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Remove from mesh/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Add to mesh/i })).not.toBeInTheDocument();
        expect(screen.getByText(/Changing mesh membership requires an administrator/i)).toBeInTheDocument();
        // The read-only branch must never issue an opt-in/opt-out request.
        expect(vi.mocked(apiFetch)).not.toHaveBeenCalledWith(
            expect.stringContaining('/opt-'),
            expect.anything(),
        );
    });
});
