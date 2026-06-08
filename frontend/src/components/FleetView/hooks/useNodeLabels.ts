import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { FleetNode } from '../types';

export interface UseNodeLabelsResult {
    labelsByNodeId: Record<number, string[]>;
    distinctLabels: string[];
}

interface UseNodeLabelsOptions {
    nodes: FleetNode[];
}

export function useNodeLabels({ nodes }: UseNodeLabelsOptions): UseNodeLabelsResult {
    const [labelsByNodeId, setLabelsByNodeId] = useState<Record<number, string[]>>({});

    const fetchLabels = useCallback(async () => {
        try {
            const res = await apiFetch('/node-labels', {
                localOnly: true,
                signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) {
                console.error(`[useNodeLabels] node-label fetch failed: ${res.status}`);
                setLabelsByNodeId({});
                return;
            }
            const data = await res.json() as Record<string, string[]>;
            // Backend returns numeric keys as strings in JSON; normalize.
            const map: Record<number, string[]> = {};
            for (const [k, v] of Object.entries(data)) {
                const id = Number(k);
                if (!Number.isNaN(id) && Array.isArray(v)) map[id] = v;
            }
            setLabelsByNodeId(map);
        } catch (err) {
            console.error('[useNodeLabels] node-label fetch errored:', err);
            setLabelsByNodeId({});
        }
    }, []);

    // Refetch only when the set of node ids actually changes, not on every poll
    // (poll mints a fresh nodes array reference).
    const nodeIdKey = useMemo(
        () => nodes.map(n => n.id).sort((a, b) => a - b).join(','),
        [nodes],
    );

    useEffect(() => {
        void fetchLabels();
    }, [nodeIdKey, fetchLabels]);

    const distinctLabels = useMemo(() => {
        const set = new Set<string>();
        for (const list of Object.values(labelsByNodeId)) {
            for (const l of list) set.add(l);
        }
        return Array.from(set).sort((a, b) => a.localeCompare(b));
    }, [labelsByNodeId]);

    return { labelsByNodeId, distinctLabels };
}
