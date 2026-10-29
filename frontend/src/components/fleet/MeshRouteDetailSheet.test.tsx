/**
 * Render-gate coverage for the alias-detail Remove control and transport line.
 *
 * Removing a route opts its owning stack out of the mesh, an Admin-only cascade.
 * This locks the
 * matching UI gate: a manager sees "Remove from mesh", a non-manager does not,
 * while the read-only route detail stays available to both. It also pins the
 * transport line to the node's actual transport so a proxy peer never reports a
 * "Pilot tunnel".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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
import { toast } from '@/components/ui/toast-store';
import { MeshRouteDetailSheet } from './MeshRouteDetailSheet';
import { expectVisibleInDialog } from '@/__tests__/dialogVisibility';

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
            fleetStatus={STATUS}
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
        fireEvent.click(await screen.findByRole('button', { name: /Remove and restart/i }));
        await waitFor(() => {
            expect(vi.mocked(apiFetch)).toHaveBeenCalledWith(
                '/mesh/nodes/2/stacks/api/opt-out',
                { method: 'POST', localOnly: true },
            );
        });
        await waitFor(() => expect(onChanged).toHaveBeenCalled());
    });

    it('shows the removal impact visibly and never claims to remove zero hostnames', async () => {
        // The live alias list can lag a stack that just stopped. "This removes
        // 0 hostnames" reads like a bug, so the count is only promised when
        // there is one.
        renderSheet(true);
        fireEvent.click(await screen.findByRole('button', { name: /Remove from mesh/i }));
        expectVisibleInDialog(/api on peer-a restarts now/);
        expect(screen.getByRole('alertdialog')).not.toHaveTextContent(/0 hostnames/);
    });

    it('states the hostname count when the alias list knows the stack', async () => {
        vi.mocked(apiFetch).mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ ...DIAG, events: [] }),
        } as unknown as Response);
        render(
            <MeshRouteDetailSheet
                open
                onOpenChange={() => {}}
                alias={ALIAS}
                canManage
                fleetStatus={STATUS}
                aliases={[{ host: ALIAS, nodeId: 2, nodeName: 'peer-a', stackName: 'api', serviceName: 'web', port: 80 }]}
                onChanged={() => {}}
            />,
        );
        fireEvent.click(await screen.findByRole('button', { name: /Remove from mesh/i }));
        expectVisibleInDialog(/This removes 1 hostname published by api\./);
    });

    it('ignores a superseded alias diagnostic whose body resolves after switching aliases', async () => {
        let resolveAJson: (value: unknown) => void = () => {};
        const diagA: MeshRouteDiagnostic = {
            ...DIAG,
            alias: 'aliasA',
            target: { nodeId: 9, stack: 'old-stack', service: 'web', port: 1, alias: 'aliasA' },
        };
        vi.mocked(apiFetch).mockImplementation((url: string) => {
            if (url.includes('aliasA') && url.includes('/diagnostic')) {
                return Promise.resolve({ ok: true, json: () => new Promise((r) => { resolveAJson = r; }) } as unknown as Response);
            }
            if (url.includes('aliasB') && url.includes('/diagnostic')) {
                return Promise.resolve({ ok: true, json: async () => DIAG } as unknown as Response);
            }
            return Promise.resolve({ ok: true, json: async () => ({ events: [] }) } as unknown as Response);
        });

        const { rerender } = render(
            <MeshRouteDetailSheet open onOpenChange={() => {}} alias="aliasA" canManage fleetStatus={STATUS} aliases={[]} onChanged={() => {}} />,
        );
        // Let alias A's fetches resolve so its effect parks on the deferred body read.
        await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

        rerender(
            <MeshRouteDetailSheet open onOpenChange={() => {}} alias="aliasB" canManage fleetStatus={STATUS} aliases={[]} onChanged={() => {}} />,
        );
        expect(await screen.findByText('API proxy bridge')).toBeInTheDocument();

        // Resolve the superseded alias A body; it must not overwrite alias B.
        await act(async () => { resolveAJson(diagA); await new Promise((r) => setTimeout(r, 0)); });
        expect(screen.queryByText(/old-stack/)).not.toBeInTheDocument();
        // Alias B's proxy transport label survives; alias A (node 9, not in status)
        // would have flipped it to an unknown transport had it overwritten.
        expect(screen.getByText('API proxy bridge')).toBeInTheDocument();
    });

    it('says the stack does not restart when its node is unreachable', async () => {
        const down: MeshNodeStatus[] = [{ ...STATUS[0], reachableMode: 'unreachable', reachableReason: 'api token missing' }];
        render(
            <MeshRouteDetailSheet open onOpenChange={() => {}} alias={ALIAS} canManage fleetStatus={down} aliases={[]} onChanged={() => {}} />,
        );
        fireEvent.click(await screen.findByRole('button', { name: /Remove from mesh/i }));
        expectVisibleInDialog(/api on peer-a is not restarted, because that node is unreachable\./);
        expect(screen.getByRole('alertdialog')).not.toHaveTextContent(/restarts now/);
    });
});

describe('MeshRouteDetailSheet copy address on a plain-HTTP origin', () => {
    // The sheet is a modal with a focus trap. The clipboard fallback has to
    // select its text inside that dialog, or the trap hands focus back, the
    // copy copies nothing, and the success toast is a lie.
    const originalExec = Object.getOwnPropertyDescriptor(document, 'execCommand');
    const originalSecure = Object.getOwnPropertyDescriptor(window, 'isSecureContext');

    beforeEach(() => {
        vi.mocked(toast.success).mockClear();
        vi.mocked(toast.error).mockClear();
        Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
    });
    afterEach(() => {
        if (originalExec) Object.defineProperty(document, 'execCommand', originalExec);
        else delete (document as { execCommand?: unknown }).execCommand;
        if (originalSecure) Object.defineProperty(window, 'isSecureContext', originalSecure);
    });

    function stubExec(result: boolean): { selectedAtCopy: () => string | null } {
        let selected: string | null = null;
        Object.defineProperty(document, 'execCommand', {
            configurable: true,
            writable: true,
            value: vi.fn(() => {
                const active = document.activeElement;
                selected = active instanceof HTMLTextAreaElement
                    ? active.value.slice(active.selectionStart, active.selectionEnd)
                    : null;
                return result;
            }),
        });
        return { selectedAtCopy: () => selected };
    }

    async function clickCopy(): Promise<void> {
        const copy = await screen.findByRole('button', { name: `Copy ${ALIAS}:80` });
        copy.focus();
        await act(async () => { fireEvent.click(copy); });
    }

    it('copies the address from inside the sheet and confirms it', async () => {
        const exec = stubExec(true);
        renderSheet(true);
        await clickCopy();
        expect(exec.selectedAtCopy()).toBe(`${ALIAS}:80`);
        expect(toast.success).toHaveBeenCalledWith(`Copied ${ALIAS}:80`);
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('reports the failure instead of confirming a copy that did not happen', async () => {
        stubExec(false);
        renderSheet(true);
        await clickCopy();
        expect(toast.error).toHaveBeenCalledWith('Could not copy to the clipboard');
        expect(toast.success).not.toHaveBeenCalled();
    });
});
