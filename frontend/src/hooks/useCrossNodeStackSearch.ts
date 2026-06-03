import { useEffect, useMemo, useRef, useState } from 'react';
import { useNodes } from '@/context/NodeContext';
import { fetchForNode } from '@/lib/api';

export type StackStatus = 'running' | 'exited' | 'unknown';

export interface StackStatusInfo {
    status: StackStatus;
}

export interface StackHit {
    nodeId: number;
    nodeName: string;
    file: string;
    status: StackStatus;
}

export interface FailedNode {
    nodeId: number;
    nodeName: string;
    reason: string;
}

interface Options {
    query: string;
    enabled: boolean;
    excludeNodeId?: number;
}

const DEBOUNCE_MS = 250;

interface NodeOutcome {
    hits: StackHit[];
    failure: FailedNode | null;
}

export function useCrossNodeStackSearch({ query, enabled, excludeNodeId }: Options) {
    const { nodes } = useNodes();
    // Full per-node inventory captured for the active search session. The query
    // filter is applied client-side (see `hits` below) so refining the search
    // never re-fans-out to the fleet.
    const [inventory, setInventory] = useState<StackHit[]>([]);
    const [failedNodes, setFailedNodes] = useState<FailedNode[]>([]);
    const [loading, setLoading] = useState(false);

    // Ref avoids re-running the effect on every NodeContext status tick
    const nodesRef = useRef(nodes);
    nodesRef.current = nodes;

    const q = query.trim().toLowerCase();
    // A search "session" is active while enabled and the query is non-empty. The
    // fanout fetch runs once per session start, not per keystroke; clearing the
    // query and typing again starts a fresh session (and a fresh fetch).
    const active = enabled && q.length > 0;

    useEffect(() => {
        if (!active) {
            setInventory([]);
            setFailedNodes([]);
            setLoading(false);
            return;
        }
        const targets = nodesRef.current.filter(
            n => n.status !== 'offline' && n.id !== excludeNodeId,
        );
        if (targets.length === 0) {
            setInventory([]);
            setFailedNodes([]);
            setLoading(false);
            return;
        }
        // Starting a new fetch session (a search became active, or the active
        // node changed via excludeNodeId): drop the previous session's results
        // so a stale inventory or unreachable warning never lingers during the
        // refetch window. Refining the query keeps `active` true and does not
        // re-run this effect, so the cached inventory survives keystrokes.
        setLoading(true);
        setInventory([]);
        setFailedNodes([]);
        const controller = new AbortController();
        const timer = setTimeout(async () => {
            try {
                const perNode = await Promise.all(targets.map(async (node): Promise<NodeOutcome> => {
                    try {
                        const [listRes, statusRes] = await Promise.all([
                            fetchForNode('/stacks', node.id, { signal: controller.signal }),
                            fetchForNode('/stacks/statuses', node.id, { signal: controller.signal }),
                        ]);
                        if (!listRes.ok) {
                            return {
                                hits: [],
                                failure: {
                                    nodeId: node.id,
                                    nodeName: node.name,
                                    reason: `list returned HTTP ${listRes.status}`,
                                },
                            };
                        }
                        const rawList = await listRes.json();
                        const files: string[] = Array.isArray(rawList)
                            ? rawList.filter((f): f is string => typeof f === 'string')
                            : [];
                        const statuses: Record<string, StackStatus> = {};
                        if (statusRes.ok) {
                            try {
                                const raw = await statusRes.json();
                                for (const [key, val] of Object.entries(raw)) {
                                    if (typeof val === 'string') {
                                        statuses[key] = val as StackStatus;
                                    } else if (val && typeof val === 'object' && 'status' in val) {
                                        statuses[key] = (val as StackStatusInfo).status;
                                    }
                                }
                            } catch {
                                // A 200 with an unparseable status body must not discard the
                                // stack list we already fetched; leave statuses empty so every
                                // stack degrades to 'unknown' rather than failing the node.
                            }
                        }
                        // Capture the whole node inventory; filtering is client-side.
                        const nodeHits = files.map<StackHit>(file => ({
                            nodeId: node.id,
                            nodeName: node.name,
                            file,
                            status: statuses[file] ?? 'unknown',
                        }));
                        return { hits: nodeHits, failure: null };
                    } catch (err) {
                        // AbortError is expected when the effect cleans up; don't
                        // surface it as a node failure to the user.
                        if ((err as Error)?.name === 'AbortError') {
                            return { hits: [], failure: null };
                        }
                        return {
                            hits: [],
                            failure: {
                                nodeId: node.id,
                                nodeName: node.name,
                                reason: (err as Error)?.message ?? 'unreachable',
                            },
                        };
                    }
                }));
                if (controller.signal.aborted) return;
                setInventory(perNode.flatMap(o => o.hits));
                setFailedNodes(perNode.flatMap(o => (o.failure ? [o.failure] : [])));
            } finally {
                if (!controller.signal.aborted) setLoading(false);
            }
        }, DEBOUNCE_MS);
        return () => {
            clearTimeout(timer);
            controller.abort();
        };
    }, [active, excludeNodeId]);

    // Client-side query filter over the session inventory. No network on keystrokes.
    const hits = useMemo(
        () => (active ? inventory.filter(h => h.file.toLowerCase().includes(q)) : []),
        [active, inventory, q],
    );

    return { hits, failedNodes, loading };
}
