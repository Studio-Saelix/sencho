import type { MeshNodeStatus } from '@/types/mesh';
import type { RoutingNodeState } from '@/components/ui/routing-node-card';

/**
 * Classify a node's mesh status into the card's visual state. The notable
 * distinction: a proxy peer's reverse bridge mid-dial is the expected transient
 * right after enable (`connecting`), not a fault. Only a bridge that is fully
 * unavailable (no dial in flight) is `degraded`.
 */
export function deriveNodeState(status: MeshNodeStatus): RoutingNodeState {
    if (status.reachableMode === 'unreachable') return 'offline';
    if (!status.enabled) return 'idle';
    if (status.reachableMode === 'pilot' && !status.pilotConnected) return 'degraded';
    if (status.reverseCallbackStatus === 'connecting') return 'connecting';
    if (status.reverseCallbackStatus === 'unavailable') return 'degraded';
    return 'meshed';
}
