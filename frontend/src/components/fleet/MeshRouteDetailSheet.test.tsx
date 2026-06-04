/**
 * Render-gate coverage for the alias-detail Remove control and transport line.
 *
 * Removing a route opts its owning stack out of the mesh, an admin-only mutation
 * (POST /api/mesh/nodes/:id/stacks/:stack/opt-out requires admin). This locks the
 * matching UI gate: a manager sees "Remove from mesh", a non-manager does not,
 * while the read-only route detail stays available to both. It also pins the
 * transport line to the node's actual transport so a proxy peer never reports a
 * "Pilot tunnel".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { MeshNodeStatus, MeshRouteDiagnostic } from '@/types/mesh';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));
vi.mock('@xyflow/react', () => ({
    ReactFlow: () => null,
    Background: () => null,
    Handle: () => null,
    Position: { Left: 'left', Right: 'right' },
    useNodesState: <T,>() => [[] as T[], () => {}, () => {}],
    useEdgesState: <T,>() => [[] as T[], () => {}, () => {}],
}));

import { apiFetch } from '@/lib/api';
import { MeshRouteDetailSheet } from './MeshRouteDetailSheet';

const ALIAS = 'web.api.peer.sencho';

const DIAG: MeshRouteDiagnostic = {
    alias: ALIAS,
    target: { nodeId: 2, stack: 'api', service: 'web', port: 80, alias: ALIAS },
    pilot: { connected: false, lastSeen: null },
    lastError: null,
    lastProbeMs: null,
    lastProbeAt: null,
    state: 'healthy',
};

const STATUS: MeshNodeStatus[] = [
    {
        nodeId: 2, nodeName: 'peer-a', enabled: true, localForwarderListening: null,
        pilotConnected: false, reachableMode: 'proxy', reachableReason: null,
        reverseCallbackStatus: 'connected', optedInStacks: [], activeStreamCount: 0,
    },
];

beforeEach(() => {
    // One combined payload serves both the diagnostic and activity fetches:
    // the diagnostic reader uses the route fields, the activity reader reads `events`.
    const combined = { ...DIAG, events: [] };
    vi.mocked(apiFetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => combined,
    } as unknown as Response);
});

function renderSheet(canManage: boolean, onChanged: () => void = () => {}) {
    return render(
        <MeshRouteDetailSheet
            open
            onOpenChange={() => {}}
            alias={ALIAS}
            canManage={canManage}
            status={STATUS}
            aliases={[]}
            onChanged={onChanged}
        />,
    );
}

describe('MeshRouteDetailSheet remove gate', () => {
    it('shows Remove from mesh for a manager once the target resolves', async () => {
        renderSheet(true);
        expect(await screen.findByRole('button', { name: /Remove from mesh/i })).toBeInTheDocument();
    });

    it('hides Remove from mesh for a non-manager', async () => {
        renderSheet(false);
        // Wait for the diagnostic to load, then assert the remove control is absent.
        expect(await screen.findByText('Target node')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Remove from mesh/i })).not.toBeInTheDocument();
    });

    it('labels a proxy peer transport as the API proxy bridge, not a pilot tunnel', async () => {
        renderSheet(true);
        expect(await screen.findByText('API proxy bridge')).toBeInTheDocument();
        expect(screen.queryByText('Pilot tunnel')).not.toBeInTheDocument();
    });

    it('opts the owning stack out via the opt-out endpoint when the removal is confirmed', async () => {
        const onChanged = vi.fn();
        renderSheet(true, onChanged);
        fireEvent.click(await screen.findByRole('button', { name: /Remove from mesh/i }));
        fireEvent.click(await screen.findByRole('button', { name: /Remove and redeploy/i }));
        await waitFor(() => {
            expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
                '/mesh/nodes/2/stacks/api/opt-out',
                { method: 'POST', localOnly: true },
            );
        });
        await waitFor(() => expect(onChanged).toHaveBeenCalled());
    });
});
