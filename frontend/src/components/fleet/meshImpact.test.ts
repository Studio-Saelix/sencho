import { describe, expect, it } from 'vitest';
import type { MeshNodeStatus } from '@/types/mesh';
import {
    computeMeshMembershipImpact,
    describeMeshMembershipImpact,
    isMeshCascadeReachable,
    meshChangeBlocked,
    meshChangeNeedsConfirmation,
} from './meshImpact';

function node(
    nodeId: number,
    nodeName: string,
    stacks: Array<string | { stackName: string; running: boolean }>,
    over: Partial<MeshNodeStatus> = {},
): MeshNodeStatus {
    return {
        nodeId,
        nodeName,
        enabled: true,
        localForwarderListening: null,
        pilotConnected: false,
        reachableMode: 'local',
        reachableReason: null,
        reverseCallbackStatus: 'not_applicable',
        optedInStacks: stacks.map((s) => (typeof s === 'string'
            ? { stackName: s, currentlyResolvable: true }
            : { stackName: s.stackName, currentlyResolvable: s.running })),
        activeStreamCount: 0,
        ...over,
    };
}

const fleet = [node(1, 'home', ['pg', 'redis']), node(2, 'vps', ['app']), node(3, 'edge', ['proxy'])];

describe('computeMeshMembershipImpact', () => {
    it('opt-in restarts the new stack and every already meshed stack', () => {
        const impact = computeMeshMembershipImpact(fleet, { kind: 'opt-in', nodeId: 2, stackName: 'api' });
        expect(impact.direct).toEqual([{ nodeName: 'vps', stackName: 'api' }]);
        expect(impact.others).toHaveLength(4);
    });

    it('opt-out does not count the removed stack as an other', () => {
        const impact = computeMeshMembershipImpact(fleet, { kind: 'opt-out', nodeId: 1, stackName: 'pg' });
        expect(impact.others.map((o) => o.stackName).sort()).toEqual(['app', 'proxy', 'redis']);
    });

    it('separates stacks the cascade will start from stacks it merely restarts', () => {
        // The cascade deploys every meshed stack, and a deploy brings up
        // anything stopped. A stopped stack the operator meant to leave
        // stopped has to be its own bucket, and in no other: a stack is
        // restarted or started, never both.
        const withStopped = [
            node(1, 'home', [{ stackName: 'pg', running: true }, { stackName: 'legacy', running: false }]),
            node(2, 'vps', [{ stackName: 'app', running: true }]),
        ];
        const impact = computeMeshMembershipImpact(withStopped, { kind: 'opt-in', nodeId: 2, stackName: 'api' });

        expect(impact.others.map((o) => o.stackName).sort()).toEqual(['app', 'pg']);
        expect(impact.started).toEqual([{ nodeName: 'home', stackName: 'legacy' }]);
    });

    it('disabling a node restarts its stacks and the rest of the fleet', () => {
        const impact = computeMeshMembershipImpact(fleet, { kind: 'disable-node', nodeId: 1 });
        expect(impact.direct.map((d) => d.stackName)).toEqual(['pg', 'redis']);
        expect(impact.others.map((o) => o.stackName)).toEqual(['app', 'proxy']);
    });

    it('keeps stacks the cascade cannot reach out of the restart count', () => {
        // A pilot node with no tunnel and an unreachable proxy node both hold
        // live mesh memberships, but the cross-node redeploy cannot land there.
        const status = [
            node(1, 'home', ['pg']),
            node(2, 'vps', [{ stackName: 'app', running: false }], { reachableMode: 'pilot', pilotConnected: false }),
            node(3, 'edge', ['proxy'], { reachableMode: 'unreachable', reachableReason: 'api token missing' }),
        ];
        const impact = computeMeshMembershipImpact(status, { kind: 'opt-in', nodeId: 1, stackName: 'api' });

        expect(impact.others).toEqual([{ nodeName: 'home', stackName: 'pg' }]);
        expect(impact.skipped).toEqual([
            { nodeName: 'vps', stackName: 'app' },
            { nodeName: 'edge', stackName: 'proxy' },
        ]);
        // A stopped stack on an unreachable node is skipped, never promised a start.
        expect(impact.started).toEqual([]);
    });

    it('only changes hostnames when the stack leaving the mesh publishes some', () => {
        const status = [
            node(1, 'home', [{ stackName: 'pg', running: true }, { stackName: 'legacy', running: false }]),
            node(2, 'vps', ['app']),
        ];
        expect(computeMeshMembershipImpact(status, { kind: 'opt-in', nodeId: 2, stackName: 'api' }).hostnamesChange).toBe(true);
        expect(computeMeshMembershipImpact(status, { kind: 'opt-out', nodeId: 1, stackName: 'pg' }).hostnamesChange).toBe(true);
        expect(computeMeshMembershipImpact(status, { kind: 'opt-out', nodeId: 1, stackName: 'legacy' }).hostnamesChange).toBe(false);
        expect(computeMeshMembershipImpact(status, { kind: 'disable-node', nodeId: 1 }).hostnamesChange).toBe(true);
        expect(computeMeshMembershipImpact([...status, node(3, 'edge', [])], { kind: 'disable-node', nodeId: 3 }).hostnamesChange).toBe(false);
        expect(computeMeshMembershipImpact([node(1, 'home', [{ stackName: 'legacy', running: false }]), node(2, 'vps', ['app'])],
            { kind: 'disable-node', nodeId: 1 }).hostnamesChange).toBe(false);
    });

    it('marks the changed stacks unreachable when their own node is', () => {
        const status = [node(1, 'home', ['pg']), node(2, 'vps', ['app'], { reachableMode: 'pilot', pilotConnected: false })];
        expect(computeMeshMembershipImpact(status, { kind: 'opt-out', nodeId: 2, stackName: 'app' }).directReachable).toBe(false);
        expect(computeMeshMembershipImpact(status, { kind: 'opt-out', nodeId: 1, stackName: 'pg' }).directReachable).toBe(true);
    });

    it('treats a pilot node with an open tunnel as reachable', () => {
        const status = [node(2, 'vps', ['app'], { reachableMode: 'pilot', pilotConnected: true })];
        expect(computeMeshMembershipImpact(status, { kind: 'opt-in', nodeId: 1, stackName: 'api' }).skipped).toEqual([]);
    });
});

describe('isMeshCascadeReachable', () => {
    it('is reachable for the local node and a proxy peer', () => {
        expect(isMeshCascadeReachable(node(1, 'home', []))).toBe(true);
        expect(isMeshCascadeReachable(node(2, 'vps', [], { reachableMode: 'proxy' }))).toBe(true);
    });

    it('needs an open tunnel for a pilot node', () => {
        expect(isMeshCascadeReachable(node(2, 'vps', [], { reachableMode: 'pilot', pilotConnected: true }))).toBe(true);
        expect(isMeshCascadeReachable(node(2, 'vps', [], { reachableMode: 'pilot', pilotConnected: false }))).toBe(false);
    });

    it('is unreachable when the node reports unreachable', () => {
        expect(isMeshCascadeReachable(node(3, 'edge', [], { reachableMode: 'unreachable' }))).toBe(false);
    });
});

describe('describeMeshMembershipImpact', () => {
    it('names the stack, node and fleet-wide restarts', () => {
        const change = { kind: 'opt-in' as const, nodeId: 2, stackName: 'api' };
        expect(describeMeshMembershipImpact(computeMeshMembershipImpact(fleet, change), change))
            .toBe('api on vps restarts now. pg and redis on home; app on vps; proxy on edge also restart to refresh hostnames, so expect brief connection drops.');
    });

    it('says when nothing else is affected', () => {
        const change = { kind: 'opt-in' as const, nodeId: 1, stackName: 'pg' };
        expect(describeMeshMembershipImpact(computeMeshMembershipImpact([node(1, 'home', [])], change), change))
            .toBe('pg on home restarts now. No other meshed stacks are affected.');
    });

    it('says a stopped stack will be brought up', () => {
        const change = { kind: 'opt-in' as const, nodeId: 2, stackName: 'api' };
        const status = [
            node(1, 'home', [{ stackName: 'pg', running: true }, { stackName: 'legacy', running: false }]),
            node(2, 'vps', ['app']),
        ];
        expect(describeMeshMembershipImpact(computeMeshMembershipImpact(status, change), change))
            .toBe('api on vps restarts now. pg on home; app on vps also restart to refresh hostnames, so expect brief connection drops. legacy on home is not running right now, and the redeploy brings it up.');
    });

    it('does not mention starting anything when every other stack is running', () => {
        const change = { kind: 'opt-in' as const, nodeId: 2, stackName: 'api' };
        expect(describeMeshMembershipImpact(computeMeshMembershipImpact(fleet, change), change))
            .not.toMatch(/brings? (it|them) up/);
    });

    it('uses singular forms', () => {
        const change = { kind: 'disable-node' as const, nodeId: 1 };
        const impact = computeMeshMembershipImpact([node(1, 'home', ['pg']), node(2, 'vps', ['app'])], change);
        expect(describeMeshMembershipImpact(impact, change))
            .toBe('pg on this node leaves the mesh and restarts. app on vps also restarts to refresh hostnames, so expect brief connection drops.');
    });

    it('names the unreachable node whose stacks are skipped', () => {
        const change = { kind: 'opt-in' as const, nodeId: 1, stackName: 'api' };
        const status = [
            node(1, 'home', ['pg']),
            node(2, 'vps', ['app'], { reachableMode: 'unreachable', reachableReason: 'api token missing' }),
        ];
        expect(describeMeshMembershipImpact(computeMeshMembershipImpact(status, change), change))
            .toBe('api on home restarts now. pg on home also restarts to refresh hostnames, so expect brief connection drops. app on vps is skipped, because that node is unreachable.');
    });

    it('joins several unreachable nodes and does not claim nothing else is affected', () => {
        const change = { kind: 'opt-in' as const, nodeId: 1, stackName: 'api' };
        const status = [
            node(1, 'home', []),
            node(2, 'vps', ['app'], { reachableMode: 'pilot', pilotConnected: false }),
            node(3, 'edge', ['proxy'], { reachableMode: 'unreachable' }),
        ];
        const text = describeMeshMembershipImpact(computeMeshMembershipImpact(status, change), change);
        expect(text).not.toContain('No other meshed stacks are affected');
        expect(text).toBe('api on home restarts now. app on vps; proxy on edge are skipped, because those nodes are unreachable.');
    });

    it('never uses a plural pronoun for a single restarting stack', () => {
        const change = { kind: 'opt-in' as const, nodeId: 2, stackName: 'api' };
        const text = describeMeshMembershipImpact(computeMeshMembershipImpact([node(1, 'home', ['pg']), node(2, 'vps', [])], change), change);
        expect(text).toBe('api on vps restarts now. pg on home also restarts to refresh hostnames, so expect brief connection drops.');
        expect(text).not.toMatch(/\btheir\b/);
    });

    it('names every stack that leaves the mesh when a node is turned off', () => {
        const change = { kind: 'disable-node' as const, nodeId: 1 };
        const impact = computeMeshMembershipImpact(fleet, change);
        expect(describeMeshMembershipImpact(impact, change))
            .toBe('pg and redis on this node leave the mesh and restart. app on vps; proxy on edge also restart to refresh hostnames, so expect brief connection drops.');
    });

    it('names a stack the redeploy starts, whatever else changes', () => {
        const change = { kind: 'opt-in' as const, nodeId: 2, stackName: 'api' };
        const status = [
            node(1, 'home', [{ stackName: 'qam-a', running: true }, { stackName: 'qam-b', running: false }]),
            node(2, 'vps', [{ stackName: 'qam-c', running: false }, { stackName: 'qam-d', running: false }], { reachableMode: 'proxy' }),
        ];
        const text = describeMeshMembershipImpact(computeMeshMembershipImpact(status, change), change);
        expect(text).toContain('qam-b on home; qam-c and qam-d on vps are not running right now, and the redeploy brings them up.');
    });

    it('does not say anything restarts when turning off a node that has no meshed stacks', () => {
        const change = { kind: 'disable-node' as const, nodeId: 3 };
        const impact = computeMeshMembershipImpact([node(1, 'home', ['pg']), node(2, 'vps', ['app']), node(3, 'edge', [])], change);
        const text = describeMeshMembershipImpact(impact, change);
        expect(text).toBe('No stacks on this node are in the mesh. No hostnames change, so no other meshed stack needs a restart.');
        expect(text).not.toMatch(/also restart/);
        expect(meshChangeNeedsConfirmation(impact)).toBe(false);
    });

    it('still names a stopped stack a node turn-off brings up, and asks first', () => {
        const change = { kind: 'disable-node' as const, nodeId: 3 };
        const impact = computeMeshMembershipImpact(
            [node(1, 'home', [{ stackName: 'legacy', running: false }]), node(3, 'edge', [])],
            change,
        );
        expect(describeMeshMembershipImpact(impact, change)).toBe(
            'No stacks on this node are in the mesh. No hostnames change, so no other meshed stack needs a restart. legacy on home is not running right now, and the redeploy brings it up.',
        );
        expect(meshChangeNeedsConfirmation(impact)).toBe(true);
    });

    it('does not promise other restarts when the stack leaving the mesh publishes nothing', () => {
        const change = { kind: 'opt-out' as const, nodeId: 1, stackName: 'legacy' };
        const status = [node(1, 'home', [{ stackName: 'legacy', running: false }]), node(2, 'vps', ['app'])];
        expect(describeMeshMembershipImpact(computeMeshMembershipImpact(status, change), change))
            .toBe('legacy on home is not running right now, and the redeploy brings it up. No hostnames change, so no other meshed stack needs a restart.');
    });

    it('says the change cannot be applied, and nothing restarts, when the changed stack\'s node is unreachable', () => {
        // The backend stops before changing anything when it cannot reach the
        // node, so promising restarts elsewhere would be false too.
        const status = [node(1, 'home', ['pg']), node(2, 'vps', ['app'], { reachableMode: 'pilot', pilotConnected: false })];
        const optOut = { kind: 'opt-out' as const, nodeId: 2, stackName: 'app' };
        expect(describeMeshMembershipImpact(computeMeshMembershipImpact(status, optOut), optOut))
            .toBe('app on vps cannot be removed from the mesh while that node is unreachable, so nothing restarts.');
        const optIn = { kind: 'opt-in' as const, nodeId: 2, stackName: 'api' };
        expect(describeMeshMembershipImpact(computeMeshMembershipImpact(status, optIn), optIn))
            .toBe('api on vps cannot be added to the mesh while that node is unreachable, so nothing restarts.');
        const disable = { kind: 'disable-node' as const, nodeId: 2 };
        expect(describeMeshMembershipImpact(computeMeshMembershipImpact(status, disable), disable))
            .toBe('app on this node cannot leave the mesh while that node is unreachable, so nothing restarts.');
    });

    it('names a stopped stack of the node being turned off apart from the running ones', () => {
        const change = { kind: 'disable-node' as const, nodeId: 1 };
        const status = [
            node(1, 'home', [{ stackName: 'pg', running: true }, { stackName: 'legacy', running: false }]),
            node(2, 'vps', ['app']),
        ];
        const impact = computeMeshMembershipImpact(status, change);
        expect(impact.directStopped).toEqual([{ nodeName: 'home', stackName: 'legacy' }]);
        expect(describeMeshMembershipImpact(impact, change)).toBe(
            'pg on this node leaves the mesh and restarts. legacy on this node leaves the mesh, is not running right now, and the redeploy brings it up. app on vps also restarts to refresh hostnames, so expect brief connection drops.',
        );
    });

    it('asks first when the only restart is the node\'s own meshed stack', () => {
        // Nothing else is meshed, so the prompt rests on the direct stacks alone.
        const change = { kind: 'disable-node' as const, nodeId: 1 };
        const running = computeMeshMembershipImpact([node(1, 'home', ['pg'])], change);
        expect(running.others).toEqual([]);
        expect(describeMeshMembershipImpact(running, change))
            .toBe('pg on this node leaves the mesh and restarts. No other meshed stacks are affected.');
        expect(meshChangeNeedsConfirmation(running)).toBe(true);
        const stopped = computeMeshMembershipImpact([node(1, 'home', [{ stackName: 'legacy', running: false }])], change);
        expect(meshChangeNeedsConfirmation(stopped)).toBe(true);
    });

    it('assumes hostnames change for a node or stack the snapshot does not list', () => {
        // Unknown must warn, never reassure.
        expect(computeMeshMembershipImpact([node(2, 'vps', ['app'])], { kind: 'disable-node', nodeId: 9 }).hostnamesChange).toBe(true);
        expect(computeMeshMembershipImpact([node(1, 'home', ['pg'])], { kind: 'opt-out', nodeId: 1, stackName: 'ghost' }).hostnamesChange).toBe(true);
    });
});

describe('a stopped stack is named once', () => {
    const stopped = (name: string) => ({ stackName: name, running: false });

    it('is never both restarting and not running, on any kind of change', () => {
        const status = [
            node(1, 'home', [{ stackName: 'pg', running: true }, stopped('legacy')]),
            node(2, 'vps', [{ stackName: 'app', running: true }]),
        ];
        const changes = [
            { kind: 'opt-in' as const, nodeId: 2, stackName: 'api' },
            { kind: 'opt-out' as const, nodeId: 2, stackName: 'app' },
            { kind: 'disable-node' as const, nodeId: 2 },
        ];
        for (const change of changes) {
            const impact = computeMeshMembershipImpact(status, change);
            expect(impact.others.map((o) => o.stackName)).not.toContain('legacy');
            expect(impact.started).toEqual([{ nodeName: 'home', stackName: 'legacy' }]);
            const text = describeMeshMembershipImpact(impact, change);
            expect(text.match(/legacy/g)).toHaveLength(1);
            expect(text).toContain('legacy on home is not running right now, and the redeploy brings it up.');
        }
    });

    it('leaves out the restart sentence when every other reachable stack is stopped', () => {
        const change = { kind: 'opt-in' as const, nodeId: 2, stackName: 'api' };
        const status = [node(1, 'home', [stopped('legacy'), stopped('old')]), node(2, 'vps', [])];
        const impact = computeMeshMembershipImpact(status, change);
        const text = describeMeshMembershipImpact(impact, change);
        expect(text).toBe('api on vps restarts now. legacy and old on home are not running right now, and the redeploy brings them up.');
        expect(meshChangeNeedsConfirmation(impact)).toBe(true);
    });

    it('says no other stack is affected only when none is restarted, started or skipped', () => {
        const change = { kind: 'opt-in' as const, nodeId: 2, stackName: 'api' };
        expect(describeMeshMembershipImpact(computeMeshMembershipImpact([node(2, 'vps', [])], change), change))
            .toBe('api on vps restarts now. No other meshed stacks are affected.');
    });
});

describe('a change blocked by an unreachable node', () => {
    const down = (stacks: Array<string | { stackName: string; running: boolean }>) =>
        node(2, 'vps', stacks, { reachableMode: 'pilot', pilotConnected: false });

    it('is blocked for opt-in, opt-out and a node turn-off with stacks, on a pilot node with no tunnel', () => {
        const status = [node(1, 'home', ['pg']), down(['app'])];
        expect(meshChangeBlocked(computeMeshMembershipImpact(status, { kind: 'opt-in', nodeId: 2, stackName: 'api' }))).toBe(true);
        expect(meshChangeBlocked(computeMeshMembershipImpact(status, { kind: 'opt-out', nodeId: 2, stackName: 'app' }))).toBe(true);
        expect(meshChangeBlocked(computeMeshMembershipImpact(status, { kind: 'disable-node', nodeId: 2 }))).toBe(true);
    });

    it('is blocked on a proxy node whose dial failed', () => {
        const status = [node(1, 'home', ['pg']), node(2, 'edge', ['app'], { reachableMode: 'unreachable', reachableReason: 'api token missing' })];
        expect(meshChangeBlocked(computeMeshMembershipImpact(status, { kind: 'opt-out', nodeId: 2, stackName: 'app' }))).toBe(true);
    });

    it('is not blocked when the changed stack\'s node is reachable, or when nothing is changed directly', () => {
        const status = [node(1, 'home', ['pg']), down(['app'])];
        expect(meshChangeBlocked(computeMeshMembershipImpact(status, { kind: 'opt-out', nodeId: 1, stackName: 'pg' }))).toBe(false);
        expect(meshChangeBlocked(computeMeshMembershipImpact([node(1, 'home', ['pg']), down([])], { kind: 'disable-node', nodeId: 2 }))).toBe(false);
        expect(meshChangeBlocked(computeMeshMembershipImpact([node(1, 'home', ['pg'])], { kind: 'opt-in', nodeId: 9, stackName: 'x' }))).toBe(false);
    });
});
