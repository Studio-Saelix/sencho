import { useState, useCallback, useMemo, useRef } from 'react';
import { apiFetch } from '@/lib/api';
import { useFleetLabels, labelPaletteKey } from './useFleetLabels';
import { useNodeLabels } from './useNodeLabels';
import { isCritical, getNodeCpu, getNodeMem, getNodeDisk } from '../nodeUtils';
import type { FleetNode, ViewMode, FleetPreferences, NodeUpdateStatus } from '../types';

interface MastheadStats {
    nodeCount: number;
    onlineCount: number;
    criticalCount: number;
    totalContainers: number;
    totalContainersAll: number;
    avgCpuNum: number;
    worstCpu: { name: string; percent: number } | null;
    totalMemUsed: number;
    totalMemTotal: number;
}

interface UseFleetOverviewOptions {
    isPaid: boolean;
    prefs: FleetPreferences;
    updatePrefs: (updates: Partial<FleetPreferences>) => void;
    updateStatuses: NodeUpdateStatus[];
}

export function useFleetOverview({ isPaid, prefs, updatePrefs, updateStatuses }: UseFleetOverviewOptions) {
    const [nodes, setNodes] = useState<FleetNode[]>([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
    const [viewMode, setViewMode] = useState<ViewMode>('grid');
    const [labelFilters, setLabelFilters] = useState<Set<string>>(new Set());
    const abortRef = useRef<AbortController | null>(null);

    const { fleetPalette, fleetStackLabelMap } = useFleetLabels({ nodes });
    const { labelsByNodeId, distinctLabels, isAvailable: nodeLabelsAvailable } = useNodeLabels({ isPaid, nodes });

    const fetchOverview = useCallback(async (showRefresh = false) => {
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;

        if (showRefresh) setRefreshing(true);
        try {
            const res = await apiFetch('/fleet/overview', { localOnly: true, signal: controller.signal });
            if (res.ok) {
                setNodes(await res.json());
                setLastSyncAt(Date.now());
            }
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') return;
            console.error('Failed to fetch fleet overview:', error);
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    }, []);

    const onlineNodes = useMemo(() => nodes.filter(n => n.status === 'online'), [nodes]);

    const mastheadStats = useMemo((): MastheadStats => {
        const onlineCount = onlineNodes.length;
        const criticalCount = onlineNodes.filter(isCritical).length;
        const totalContainers = nodes.reduce((sum, n) => sum + (n.stats?.active ?? 0), 0);
        const totalContainersAll = nodes.reduce((sum, n) => sum + (n.stats?.total ?? 0), 0);
        const avgCpuNum = onlineNodes.length > 0
            ? onlineNodes.reduce((sum, n) => sum + getNodeCpu(n), 0) / onlineNodes.length
            : 0;
        const worstCpuNode = onlineNodes.length > 0
            ? onlineNodes.reduce((worst, n) => getNodeCpu(n) > getNodeCpu(worst) ? n : worst, onlineNodes[0])
            : null;
        const worstCpu = worstCpuNode
            ? { name: worstCpuNode.name, percent: getNodeCpu(worstCpuNode) }
            : null;
        const totalMemUsed = onlineNodes.reduce((sum, n) => sum + (n.systemStats?.memory.used ?? 0), 0);
        const totalMemTotal = onlineNodes.reduce((sum, n) => sum + (n.systemStats?.memory.total ?? 0), 0);
        return {
            nodeCount: nodes.length,
            onlineCount,
            criticalCount,
            totalContainers,
            totalContainersAll,
            avgCpuNum,
            worstCpu,
            totalMemUsed,
            totalMemTotal,
        };
    }, [nodes, onlineNodes]);

    const updateStatusMap = useMemo(
        () => new Map(updateStatuses.map(s => [s.nodeId, s])),
        [updateStatuses]
    );

    const processedNodes = useMemo(() => {
        let filtered = [...nodes];

        if (searchQuery.trim()) {
            const q = searchQuery.toLowerCase();
            filtered = filtered.filter(n =>
                n.name.toLowerCase().includes(q) ||
                n.stacks?.some(s => s.toLowerCase().includes(q))
            );
        }

        if (prefs.filterStatus === 'online') filtered = filtered.filter(n => n.status === 'online');
        if (prefs.filterStatus === 'offline') filtered = filtered.filter(n => n.status !== 'online');
        if (prefs.filterType === 'local') filtered = filtered.filter(n => n.type === 'local');
        if (prefs.filterType === 'remote') filtered = filtered.filter(n => n.type !== 'local');
        if (prefs.filterCritical) filtered = filtered.filter(isCritical);

        if (labelFilters.size > 0) {
            filtered = filtered.filter(n => {
                const nodeStackLabels = fleetStackLabelMap[n.id] ?? {};
                return n.stacks?.some(s => {
                    const sLabels = nodeStackLabels[s] ?? [];
                    return sLabels.some(l => labelFilters.has(labelPaletteKey(l.name, l.color)));
                });
            });
        }

        filtered.sort((a, b) => {
            let cmp = 0;
            switch (prefs.sortBy) {
                case 'name':
                    cmp = a.name.localeCompare(b.name);
                    break;
                case 'cpu':
                    cmp = getNodeCpu(b) - getNodeCpu(a);
                    break;
                case 'memory':
                    cmp = getNodeMem(b) - getNodeMem(a);
                    break;
                case 'containers':
                    cmp = (b.stats?.active ?? 0) - (a.stats?.active ?? 0);
                    break;
                case 'status':
                    cmp = (a.status === 'online' ? 0 : 1) - (b.status === 'online' ? 0 : 1);
                    break;
            }
            return prefs.sortDir === 'desc' ? -cmp : cmp;
        });

        return filtered;
    }, [nodes, searchQuery, prefs, labelFilters, fleetStackLabelMap]);

    const localNode = useMemo(
        () => processedNodes.find(n => n.type === 'local') ?? null,
        [processedNodes]
    );
    const remoteNodes = useMemo(
        () => processedNodes.filter(n => n.type !== 'local'),
        [processedNodes]
    );
    const topologyNodes = useMemo(
        () => processedNodes.map(n => ({
            id: n.id,
            name: n.name,
            type: n.type,
            status: n.status,
            cpuPercent: getNodeCpu(n),
            memPercent: getNodeMem(n),
            diskPercent: getNodeDisk(n),
            stackCount: n.stacks?.length ?? 0,
            runningCount: n.stats?.active ?? 0,
            critical: n.status === 'online' && isCritical(n),
            labels: labelsByNodeId[n.id] ?? [],
            cordoned: n.cordoned,
            cordonedReason: n.cordoned_reason,
            latencyMs: n.latency_ms ?? null,
            pilotLastSeen: n.pilot_last_seen ?? null,
            nodeMode: n.mode ?? null,
        })),
        [processedNodes, labelsByNodeId]
    );
    const allNodes = useMemo(
        () => (localNode ? [localNode, ...remoteNodes] : remoteNodes),
        [localNode, remoteNodes]
    );

    const activeFilterCount = useMemo(() => {
        let count = 0;
        if (prefs.filterStatus !== 'all') count++;
        if (prefs.filterType !== 'all') count++;
        if (prefs.filterCritical) count++;
        count += labelFilters.size;
        return count;
    }, [prefs, labelFilters]);

    const clearFilters = useCallback(() => {
        updatePrefs({ filterStatus: 'all', filterType: 'all', filterCritical: false });
        setLabelFilters(new Set());
    }, [updatePrefs]);

    return {
        nodes,
        loading,
        refreshing,
        searchQuery,
        setSearchQuery,
        lastSyncAt,
        viewMode,
        setViewMode,
        labelFilters,
        setLabelFilters,
        fetchOverview,
        processedNodes,
        localNode,
        remoteNodes,
        topologyNodes,
        allNodes,
        mastheadStats,
        updateStatusMap,
        fleetPalette,
        fleetStackLabelMap,
        labelsByNodeId,
        distinctNodeLabels: distinctLabels,
        nodeLabelsAvailable,
        activeFilterCount,
        clearFilters,
    };
}
