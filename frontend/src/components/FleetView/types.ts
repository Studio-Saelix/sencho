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
    memory: {
        total: number;
        used: number;
        free: number;
        usagePercent: string;
        arcReclaimable?: number;
        ballooned?: number;
        effectiveTotal?: number;
        effectiveUsed?: number;
        effectiveFree?: number;
        effectiveUsagePercent?: string;
        balloonSource?: string;
    };
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

export type ImagePinKind = 'floating' | 'semver' | 'digest' | 'unknown';

/** Shown when the backend omits a node-specific block reason. */
export const PINNED_UPDATE_BLOCKED_FALLBACK =
    'This node cannot be updated automatically while its image is pinned this way.';

export interface NodeUpdateStatus {
    nodeId: number;
    name: string;
    type: 'local' | 'remote';
    version: string | null;
    latestVersion: string | null;
    updateAvailable: boolean;
    updateStatus: 'updating' | 'completed' | 'timeout' | 'failed' | null;
    error?: string | null;
    skipActive?: boolean;
    skippedVersion?: string | null;
    /** How this node's Sencho image is pinned. Present for the local node and,
     *  as the safe subset, for remotes that advertise it; null/absent otherwise. */
    imagePinKind?: ImagePinKind | null;
    /** The compose-declared image ref. Local node only (authenticated route). */
    composeImageRef?: string | null;
    /** The ref a semver pin will be rewritten to. Local node only. */
    targetImageRef?: string | null;
    /** True when the pin (digest/unknown) cannot be updated automatically. */
    updateBlocked?: boolean;
    /** Human-readable block reason. Local node only. */
    updateBlockedReason?: string | null;
    /** Coarse image channel from meta/update-status. Hardened digests still POST. */
    imageChannel?: 'community' | 'hardened' | 'unknown' | null;
    /** Active fleet self-management operation, when a tracker is present. */
    operationKind?: 'update' | 'reapply_configuration' | null;
    /** True when this Compose-managed node can reapply its on-disk configuration. */
    canReapplyCompose?: boolean;
}

export type ViewMode = 'grid' | 'topology';
export type SortField = 'name' | 'cpu' | 'memory' | 'containers' | 'status';
export type SortDir = 'asc' | 'desc';
export type FilterStatus = 'all' | 'online' | 'offline';
export type FilterType = 'all' | 'local' | 'remote';
export type FilterNetworking = 'all' | 'exposed' | 'unknown' | 'drift';

export interface FleetPreferences {
    sortBy: SortField;
    sortDir: SortDir;
    filterStatus: FilterStatus;
    filterType: FilterType;
    filterCritical: boolean;
    /** Narrow to nodes that have an exposed / unknown-exposure / network-drift stack. */
    filterNetworking: FilterNetworking;
}

export interface FleetPaletteEntry {
    key: string;
    name: string;
    color: LabelColor;
}
