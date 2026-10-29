/**
 * Probe failures have to name the hop that failed and point at the one surface
 * that can fix it. Both decisions read the alias snapshot, so this covers the
 * two ways that can go wrong: a probe that resolves after the snapshot
 * refreshed, and a failure with no node to resolve. It also pins the
 * throw-on-failure contract the alias row uses to turn red.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import type { MeshAlias, MeshNodeStatus } from '@/types/mesh';

const ALIAS = 'web.api.peer.sencho';

const card = vi.hoisted(() => ({
    onTestUpstream: null as ((alias: string) => Promise<void>) | null,
    onChanged: null as (() => void) | null,
}));

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
// The card is stood in for so the test can hold the callback from an earlier
// render, which is what a slow child would do.
vi.mock('./RoutingNodeCard', () => ({
    RoutingNodeCard: (props: {
        status: MeshNodeStatus;
        aliases: MeshAlias[];
        onTestUpstream: (alias: string) => Promise<void>;
        onChanged: () => void;
    }) => {
        card.onTestUpstream = props.onTestUpstream;
        card.onChanged = props.onChanged;
        return (
            <div>
                <span>{`aliases ${props.aliases.length}`}</span>
                <span>{`target ${props.aliases[0]?.nodeName ?? 'none'}`}</span>
                <button type="button" onClick={() => { void props.onTestUpstream(ALIAS).catch(() => {}); }}>
                    {`probe ${props.status.nodeName}`}
                </button>
            </div>
        );
    },
}));
vi.mock('./MeshOptInSheet', () => ({ MeshOptInSheet: () => null }));
vi.mock('./MeshDiagnosticsSheet', () => ({
    MeshDiagnosticsSheet: (props: { open: boolean; nodeName: string | null }) =>
        (props.open ? <div>{`diagnostics ${props.nodeName}`}</div> : null),
}));
vi.mock('./MeshRouteDetailSheet', () => ({
    MeshRouteDetailSheet: (props: { open: boolean; alias: string | null }) =>
        (props.open ? <div>{`route ${props.alias}`}</div> : null),
}));
vi.mock('./MeshActivitySheet', () => ({
    MeshActivitySheet: (props: { open: boolean }) => (props.open ? <div>mesh activity</div> : null),
}));
vi.mock('./MeshDataPlaneBanner', () => ({ MeshDataPlaneBanner: () => null }));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { RoutingTab } from './RoutingTab';

const STATUS: MeshNodeStatus[] = [{
    nodeId: 2,
    nodeName: 'peer-a',
    enabled: true,
    localForwarderListening: null,
    pilotConnected: false,
    reachableMode: 'proxy',
    reachableReason: null,
    reverseCallbackStatus: 'connected',
    optedInStacks: [{ stackName: 'api', currentlyResolvable: true }],
    activeStreamCount: 0,
}];

function alias(nodeName: string, port: number): MeshAlias {
    return { host: ALIAS, nodeId: 2, nodeName, stackName: 'api', serviceName: 'web', port };
}

function json(body: unknown): Response {
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function stubApi(opts: { aliases: () => MeshAlias[]; probe: () => Record<string, unknown> }): void {
    vi.mocked(apiFetch).mockImplementation(async (url: string) => {
        if (url === '/mesh/status') return json({ nodes: STATUS });
        if (url === '/mesh/aliases') return json({ aliases: opts.aliases() });
        if (url.endsWith('/test')) return json(opts.probe());
        return json({});
    });
}

function renderTab() {
    return render(<RoutingTab canManageNode={() => true} canManageMembership />);
}

beforeEach(() => {
    vi.clearAllMocks();
    card.onTestUpstream = null;
    card.onChanged = null;
});

describe('RoutingTab probe failure routing', () => {
    it('resolves the target from the freshest alias snapshot, not the one the click was rendered from', async () => {
        let current = alias('peer-a', 80);
        stubApi({ aliases: () => [current], probe: () => ({ ok: false, where: 'pilot_tunnel' }) });
        renderTab();

        await screen.findByText('target peer-a');
        const callbackFromFirstRender = card.onTestUpstream;
        expect(callbackFromFirstRender).not.toBeNull();

        // A refresh lands with the same host now owned by another node.
        current = alias('peer-b', 8080);
        act(() => { card.onChanged?.(); });
        await waitFor(() => expect(screen.getByText('target peer-b')).toBeInTheDocument());

        // The callback keeps one identity across the refresh, so a card that
        // captured it does not hold a second, older copy of the closure.
        expect(card.onTestUpstream).toBe(callbackFromFirstRender);

        // A card that kept the earlier callback must not report the old node.
        await act(async () => {
            await callbackFromFirstRender?.(ALIAS).catch(() => {});
        });
        expect(vi.mocked(toast.error)).toHaveBeenCalledWith(
            expect.stringContaining('peer-b'),
            expect.objectContaining({
                action: expect.objectContaining({ label: 'Open diagnostics' }),
            }),
        );
    });

    it('opens the route sheet, not the activity log, when a tunnel failure has no resolved node', async () => {
        stubApi({ aliases: () => [], probe: () => ({ ok: false, where: 'pilot_tunnel' }) });
        renderTab();

        await screen.findByText('aliases 0');
        await act(async () => {
            await card.onTestUpstream?.(ALIAS).catch(() => {});
        });

        const opts = vi.mocked(toast.error).mock.calls[0]?.[1];
        expect(opts?.action?.label).toBe('Open diagnostics');
        act(() => { opts?.action?.onClick(); });
        expect(screen.getByText(`route ${ALIAS}`)).toBeInTheDocument();
        expect(screen.queryByText('mesh activity')).not.toBeInTheDocument();
    });

    it('opens diagnostics for the node that owns the alias when it is known', async () => {
        stubApi({ aliases: () => [alias('peer-b', 5432)], probe: () => ({ ok: false, where: 'pilot_tunnel' }) });
        renderTab();

        await screen.findByText('target peer-b');
        await act(async () => {
            await card.onTestUpstream?.(ALIAS).catch(() => {});
        });

        const opts = vi.mocked(toast.error).mock.calls[0]?.[1];
        act(() => { opts?.action?.onClick(); });
        expect(screen.getByText('diagnostics peer-b')).toBeInTheDocument();
    });

    it('resolves a reachable probe and rejects a failed one so the row turns red', async () => {
        let result: Record<string, unknown> = { ok: true, latencyMs: 7 };
        stubApi({ aliases: () => [alias('peer-a', 80)], probe: () => result });
        renderTab();

        await screen.findByText('target peer-a');
        await expect(card.onTestUpstream?.(ALIAS)).resolves.toBeUndefined();
        expect(vi.mocked(toast.success)).toHaveBeenCalledWith(`${ALIAS} is reachable (7ms)`);

        result = { ok: false, where: 'agent_dial' };
        await expect(card.onTestUpstream?.(ALIAS)).rejects.toThrow(/could not connect to the container/);
    });

    it('sends an unexplained failure to the activity log', async () => {
        stubApi({ aliases: () => [alias('peer-a', 80)], probe: () => ({ ok: false, message: 'boom' }) });
        renderTab();

        await screen.findByText('target peer-a');
        await act(async () => {
            await card.onTestUpstream?.(ALIAS).catch(() => {});
        });

        const opts = vi.mocked(toast.error).mock.calls[0]?.[1];
        expect(opts?.action?.label).toBe('View activity');
        act(() => { opts?.action?.onClick(); });
        expect(screen.getByText('mesh activity')).toBeInTheDocument();
    });
});
