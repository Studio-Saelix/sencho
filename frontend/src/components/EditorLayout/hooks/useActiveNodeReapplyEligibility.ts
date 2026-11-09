import { useState, useEffect, useRef, useCallback } from 'react';
import { apiFetch } from '@/lib/api';
import type { NodeUpdateStatus, ReapplyUnavailableReason } from '@/components/FleetView/types';

type OwnedEligibility = {
    nodeId: number;
    value: boolean;
    reason: ReapplyUnavailableReason | null;
    /** False when the read itself failed, so `value` is "unknown", not "ineligible". */
    proven: boolean;
};

/** What a click-time re-read found for the node that was current when it returned. */
export type ReapplyEligibilitySnapshot = {
    canReapply: boolean;
    reason: ReapplyUnavailableReason | null;
    /** False when the re-read failed and this is the previous answer, unchanged. */
    proven: boolean;
};

async function readEligibility(nodeId: number): Promise<OwnedEligibility> {
    try {
        const res = await apiFetch('/fleet/update-status', { localOnly: true });
        if (!res.ok) {
            // The hub could not answer, so nothing about the node is proven.
            return { nodeId, value: false, reason: null, proven: false };
        }
        const data = await res.json();
        const nodes: NodeUpdateStatus[] = Array.isArray(data?.nodes) ? data.nodes : [];
        const row = nodes.find(n => n.nodeId === nodeId);
        if (row?.canReapplyCompose !== true) {
            return { nodeId, value: false, reason: row?.reapplyUnavailableReason ?? null, proven: true };
        }
        return { nodeId, value: true, reason: null, proven: true };
    } catch (error) {
        console.warn('[Editor] Failed to load reapply eligibility:', error);
        return { nodeId, value: false, reason: null, proven: false };
    }
}

/**
 * Authoritative canReapplyCompose for the active node from /fleet/update-status.
 * Result is keyed by nodeId so a late response for a previous node cannot enable
 * Save & Reapply after the operator switches nodes. Derived canReapply is only
 * true when the owned result's nodeId matches the current activeNodeId.
 *
 * `refresh()` re-reads eligibility for the node that is active NOW, so an editor
 * left open while a node recovered or lost eligibility (a retried self-update
 * detection, a restored or dropped connection, a missing Compose CLI) decides on
 * a fresh answer at the next click instead of a stale one. It never moves the
 * answer across nodes: a response that arrives after a switch, or after a newer
 * read, is dropped.
 */
export function useActiveNodeReapplyEligibility(activeNodeId: number | null | undefined) {
    const [owned, setOwned] = useState<OwnedEligibility | null>(null);
    const generationRef = useRef(0);
    const activeNodeIdRef = useRef<number | null>(activeNodeId ?? null);
    const ownedRef = useRef<OwnedEligibility | null>(null);

    useEffect(() => {
        activeNodeIdRef.current = activeNodeId ?? null;
    }, [activeNodeId]);

    useEffect(() => {
        ownedRef.current = owned;
    }, [owned]);

    useEffect(() => {
        if (activeNodeId == null) {
            generationRef.current += 1;
            setOwned(null);
            return;
        }

        const generation = ++generationRef.current;
        let cancelled = false;

        (async () => {
            const result = await readEligibility(activeNodeId);
            if (cancelled || generation !== generationRef.current) return;
            setOwned(result);
        })();

        return () => {
            cancelled = true;
        };
    }, [activeNodeId]);

    // Resolves null when this read is dropped (a newer read or a node change),
    // so a caller must not continue with a cached answer.
    const refresh = useCallback(async (): Promise<ReapplyEligibilitySnapshot | null> => {
        const nodeId = activeNodeIdRef.current;
        if (nodeId == null) return null;
        const generation = ++generationRef.current;
        const result = await readEligibility(nodeId);
        if (generation !== generationRef.current) return null;
        if (activeNodeIdRef.current !== nodeId) return null;
        if (!result.proven) {
            // A failed re-read says nothing about the node: keep what this node
            // was last known to be instead of turning a blip into "ineligible".
            // The reapply route is the authority and names any real refusal.
            const previous = ownedRef.current?.nodeId === nodeId ? ownedRef.current : null;
            return { canReapply: previous?.value === true, reason: previous?.reason ?? null, proven: false };
        }
        setOwned(result);
        return { canReapply: result.value, reason: result.reason, proven: true };
    }, []);

    // Synchronous ownership check: after a node switch, a stale owned row for the
    // previous node must not enable reapply on the new active node.
    const ownsActiveNode = activeNodeId != null && owned !== null && owned.nodeId === activeNodeId;
    const canReapply = ownsActiveNode && owned.value === true;

    return {
        canReapply,
        owned,
        reason: ownsActiveNode && owned.value === false ? owned.reason : null,
        refresh,
    };
}
