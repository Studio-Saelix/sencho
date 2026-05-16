import type { LabelColor } from '../label-types';

export interface FleetNodeStats {
    active: number;
    managed: number;
    unmanaged: number;
    exited: number;
    total: number;
}

export interface FleetNodeSystemStats {
    cpu: { usage: string; cores: number };
    memory: { total: number; used: number; free: number; usagePercent: string };
    disk: { total: number; used: number; free: number; usagePercent: string } | null;
}

export interface FleetNode {
    id: number;
    name: string;
    type: 'local' | 'remote';
    mode?: string;
    status: 'online' | 'offline' | 'unknown';
    stats: FleetNodeStats | null;
    systemStats: FleetNodeSystemStats | null;
    stacks: string[] | null;
    cordoned: boolean;
    cordoned_at: number | null;
    cordoned_reason: string | null;
    latency_ms?: number;
    last_successful_contact?: number | null;
    pilot_last_seen?: number | null;
}

export interface NodeUpdateStatus {
    nodeId: number;
    name: string;
    type: 'local' | 'remote';
    version: string | null;
    latestVersion: string | null;
    updateAvailable: boolean;
    updateStatus: 'updating' | 'completed' | 'timeout' | 'failed' | null;
    error?: string | null;
}

export type ViewMode = 'grid' | 'topology';
export type SortField = 'name' | 'cpu' | 'memory' | 'containers' | 'status';
export type SortDir = 'asc' | 'desc';
export type FilterStatus = 'all' | 'online' | 'offline';
export type FilterType = 'all' | 'local' | 'remote';

export interface FleetPreferences {
    sortBy: SortField;
    sortDir: SortDir;
    filterStatus: FilterStatus;
    filterType: FilterType;
    filterCritical: boolean;
}

export interface FleetPaletteEntry {
    key: string;
    name: string;
    color: LabelColor;
}
