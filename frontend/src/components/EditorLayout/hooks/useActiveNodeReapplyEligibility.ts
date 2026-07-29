import { useState, useEffect, useRef } from 'react';
import { apiFetch } from '@/lib/api';
import type { NodeUpdateStatus } from '@/components/FleetView/types';

type OwnedEligibility = { nodeId: number; value: boolean };

/**
 * Authoritative canReapplyCompose for the active node from /fleet/update-status.
 * Result is keyed by nodeId so a late response for a previous node cannot enable
 * Save & Reapply after the operator switches nodes. Derived canReapply is only
 * true when the owned result's nodeId matches the current activeNodeId.
 */
export function useActiveNodeReapplyEligibility(activeNodeId: number | null | undefined) {
    const [owned, setOwned] = useState<OwnedEligibility | null>(null);
    const generationRef = useRef(0);

    useEffect(() => {
        if (activeNodeId == null) {
            generationRef.current += 1;
            setOwned(null);
            return;
        }

        const generation = ++generationRef.current;
        let cancelled = false;

        (async () => {
            try {
                const res = await apiFetch('/fleet/update-status', { localOnly: true });
                if (cancelled || generation !== generationRef.current) return;
                if (!res.ok) {
                    setOwned({ nodeId: activeNodeId, value: false });
                    return;
                }
                const data = await res.json();
                if (cancelled || generation !== generationRef.current) return;
                const nodes: NodeUpdateStatus[] = data.nodes ?? [];
                const row = nodes.find(n => n.nodeId === activeNodeId);
                setOwned({
                    nodeId: activeNodeId,
                    value: row?.canReapplyCompose === true,
                });
            } catch (error) {
                if (cancelled || generation !== generationRef.current) return;
                console.warn('[Editor] Failed to load reapply eligibility:', error);
                setOwned({ nodeId: activeNodeId, value: false });
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [activeNodeId]);

    // Synchronous ownership check: after a node switch, a stale owned row for the
    // previous node must not enable reapply on the new active node.
    const canReapply =
        activeNodeId != null
        && owned !== null
        && owned.nodeId === activeNodeId
        && owned.value === true;

    return { canReapply, owned };
}
