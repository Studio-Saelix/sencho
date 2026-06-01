import { useState, useEffect, useCallback, useMemo } from 'react';
import { fetchForNode } from '@/lib/api';
import type { FleetNode, FleetPaletteEntry } from '../types';
import type { Label as StackLabel, LabelColor } from '../../label-types';

export function labelPaletteKey(name: string, color: LabelColor): string {
    return `${name.trim().toLowerCase()}|${color}`;
}

interface UseFleetLabelsOptions {
    nodes: FleetNode[];
}

// Stack labels are a Community feature (the per-node `/labels` and
// `/labels/assignments` reads are open to any authenticated user), so the
// fleet-wide palette and per-stack chips render on every tier. Node-level tag
// aggregation stays paid and lives in useNodeLabels.
export function useFleetLabels({ nodes }: UseFleetLabelsOptions) {
    const [fleetPalette, setFleetPalette] = useState<FleetPaletteEntry[]>([]);
    const [fleetStackLabelMap, setFleetStackLabelMap] = useState<Record<number, Record<string, StackLabel[]>>>({});

    const fetchLabelsForNodes = useCallback(async (fleetNodes: FleetNode[]) => {
        if (fleetNodes.length === 0) return;

        const paletteMap = new Map<string, FleetPaletteEntry>();
        const stackLabelMap: Record<number, Record<string, StackLabel[]>> = {};

        await Promise.allSettled(fleetNodes.map(async (node) => {
            if (node.status !== 'online') return;
            try {
                const [labelsRes, assignmentsRes] = await Promise.all([
                    fetchForNode('/labels', node.id, { signal: AbortSignal.timeout(5000) }),
                    fetchForNode('/labels/assignments', node.id, { signal: AbortSignal.timeout(5000) }),
                ]);
                if (labelsRes.ok) {
                    const labels = await labelsRes.json() as StackLabel[];
                    for (const l of labels) {
                        const key = labelPaletteKey(l.name, l.color);
                        if (!paletteMap.has(key)) {
                            paletteMap.set(key, { key, name: l.name, color: l.color });
                        }
                    }
                }
                if (assignmentsRes.ok) {
                    stackLabelMap[node.id] = await assignmentsRes.json() as Record<string, StackLabel[]>;
                }
            } catch {
                // Node unreachable or slow: skip, other nodes still contribute.
            }
        }));

        setFleetPalette(Array.from(paletteMap.values()).sort((a, b) => a.name.localeCompare(b.name)));
        setFleetStackLabelMap(stackLabelMap);
    }, []);

    // Refetch labels only when the set of online nodes actually changes,
    // not on every fetchOverview tick (which mints a new nodes ref).
    const onlineNodeKey = useMemo(
        () => nodes
            .filter(n => n.status === 'online')
            .map(n => n.id)
            .sort((a, b) => a - b)
            .join(','),
        [nodes]
    );

    useEffect(() => {
        if (nodes.length === 0) return;
        fetchLabelsForNodes(nodes);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [onlineNodeKey, fetchLabelsForNodes]);

    return { fleetPalette, fleetStackLabelMap };
}
