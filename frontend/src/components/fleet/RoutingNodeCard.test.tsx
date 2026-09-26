/**
 * Covers the routing node state derivation and the post-enable auto-converge.
 *
 * `deriveNodeState` is the function this change reworked to split the transient
 * `connecting` (proxy bridge mid-dial) from a genuine `degraded` bridge fault.
 * The auto-converge re-poll keeps the card from stranding on a manual refresh
 * after enable, and must not fire after a disable or after unmount.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { MeshNodeStatus } from '@/types/mesh';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import { apiFetch } from '@/lib/api';
import { RoutingNodeCard } from './RoutingNodeCard';
import { deriveNodeState } from './routingNodeState';

function node(over: Partial<MeshNodeStatus>): MeshNodeStatus {
    return {
        nodeId: 1,
        nodeName: 'node-alpha',
        enabled: true,
        localForwarderListening: null,
        pilotConnected: false,
        reachableMode: 'proxy',
        reachableReason: null,
        reverseCallbackStatus: 'connected',
        optedInStacks: [],
        activeStreamCount: 0,
        ...over,
    };
}

describe('deriveNodeState', () => {
    it('is offline when the node is unreachable', () => {
        expect(deriveNodeState(node({ reachableMode: 'unreachable' }))).toBe('offline');
    });
    it('is idle when mesh is disabled', () => {
        expect(deriveNodeState(node({ enabled: false }))).toBe('idle');
    });
    it('is degraded when a pilot tunnel is down', () => {
        expect(deriveNodeState(node({ reachableMode: 'pilot', pilotConnected: false }))).toBe('degraded');
    });
    it('is connecting while the proxy bridge is dialing', () => {
        expect(deriveNodeState(node({ reverseCallbackStatus: 'connecting' }))).toBe('connecting');
    });
    it('is degraded when the proxy bridge is unavailable', () => {
        expect(deriveNodeState(node({ reverseCallbackStatus: 'unavailable' }))).toBe('degraded');
    });
    it('is meshed when the proxy bridge is connected', () => {
        expect(deriveNodeState(node({ reverseCallbackStatus: 'connected' }))).toBe('meshed');
    });
});

function renderCard(status: MeshNodeStatus, fleetStatus: MeshNodeStatus[] = [status]) {
    const onChanged = vi.fn();
    const view = render(
        <RoutingNodeCard
            status={status}
            fleetStatus={fleetStatus}
            aliases={[]}
            onAddStack={vi.fn()}
            onShowDiagnostics={vi.fn()}
            onShowAlias={vi.fn()}
            onTestUpstream={async () => {}}
            onChanged={onChanged}
            canManage
        />,
    );
    return { onChanged, view };
}

describe('RoutingNodeCard enable auto-converge', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
    });
    afterEach(() => {
        vi.runOnlyPendingTimers();
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('re-polls a few times after enabling so the card converges without a manual refresh', async () => {
        const { onChanged } = renderCard(node({ enabled: false, reverseCallbackStatus: 'not_applicable' }));
        await act(async () => { fireEvent.click(screen.getByRole('switch')); });
        // Immediate refresh once the enable resolves.
        expect(onChanged).toHaveBeenCalledTimes(1);
        await act(async () => { vi.advanceTimersByTime(6000); });
        // Plus the three scheduled re-polls.
        expect(onChanged).toHaveBeenCalledTimes(4);
    });

    it('does not schedule re-polls after disabling', async () => {
        const { onChanged } = renderCard(node({ enabled: true, reverseCallbackStatus: 'connected' }));
        await act(async () => { fireEvent.click(screen.getByRole('switch')); });
        expect(onChanged).toHaveBeenCalledTimes(1);
        await act(async () => { vi.advanceTimersByTime(6000); });
        expect(onChanged).toHaveBeenCalledTimes(1);
    });

    it('clears pending re-poll timers on unmount', async () => {
        const { onChanged, view } = renderCard(node({ enabled: false, reverseCallbackStatus: 'not_applicable' }));
        await act(async () => { fireEvent.click(screen.getByRole('switch')); });
        expect(onChanged).toHaveBeenCalledTimes(1);
        view.unmount();
        await act(async () => { vi.advanceTimersByTime(6000); });
        expect(onChanged).toHaveBeenCalledTimes(1);
    });

    it('does not fire after the card unmounts before the enable request resolves', async () => {
        let resolveEnable: (value: unknown) => void = () => {};
        vi.mocked(apiFetch).mockReturnValueOnce(
            new Promise((resolve) => { resolveEnable = resolve; }) as unknown as Promise<Response>,
        );
        const { onChanged, view } = renderCard(node({ enabled: false, reverseCallbackStatus: 'not_applicable' }));
        await act(async () => { fireEvent.click(screen.getByRole('switch')); });
        view.unmount();
        await act(async () => {
            resolveEnable({ ok: true, status: 200, json: async () => ({}) });
            await Promise.resolve();
            vi.advanceTimersByTime(6000);
        });
        expect(onChanged).not.toHaveBeenCalled();
    });
});

/**
 * `ConfirmModal.description` renders into a screen-reader-only element, so a
 * text match alone proves nothing about what a sighted operator sees. This
 * walks up from the matched text and fails if any ancestor inside the dialog
 * is the sr-only description, which is exactly the regression that made the
 * impact copy invisible.
 */
function expectVisibleInDialog(text: RegExp): void {
    const dialog = screen.getByRole('alertdialog');
    const matches = screen.getAllByText(text);
    const hidden = matches.filter((el) => {
        for (let cur: HTMLElement | null = el; cur && cur !== dialog; cur = cur.parentElement) {
            if (/\bsr-only\b/.test(cur.className)) return true;
        }
        return false;
    });
    expect(matches.length - hidden.length, `visible copy of ${text}`).toBeGreaterThan(0);
}

describe('RoutingNodeCard disable confirmation', () => {
    beforeEach(() => {
        vi.mocked(apiFetch).mockResolvedValue({ ok: true, status: 200, json: async () => ({}) } as unknown as Response);
    });
    afterEach(() => { vi.clearAllMocks(); });

    it('asks before turning mesh off and states what restarts', async () => {
        const status = node({ enabled: true, optedInStacks: [{ stackName: 'pg', currentlyResolvable: true }] });
        const other = node({ nodeId: 2, nodeName: 'node-beta', optedInStacks: [{ stackName: 'app', currentlyResolvable: true }] });
        render(
            <RoutingNodeCard
                status={status}
                fleetStatus={[status, other]}
                aliases={[]}
                onAddStack={vi.fn()}
                onShowDiagnostics={vi.fn()}
                onShowAlias={vi.fn()}
                onTestUpstream={async () => {}}
                onChanged={vi.fn()}
                canManage
            />,
        );
        await act(async () => { fireEvent.click(screen.getByRole('switch')); });
        expect(apiFetch).not.toHaveBeenCalled();
        await screen.findByRole('button', { name: /Turn off and restart/i });
        expectVisibleInDialog(/1 meshed stack on this node leaves the mesh and restarts\. 1 other meshed stack on 1 node also restarts/);

        await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Turn off and restart/i })); });
        expect(apiFetch).toHaveBeenCalledWith('/mesh/nodes/1/disable', expect.objectContaining({ method: 'POST' }));
    });

    it('turns mesh off without a prompt when nothing in the fleet is meshed', async () => {
        const status = node({ enabled: true });
        render(
            <RoutingNodeCard
                status={status}
                fleetStatus={[status]}
                aliases={[]}
                onAddStack={vi.fn()}
                onShowDiagnostics={vi.fn()}
                onShowAlias={vi.fn()}
                onTestUpstream={async () => {}}
                onChanged={vi.fn()}
                canManage
            />,
        );
        await act(async () => { fireEvent.click(screen.getByRole('switch')); });
        expect(apiFetch).toHaveBeenCalledWith('/mesh/nodes/1/disable', expect.objectContaining({ method: 'POST' }));
    });
});
