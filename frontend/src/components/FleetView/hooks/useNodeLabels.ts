import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { FleetNode } from '../types';

export interface UseNodeLabelsResult {
    labelsByNodeId: Record<number, string[]>;
    distinctLabels: string[];
    isAvailable: boolean;
}

interface UseNodeLabelsOptions {
    isPaid: boolean;
    nodes: FleetNode[];
}

export function useNodeLabels({ isPaid, nodes }: UseNodeLabelsOptions): UseNodeLabelsResult {
    const [labelsByNodeId, setLabelsByNodeId] = useState<Record<number, string[]>>({});

    const fetchLabels = useCallback(async () => {
        if (!isPaid) {
            setLabelsByNodeId({});
            return;
        }
        try {
            const res = await apiFetch('/node-labels', {
                localOnly: true,
                signal: AbortSignal.timeout(5000),
            });
            if (!res.ok) {
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
        } catch {
            setLabelsByNodeId({});
        }
    }, [isPaid]);

    // Refetch only when the set of node ids actually changes, not on every poll
    // (poll mints a fresh nodes array reference).
    const nodeIdKey = useMemo(
        () => nodes.map(n => n.id).sort((a, b) => a - b).join(','),
        [nodes],
    );

    useEffect(() => {
        if (!isPaid) {
            setLabelsByNodeId({});
            return;
        }
        void fetchLabels();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isPaid, nodeIdKey, fetchLabels]);

    const distinctLabels = useMemo(() => {
        const set = new Set<string>();
        for (const list of Object.values(labelsByNodeId)) {
            for (const l of list) set.add(l);
        }
        return Array.from(set).sort((a, b) => a.localeCompare(b));
    }, [labelsByNodeId]);

    return { labelsByNodeId, distinctLabels, isAvailable: isPaid };
}
