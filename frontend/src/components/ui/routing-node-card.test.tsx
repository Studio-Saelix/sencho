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
import { render, screen } from '@testing-library/react';
import { RoutingNodeCard, type RoutingNodeCardProps } from '@/components/ui/routing-node-card';

function renderCard(overrides: Partial<RoutingNodeCardProps> = {}) {
    const props: RoutingNodeCardProps = {
        crumb: ['Routing', 'Node', 'node-alpha'],
        name: 'node-alpha',
        nodeState: 'idle',
        meta: { pilotConnected: true, reverseBridge: 'na', stacks: 0, aliases: 0 },
        aliases: [],
        onToggleEnabled: vi.fn(),
        onShowDiagnostics: vi.fn(),
        onAddStack: vi.fn(),
        onRetry: vi.fn(),
        footerContext: 'Mesh off',
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
            meta: { pilotConnected: true, reverseBridge: 'up', stacks: 0, aliases: 0 },
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

    it('defaults to manageable when canManage is omitted', () => {
        renderCard({ nodeState: 'idle' });
        expect(screen.getByRole('switch')).toBeInTheDocument();
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
            meta: { pilotConnected: true, reverseBridge: 'up', stacks: 0, aliases: 0 },
            canManage: false,
        });
        expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    });

    it('shows the toggle for a manager on a meshed node', () => {
        renderCard({
            nodeState: 'meshed',
            meta: { pilotConnected: true, reverseBridge: 'up', stacks: 0, aliases: 0 },
            canManage: true,
        });
        expect(screen.getByRole('switch')).toBeInTheDocument();
    });

    it('keeps the retry CTA for a non-manager on an offline node', () => {
        renderCard({ nodeState: 'offline', canManage: false });
        expect(screen.getByRole('button', { name: /Retry now/i })).toBeInTheDocument();
    });
});
