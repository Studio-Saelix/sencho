/**
 * Render-gate coverage for MeshOptInSheet's opt-in/out controls.
 *
 * Opting a stack in or out is Admin-only because it cascades across mesh stacks.
 * This test locks the matching UI gate: an Admin sees Add/Remove buttons, while a user without
 * non-manager sees the membership read-only with a hint. The read-only branch
 * must never issue the mutation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { MeshNodeStatus, MeshStackEntry } from '@/types/mesh';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import { apiFetch } from '@/lib/api';
import { MeshOptInSheet } from './MeshOptInSheet';
import { expectVisibleInDialog } from '@/__tests__/dialogVisibility';

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

function renderSheet(canManage: boolean, fleetStatus: MeshNodeStatus[] = []) {
    return render(
        <MeshOptInSheet
            open={true}
            onOpenChange={() => {}}
            nodeId={1}
            nodeName="node-alpha"
            fleetStatus={fleetStatus}
            onChanged={() => {}}
            canManage={canManage}
        />,
    );
}

function meshNode(nodeId: number, nodeName: string, stacks: string[]): MeshNodeStatus {
    return {
        nodeId,
        nodeName,
        enabled: true,
        localForwarderListening: null,
        pilotConnected: false,
        reachableMode: 'local',
        reachableReason: null,
        reverseCallbackStatus: 'not_applicable',
        optedInStacks: stacks.map((stackName) => ({ stackName, currentlyResolvable: true })),
        activeStreamCount: 0,
    };
}

describe('MeshOptInSheet canManage gate', () => {
    it('shows opt-in/out controls for a manager', async () => {
        renderSheet(true);
        expect(await screen.findByText('web')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Remove from mesh/i })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Add to mesh/i })).toBeInTheDocument();
        expect(screen.queryByText(/changing mesh membership requires an administrator/i)).not.toBeInTheDocument();
    });

    it('renders the membership read-only for a non-manager', async () => {
        renderSheet(false);
        expect(await screen.findByText('web')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Remove from mesh/i })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Add to mesh/i })).not.toBeInTheDocument();
        expect(screen.getByText(/changing mesh membership requires an administrator/i)).toBeInTheDocument();
        // The read-only branch must never issue an opt-in/opt-out request.
        expect(vi.mocked(apiFetch)).not.toHaveBeenCalledWith(
            expect.stringContaining('/opt-'),
            expect.anything(),
        );
    });
});

describe('MeshOptInSheet cascade confirmation', () => {
    // The backend restarts every meshed stack in the fleet, not only the one
    // that changed. The dialog has to say so before the operator commits.
    const fleet = [meshNode(1, 'node-alpha', ['other']), meshNode(2, 'node-beta', ['api'])];

    it('asks before adding and names the whole cascade', async () => {
        renderSheet(true, fleet);
        fireEvent.click(await screen.findByRole('button', { name: /Add to mesh/i }));
        expect(screen.getByText('Add db to mesh?')).toBeInTheDocument();
        expectVisibleInDialog(
            /db on node-alpha restarts now\. other on node-alpha; api on node-beta also restart to refresh hostnames/,
        );
        expect(screen.getByRole('button', { name: /Add and restart/i })).toBeInTheDocument();
    });

    it('asks before removing and names the restart', async () => {
        renderSheet(true, fleet);
        fireEvent.click(await screen.findByRole('button', { name: /Remove from mesh/i }));
        expect(screen.getByText('Remove web from mesh?')).toBeInTheDocument();
        expectVisibleInDialog(
            /web on node-alpha restarts now\. other on node-alpha; api on node-beta also restart to refresh hostnames/,
        );
        expect(screen.getByRole('button', { name: /Remove and restart/i })).toBeInTheDocument();
    });

    it('names the stopped stack the redeploy brings up', async () => {
        const stopped = meshNode(2, 'node-beta', ['api']);
        stopped.optedInStacks = [{ stackName: 'api', currentlyResolvable: false }];
        renderSheet(true, [meshNode(1, 'node-alpha', ['other']), stopped]);
        fireEvent.click(await screen.findByRole('button', { name: /Add to mesh/i }));
        expectVisibleInDialog(/api on node-beta is not running right now, and the redeploy brings it up\./);
    });

    it('does not say the changed stack restarts when its node is unreachable', async () => {
        const down = { ...meshNode(1, 'node-alpha', ['other']), reachableMode: 'pilot' as const, pilotConnected: false };
        renderSheet(true, [down, meshNode(2, 'node-beta', ['api'])]);
        fireEvent.click(await screen.findByRole('button', { name: /Add to mesh/i }));
        expectVisibleInDialog(/db on node-alpha is not restarted, because that node is unreachable\./);
        expect(screen.queryByText(/db on node-alpha restarts now/)).not.toBeInTheDocument();
    });
});
