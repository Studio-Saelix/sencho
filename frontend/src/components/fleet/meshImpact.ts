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
    /** False when the node holding `direct` is one the cascade cannot reach, so those stacks do not restart now. */
    directReachable: boolean;
    /**
     * Whether the change adds or removes a hostname. Every meshed stack
     * carries the full alias set in its `extra_hosts`, so `others` are only
     * recreated when that set changes. A removed stack that publishes
     * nothing right now (stopped) leaves every other stack's hostnames, and
     * so its container, untouched.
     */
    hostnamesChange: boolean;
    /** Other meshed stacks restarted so their hostnames refresh. */
    others: Array<{ nodeName: string; stackName: string }>;
    /** Other meshed stacks that are not currently running, so the cascade starts them (a deploy brings up anything stopped, whether or not hostnames change). */
    started: Array<{ nodeName: string; stackName: string }>;
    /** Other meshed stacks on nodes the cascade cannot reach, so nothing restarts there. */
    skipped: Array<{ nodeName: string; stackName: string }>;
}

/**
 * Whether the fleet-wide cascade can reach a node at all.
 *
 * A pilot node with no open tunnel and a proxy node whose dial failed both
 * report a live mesh membership, but the per-stack redeploy is a cross-node
 * call that cannot land there. Counting their stacks as "also restart" would
 * promise restarts that never happen.
 */
export function isMeshCascadeReachable(node: MeshNodeStatus): boolean {
    if (node.reachableMode === 'local' || node.reachableMode === 'proxy') return true;
    return node.reachableMode === 'pilot' && node.pilotConnected;
}

export function computeMeshMembershipImpact(
    status: MeshNodeStatus[],
    change: MeshMembershipChange,
): MeshMembershipImpact {
    const direct: MeshMembershipImpact['direct'] = [];
    const others: MeshMembershipImpact['others'] = [];
    const started: MeshMembershipImpact['started'] = [];
    const skipped: MeshMembershipImpact['skipped'] = [];
    const targetNode = status.find((n) => n.nodeId === change.nodeId);
    const directReachable = targetNode ? isMeshCascadeReachable(targetNode) : true;
    const publishes = (stackName: string): boolean =>
        targetNode?.optedInStacks.find((s) => s.stackName === stackName)?.currentlyResolvable ?? true;
    const hostnamesChange = change.kind === 'opt-in'
        ? true
        : change.kind === 'opt-out'
            ? publishes(change.stackName)
            : (targetNode?.optedInStacks.some((s) => s.currentlyResolvable) ?? false);
    if (change.kind !== 'disable-node') {
        direct.push({ nodeName: targetNode?.nodeName ?? `node ${change.nodeId}`, stackName: change.stackName });
    }
    for (const node of status) {
        const reachable = isMeshCascadeReachable(node);
        for (const s of node.optedInStacks) {
            const isTarget = node.nodeId === change.nodeId
                && (change.kind === 'disable-node' || s.stackName === change.stackName);
            if (isTarget) {
                if (change.kind === 'disable-node') direct.push({ nodeName: node.nodeName, stackName: s.stackName });
                continue;
            }
            if (!reachable) {
                skipped.push({ nodeName: node.nodeName, stackName: s.stackName });
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
    return { direct, directReachable, hostnamesChange, others, started, skipped };
}

/**
 * Whether a membership change does anything an operator should confirm: a
 * stack restarts or starts. A turn-off that restarts nothing (no stack of
 * this node is meshed, and no other stack is stopped) goes straight through.
 */
export function meshChangeNeedsConfirmation(impact: MeshMembershipImpact): boolean {
    return impact.direct.length > 0
        || (impact.hostnamesChange && impact.others.length > 0)
        || impact.started.length > 0;
}

function joinNames(names: string[]): string {
    if (names.length <= 1) return names.join('');
    return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** "pg and redis on home; app on vps": every stack named, grouped by node. */
function describeStacks(items: Array<{ nodeName: string; stackName: string }>): string {
    const byNode = new Map<string, string[]>();
    for (const item of items) byNode.set(item.nodeName, [...(byNode.get(item.nodeName) ?? []), item.stackName]);
    return Array.from(byNode, ([nodeName, names]) => `${joinNames(names)} on ${nodeName}`).join('; ');
}

/**
 * One to four plain sentences for the confirmation dialog, naming every
 * stack involved, e.g. "api on opsix restarts now. db on opsix and web on
 * home also restart to refresh hostnames, so expect brief connection drops."
 */
export function describeMeshMembershipImpact(impact: MeshMembershipImpact, change: MeshMembershipChange): string {
    const directNames = joinNames(impact.direct.map((d) => d.stackName));
    const directCount = impact.direct.length;
    const parts: string[] = [];
    if (change.kind === 'disable-node') {
        if (directCount === 0) parts.push('No stacks on this node are in the mesh.');
        else if (impact.directReachable) {
            parts.push(`${directNames} on this node ${directCount === 1 ? 'leaves' : 'leave'} the mesh and ${directCount === 1 ? 'restarts' : 'restart'}.`);
        } else {
            parts.push(`${directNames} on this node ${directCount === 1 ? 'leaves' : 'leave'} the mesh but ${directCount === 1 ? 'is' : 'are'} not restarted, because that node is unreachable.`);
        }
    } else {
        const { stackName, nodeName } = impact.direct[0];
        parts.push(impact.directReachable
            ? `${stackName} on ${nodeName} restarts now.`
            : `${stackName} on ${nodeName} is not restarted, because that node is unreachable.`);
    }
    if (impact.others.length > 0) {
        parts.push(impact.hostnamesChange
            ? `${describeStacks(impact.others)} also ${impact.others.length === 1 ? 'restarts' : 'restart'} to refresh hostnames, so expect brief connection drops.`
            : 'No hostnames change, so no other meshed stack needs a restart.');
        if (impact.started.length > 0) {
            parts.push(
                `${describeStacks(impact.started)} ${impact.started.length === 1 ? 'is' : 'are'} not running right now,`
                + ` and the redeploy brings ${impact.started.length === 1 ? 'it' : 'them'} up.`,
            );
        }
    } else if (impact.skipped.length === 0) {
        parts.push('No other meshed stacks are affected.');
    }
    if (impact.skipped.length > 0) {
        const nodeCount = new Set(impact.skipped.map((s) => s.nodeName)).size;
        parts.push(
            `${describeStacks(impact.skipped)} ${impact.skipped.length === 1 ? 'is' : 'are'} skipped, because`
            + ` ${nodeCount === 1 ? 'that node is' : 'those nodes are'} unreachable.`,
        );
    }
    return parts.join(' ');
}
