import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { formatAgeShort } from '@/lib/relativeTime';
import type { MeshAlias, MeshNodeStatus } from '@/types/mesh';
import {
    RoutingNodeCard as RoutingNodeCardPrimitive,
    type RoutingAliasRow,
    type RoutingNodeCardMeta,
    type RoutingNodeState,
} from '@/components/ui/routing-node-card';
import { deriveNodeState } from './routingNodeState';

interface Props {
    status: MeshNodeStatus;
    aliases: MeshAlias[];
    onAddStack: () => void;
    onShowDiagnostics: () => void;
    onShowAlias: (alias: string) => void;
    onTestUpstream: (alias: string) => Promise<void>;
    onChanged: () => void;
    canManage: boolean;
}

const REVERSE_BRIDGE: Record<MeshNodeStatus['reverseCallbackStatus'], RoutingNodeCardMeta['reverseBridge']> = {
    connected: 'up',
    connecting: 'unavailable',
    unavailable: 'unavailable',
    not_applicable: 'na',
};

function buildFooterContext(
    nodeState: RoutingNodeState,
    status: MeshNodeStatus,
    seenAgeMs: number,
): string {
    const seen = formatAgeShort(seenAgeMs);
    switch (nodeState) {
        case 'meshed': {
            const reverse = status.reverseCallbackStatus === 'connected'
                ? 'up'
                : status.reverseCallbackStatus === 'not_applicable'
                    ? 'n/a'
                    : 'unavail';
            return `Reverse bridge ${reverse} · reconcile ${seen}`;
        }
        case 'idle':
            return `Mesh off · seen ${seen}`;
        case 'connecting':
            return `Bringing up bridge · ${seen}`;
        case 'degraded':
            return `Last seen ${seen}`;
        case 'offline':
            return `Last seen ${seen}`;
        default: {
            const _exhaustive: never = nodeState;
            throw new Error(`Unhandled routing node state: ${String(_exhaustive)}`);
        }
    }
}

export function RoutingNodeCard({
    status, aliases, onAddStack, onShowDiagnostics, onShowAlias, onTestUpstream, onChanged, canManage,
}: Props) {
    const [toggling, setToggling] = useState(false);
    const [testingAlias, setTestingAlias] = useState<string | null>(null);
    const [lastTestedByHost, setLastTestedByHost] = useState<Map<string, { at: number; ok: boolean }>>(() => new Map());
    const lastSeenRef = useRef<number>(Date.now());
    const lastStatusSignatureRef = useRef<string>('');
    const mountedRef = useRef(true);
    // Short re-poll timers fired after an enable so the card converges to
    // `meshed` once the proxy bridge finishes dialing (see toggleEnabled).
    const convergeTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
    const clearConvergeTimers = () => {
        convergeTimersRef.current.forEach(clearTimeout);
        convergeTimersRef.current = [];
    };
    useEffect(() => () => {
        mountedRef.current = false;
        convergeTimersRef.current.forEach(clearTimeout);
        convergeTimersRef.current = [];
    }, []);

    // Track only health-bearing fields; `activeStreamCount` and stack-count
    // churn would otherwise reset the "seen" clock on every reconcile tick.
    const signature = `${status.enabled}|${status.reachableMode}|${status.pilotConnected}|${status.reverseCallbackStatus}`;
    if (signature !== lastStatusSignatureRef.current) {
        lastStatusSignatureRef.current = signature;
        lastSeenRef.current = Date.now();
    }

    const nodeAliases = useMemo(() => aliases.filter((a) => a.nodeId === status.nodeId), [aliases, status.nodeId]);
    // Defensive de-dup: `/mesh/status` and `/mesh/aliases` are fetched separately,
    // so a transient inconsistency could otherwise render both a live row and a
    // suspended row for the same stack. Drop suspended entries the alias snapshot
    // still covers; the alias row already represents the live state.
    const stackNamesWithAliases = useMemo(
        () => new Set(nodeAliases.map((a) => a.stackName)),
        [nodeAliases],
    );
    const suspended = useMemo(
        () => status.optedInStacks.filter(
            (s) => !s.currentlyResolvable && !stackNamesWithAliases.has(s.stackName),
        ),
        [status.optedInStacks, stackNamesWithAliases],
    );

    const rows: RoutingAliasRow[] = useMemo(() => {
        const live: RoutingAliasRow[] = nodeAliases.map((a) => ({
            host: a.host,
            port: a.port,
            kind: 'alias',
            lastTested: lastTestedByHost.get(a.host),
            testing: testingAlias === a.host,
        }));
        const sus: RoutingAliasRow[] = suspended.map((s) => ({
            host: s.stackName,
            port: 0,
            kind: 'suspended',
        }));
        return [...live, ...sus];
    }, [nodeAliases, suspended, lastTestedByHost, testingAlias]);

    const nodeState = deriveNodeState(status);
    const meta: RoutingNodeCardMeta = {
        reverseBridge: REVERSE_BRIDGE[status.reverseCallbackStatus],
        stacks: status.optedInStacks.length,
        aliases: nodeAliases.length,
    };
    const seenAgeMs = Date.now() - lastSeenRef.current;
    const footerContext = buildFooterContext(nodeState, status, seenAgeMs);

    const toggleEnabled = async (next: boolean) => {
        if (toggling) return;
        // Cancel any in-flight converge batch up front, so a slow disable (or a
        // re-toggle) can never let a prior enable's re-polls fire mid-request.
        clearConvergeTimers();
        setToggling(true);
        try {
            const action = next ? 'enable' : 'disable';
            const res = await apiFetch(`/mesh/nodes/${status.nodeId}/${action}`, {
                method: 'POST', localOnly: true,
            });
            if (!res.ok) throw new Error(`status ${res.status}`);
            // The request can resolve after the card unmounts; bail before any
            // toast, refresh, or timer scheduling so nothing fires post-unmount.
            if (!mountedRef.current) return;
            toast.success(next ? 'Mesh enabled on node' : 'Mesh disabled on node');
            onChanged();
            if (next) {
                // The proxy bridge dials asynchronously on enable, so the first
                // status poll usually still reports `connecting`. Re-poll a few
                // times so the card settles to meshed on its own rather than
                // stranding the user on a manual refresh.
                convergeTimersRef.current = [1500, 3500, 6000].map((ms) => setTimeout(onChanged, ms));
            }
        } catch (err) {
            if (!mountedRef.current) return;
            toast.error(`Failed to ${next ? 'enable' : 'disable'} mesh: ${(err as Error).message}`);
        } finally {
            if (mountedRef.current) setToggling(false);
        }
    };

    const handleTestAlias = async (host: string) => {
        if (testingAlias) return;
        setTestingAlias(host);
        try {
            await onTestUpstream(host);
            setLastTestedByHost((prev) => {
                const next = new Map(prev);
                next.set(host, { at: Date.now(), ok: true });
                return next;
            });
        } catch {
            setLastTestedByHost((prev) => {
                const next = new Map(prev);
                next.set(host, { at: Date.now(), ok: false });
                return next;
            });
        } finally {
            setTestingAlias(null);
        }
    };

    return (
        <RoutingNodeCardPrimitive
            crumb={['Routing', 'Node', status.nodeName]}
            name={status.nodeName}
            isLocal={status.reachableMode === 'local'}
            nodeState={nodeState}
            meta={meta}
            aliases={rows}
            onToggleEnabled={(next) => { void toggleEnabled(next); }}
            onShowDiagnostics={onShowDiagnostics}
            onShowAlias={onShowAlias}
            onTestAlias={(host) => { void handleTestAlias(host); }}
            onAddStack={onAddStack}
            onRetry={onChanged}
            footerContext={footerContext}
            offlineReason={status.reachableReason}
            canManage={canManage}
        />
    );
}
