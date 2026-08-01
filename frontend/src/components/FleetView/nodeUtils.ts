import type { FleetNode } from './types';

export function getNodeCpu(node: FleetNode): number {
    return node.systemStats ? parseFloat(node.systemStats.cpu.usage) : 0;
}

export function getNodeMem(node: FleetNode): number {
    if (!node.systemStats) return 0;
    const eff = node.systemStats.memory.effectiveUsagePercent;
    return parseFloat(eff ?? node.systemStats.memory.usagePercent);
}

export function getNodeMemUsed(node: FleetNode): number {
    const mem = node.systemStats?.memory;
    return mem?.effectiveUsed ?? mem?.used ?? 0;
}

export function getNodeMemTotal(node: FleetNode): number {
    const mem = node.systemStats?.memory;
    return mem?.effectiveTotal ?? mem?.total ?? 0;
}

export function getNodeDisk(node: FleetNode): number {
    return node.systemStats?.disk ? parseFloat(node.systemStats.disk.usagePercent) : 0;
}

export function isCritical(node: FleetNode): boolean {
    return getNodeCpu(node) > 90 || getNodeDisk(node) > 90;
}
