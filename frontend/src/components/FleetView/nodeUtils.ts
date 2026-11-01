import type { FleetNode } from './types';

// A null reading means the node cannot measure that dimension without leaking
// the outer machine's numbers (Sencho or a Pilot agent inside an LXC with no
// cgroup mount). It is not zero: callers must render it as unknown and leave
// it out of aggregates, never count it as an idle node.

/** Host CPU usage percent, or null when the node reports unknown. */
export function getNodeCpuUsage(node: FleetNode): number | null {
    if (!node.systemStats) return null;
    const raw = node.systemStats.cpu.usage;
    if (raw === null) return null;
    const value = parseFloat(raw);
    return Number.isFinite(value) ? value : null;
}

/** Host memory usage percent (balloon-adjusted when present), or null when unknown. */
export function getNodeMemUsage(node: FleetNode): number | null {
    const mem = node.systemStats?.memory;
    if (!mem) return null;
    const raw = mem.effectiveUsagePercent ?? mem.usagePercent;
    if (raw === null) return null;
    const value = parseFloat(raw);
    return Number.isFinite(value) ? value : null;
}

/** Effective memory in use, or null when unknown. */
export function getNodeMemUsed(node: FleetNode): number | null {
    const mem = node.systemStats?.memory;
    if (!mem) return null;
    return mem.effectiveUsed ?? mem.used ?? null;
}

/** Total memory the Docker host reports, or null when the node has no sample. */
export function getNodeMemTotal(node: FleetNode): number | null {
    const mem = node.systemStats?.memory;
    if (!mem) return null;
    return mem.effectiveTotal ?? mem.total;
}

/** Sort/threshold rank for CPU: unknown counts as zero, never as a breach. */
export function getNodeCpu(node: FleetNode): number {
    return getNodeCpuUsage(node) ?? 0;
}

/** Sort/threshold rank for memory: unknown counts as zero, never as a breach. */
export function getNodeMem(node: FleetNode): number {
    return getNodeMemUsage(node) ?? 0;
}

export function getNodeDisk(node: FleetNode): number {
    return node.systemStats?.disk ? parseFloat(node.systemStats.disk.usagePercent) : 0;
}

export function isCritical(node: FleetNode): boolean {
    return getNodeCpu(node) > 90 || getNodeDisk(node) > 90;
}

/** Sort rank for attention-first ordering: offline, then critical, then the rest. */
export function attentionRank(node: FleetNode): number {
    if (node.status !== 'online') return 0;
    return isCritical(node) ? 1 : 2;
}
