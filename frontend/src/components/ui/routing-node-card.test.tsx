/**
 * Render-gate coverage for the routing-node-card `canManage` prop.
 *
 * Enabling/disabling mesh on a node and opting a stack in are admin-only on the
 * backend. This locks the matching UI gate: a manager sees the enable/disable
 * toggle and the enable/add CTAs, a non-manager sees neither (just a hint) while
 * the read-only affordances, diagnostics in particular, stay available. Without
 * this the card can drift back to rendering a control the API answers with 403.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('@/lib/clipboard', () => ({ copyToClipboard: vi.fn(async () => {}) }));
vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import { copyToClipboard } from '@/lib/clipboard';
import { toast } from '@/components/ui/toast-store';
import { RoutingNodeCard, type RoutingNodeCardProps } from '@/components/ui/routing-node-card';

function renderCard(overrides: Partial<RoutingNodeCardProps> = {}) {
    const props: RoutingNodeCardProps = {
        crumb: ['Routing', 'Node', 'node-alpha'],
        name: 'node-alpha',
        nodeState: 'idle',
        meta: { reverseBridge: 'na', stacks: 0, aliases: 0 },
        aliases: [],
        onToggleEnabled: vi.fn(),
        onShowDiagnostics: vi.fn(),
        onAddStack: vi.fn(),
        onRetry: vi.fn(),
        footerContext: 'Mesh off',
        // canManage is required on the primitive; tests override it per case.
        canManage: true,
        ...overrides,
    };
    return render(<RoutingNodeCard {...props} />);
}

describe('routing-node-card canManage gate', () => {
    it('shows the enable toggle and the enable CTA for a manager', () => {
        renderCard({ nodeState: 'idle', canManage: true });
        expect(screen.getByRole('switch')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Enable mesh on node-alpha/i })).toBeInTheDocument();
        expect(screen.queryByText(/Managing the mesh requires an administrator/i)).not.toBeInTheDocument();
    });

    it('hides the toggle and enable CTA for a non-manager but keeps diagnostics', () => {
        renderCard({ nodeState: 'idle', canManage: false });
        expect(screen.queryByRole('switch')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Enable mesh on/i })).not.toBeInTheDocument();
        expect(screen.getByText(/Managing the mesh requires an administrator/i)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Diagnostics/i })).toBeInTheDocument();
    });

    it('hides the add-stack CTA for a non-manager on a meshed node', () => {
        renderCard({
            nodeState: 'meshed',
            meta: { reverseBridge: 'up', stacks: 0, aliases: 0 },
            canManage: false,
        });
        expect(screen.queryByRole('switch')).not.toBeInTheDocument();
        expect(screen.queryByText(/Add stack to mesh/i)).not.toBeInTheDocument();
        expect(screen.getByText(/Managing the mesh requires an administrator/i)).toBeInTheDocument();
    });

    it('keeps the retry CTA for a non-manager on a degraded node', () => {
        // Retry is a read-only refresh, not a management action, so it must
        // survive the gate. A regression dropping the management-state check
        // would hide it for non-admins.
        renderCard({ nodeState: 'degraded', canManage: false });
        expect(screen.getByRole('button', { name: /Retry now/i })).toBeInTheDocument();
        expect(screen.queryByText(/Managing the mesh requires an administrator/i)).not.toBeInTheDocument();
    });

    it('keeps the retry CTA for a non-manager on an offline node', () => {
        renderCard({ nodeState: 'offline', canManage: false });
        expect(screen.getByRole('button', { name: /Retry now/i })).toBeInTheDocument();
    });
});

describe('routing-node-card add-stack reachability and connecting state', () => {
    const oneAlias = [{ host: 'web.api.node', port: 8080, kind: 'alias' as const }];

    it('keeps an add-stack control for a manager on a meshed node that already has aliases', () => {
        renderCard({
            nodeState: 'meshed',
            meta: { reverseBridge: 'up', stacks: 1, aliases: 1 },
            aliases: oneAlias,
            canManage: true,
        });
        expect(screen.getByRole('button', { name: /Add stack/i })).toBeInTheDocument();
    });

    it('hides the add-stack control for a non-manager on a meshed node with aliases', () => {
        renderCard({
            nodeState: 'meshed',
            meta: { reverseBridge: 'up', stacks: 1, aliases: 1 },
            aliases: oneAlias,
            canManage: false,
        });
        expect(screen.queryByRole('button', { name: /Add stack/i })).not.toBeInTheDocument();
    });

    it('renders the connecting state as passive with no retry button', () => {
        renderCard({ nodeState: 'connecting', canManage: true });
        expect(screen.getByText(/Connecting to the mesh/i)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Retry now/i })).not.toBeInTheDocument();
    });
});

describe('routing-node-card canManage gate (compact density)', () => {
    beforeEach(() => {
        window.localStorage.setItem('sencho.appearance.density', 'compact');
    });
    afterEach(() => {
        window.localStorage.removeItem('sencho.appearance.density');
    });

    it('hides the toggle for a non-manager on a meshed node', () => {
        renderCard({
            nodeState: 'meshed',
            meta: { reverseBridge: 'up', stacks: 0, aliases: 0 },
            canManage: false,
        });
        expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    });

    it('shows the toggle for a manager on a meshed node', () => {
        renderCard({
            nodeState: 'meshed',
            meta: { reverseBridge: 'up', stacks: 0, aliases: 0 },
            canManage: true,
        });
        expect(screen.getByRole('switch')).toBeInTheDocument();
    });

    it('keeps the retry CTA for a non-manager on an offline node', () => {
        renderCard({ nodeState: 'offline', canManage: false });
        expect(screen.getByRole('button', { name: /Retry now/i })).toBeInTheDocument();
    });
});

describe('routing-node-card alias row copy', () => {
    const address = 'web.api.node:8080';
    const liveRow = [{ host: 'web.api.node', port: 8080, kind: 'alias' as const }];

    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    function renderWithAlias(aliases: RoutingNodeCardProps['aliases']) {
        return renderCard({
            nodeState: 'meshed',
            meta: { reverseBridge: 'up', stacks: 1, aliases: aliases.length },
            aliases,
        });
    }

    it('copies host:port and acknowledges the copy', async () => {
        renderWithAlias(liveRow);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: `Copy ${address}` }));
        });
        expect(copyToClipboard).toHaveBeenCalledWith(address);
        expect(screen.getByRole('button', { name: `Copied ${address}` })).toBeInTheDocument();
    });

    it('returns the control to its idle label after the acknowledgement window', async () => {
        renderWithAlias(liveRow);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: `Copy ${address}` }));
        });
        await act(async () => { vi.advanceTimersByTime(1500); });
        expect(screen.getByRole('button', { name: `Copy ${address}` })).toBeInTheDocument();
    });

    it('clears the pending acknowledgement timer when the row unmounts', async () => {
        const view = renderWithAlias(liveRow);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: `Copy ${address}` }));
        });
        view.unmount();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('offers no copy control for a suspended row', () => {
        renderWithAlias([{ host: 'stopped-stack', port: 0, kind: 'suspended' }]);
        expect(screen.queryByRole('button', { name: /Copy/ })).not.toBeInTheDocument();
    });

    it('says so when the clipboard rejects instead of failing silently', async () => {
        vi.mocked(copyToClipboard).mockRejectedValueOnce(new Error('denied'));
        renderWithAlias(liveRow);
        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: `Copy ${address}` }));
        });
        expect(toast.error).toHaveBeenCalledWith('Could not copy to the clipboard');
        expect(screen.getByRole('button', { name: `Copy ${address}` })).toBeInTheDocument();
    });
});
