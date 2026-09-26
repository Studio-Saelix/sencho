import type { MeshNodeStatus } from '@/types/mesh';

/**
 * What a mesh membership change restarts.
 *
 * `/etc/hosts` entries are read when a container is created, so the
 * backend recreates the changed stack and then every other meshed stack in
 * the fleet so they all pick up the new alias set (the "cascade"). The
 * confirmation shows this up front so an operator is never surprised by
 * restarts on nodes they did not touch.
 */
export type MeshMembershipChange =
    | { kind: 'opt-in' | 'opt-out'; nodeId: number; stackName: string }
    | { kind: 'disable-node'; nodeId: number };

export interface MeshMembershipImpact {
    /** Stacks changed directly by this action. */
    direct: Array<{ nodeName: string; stackName: string }>;
    /** Other meshed stacks restarted so their hostnames refresh. */
    others: Array<{ nodeName: string; stackName: string }>;
    /** Other meshed stacks that are not currently running, so the cascade starts them. */
    started: Array<{ nodeName: string; stackName: string }>;
    /** Number of distinct nodes among `others`. */
    otherNodeCount: number;
}

export function computeMeshMembershipImpact(
    status: MeshNodeStatus[],
    change: MeshMembershipChange,
): MeshMembershipImpact {
    const direct: MeshMembershipImpact['direct'] = [];
    const others: MeshMembershipImpact['others'] = [];
    const started: MeshMembershipImpact['started'] = [];
    const targetNode = status.find((n) => n.nodeId === change.nodeId);
    if (change.kind !== 'disable-node') {
        direct.push({ nodeName: targetNode?.nodeName ?? `node ${change.nodeId}`, stackName: change.stackName });
    }
    for (const node of status) {
        for (const s of node.optedInStacks) {
            const isTarget = node.nodeId === change.nodeId
                && (change.kind === 'disable-node' || s.stackName === change.stackName);
            if (isTarget) {
                if (change.kind === 'disable-node') direct.push({ nodeName: node.nodeName, stackName: s.stackName });
                continue;
            }
            others.push({ nodeName: node.nodeName, stackName: s.stackName });
            // The cascade deploys every meshed stack, and a deploy brings up
            // anything that is not running. A stopped stack that the operator
            // meant to leave stopped has to be named, not folded into the
            // restart count.
            if (!s.currentlyResolvable) started.push({ nodeName: node.nodeName, stackName: s.stackName });
        }
    }
    return { direct, others, started, otherNodeCount: new Set(others.map((o) => o.nodeName)).size };
}

function plural(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
}

/**
 * One or two plain sentences for the confirmation dialog, e.g.
 * "api on opsix restarts now. 6 other meshed stacks on 3 nodes also
 * restart to refresh their hostnames, so expect brief connection drops."
 */
export function describeMeshMembershipImpact(impact: MeshMembershipImpact, change: MeshMembershipChange): string {
    const first = change.kind === 'disable-node'
        ? (impact.direct.length === 0
            ? 'No stacks on this node are in the mesh.'
            : impact.direct.length === 1
                ? '1 meshed stack on this node leaves the mesh and restarts.'
                : `${impact.direct.length} meshed stacks on this node leave the mesh and restart.`)
        : `${impact.direct[0].stackName} on ${impact.direct[0].nodeName} restarts now.`;
    if (impact.others.length === 0) {
        return `${first} No other meshed stacks are affected.`;
    }
    const verb = impact.others.length === 1 ? 'restarts' : 'restart';
    const cascade = `${first} ${plural(impact.others.length, 'other meshed stack', 'other meshed stacks')} on ${plural(impact.otherNodeCount, 'node', 'nodes')} also ${verb} to refresh their hostnames, so expect brief connection drops.`;
    if (impact.started.length === 0) return cascade;
    return `${cascade} ${plural(impact.started.length, 'of those is', 'of those are')} not running right now, and that deploy brings ${impact.started.length === 1 ? 'it' : 'them'} up.`;
}
