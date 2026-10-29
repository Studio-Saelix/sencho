import { describe, expect, it } from 'vitest';
import type { MeshNodeStatus } from '@/types/mesh';
import { computeMeshMembershipImpact, describeMeshMembershipImpact, isMeshCascadeReachable } from './meshImpact';

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
        expect(impact.otherNodeCount).toBe(3);
    });

    it('opt-out does not count the removed stack as an other', () => {
        const impact = computeMeshMembershipImpact(fleet, { kind: 'opt-out', nodeId: 1, stackName: 'pg' });
        expect(impact.others.map((o) => o.stackName).sort()).toEqual(['app', 'proxy', 'redis']);
    });

    it('separates stacks the cascade will start from stacks it merely restarts', () => {
        // The cascade deploys every meshed stack, and a deploy brings up
        // anything stopped. A stopped stack the operator meant to leave
        // stopped has to be its own bucket, not folded into the restart count.
        const withStopped = [
            node(1, 'home', [{ stackName: 'pg', running: true }, { stackName: 'legacy', running: false }]),
            node(2, 'vps', [{ stackName: 'app', running: true }]),
        ];
        const impact = computeMeshMembershipImpact(withStopped, { kind: 'opt-in', nodeId: 2, stackName: 'api' });

        expect(impact.others.map((o) => o.stackName).sort()).toEqual(['app', 'legacy', 'pg']);
        expect(impact.started).toEqual([{ nodeName: 'home', stackName: 'legacy' }]);
    });

    it('disabling a node restarts its stacks and the rest of the fleet', () => {
        const impact = computeMeshMembershipImpact(fleet, { kind: 'disable-node', nodeId: 1 });
        expect(impact.direct.map((d) => d.stackName)).toEqual(['pg', 'redis']);
        expect(impact.others.map((o) => o.stackName)).toEqual(['app', 'proxy']);
        expect(impact.otherNodeCount).toBe(2);
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
        expect(impact.otherNodeCount).toBe(1);
        expect(impact.skipped).toEqual([
            { nodeName: 'vps', stackName: 'app' },
            { nodeName: 'edge', stackName: 'proxy' },
        ]);
        // A stopped stack on an unreachable node is skipped, never promised a start.
        expect(impact.started).toEqual([]);
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
            .toBe('api on vps restarts now. 4 other meshed stacks on 3 nodes also restart to refresh their hostnames, so expect brief connection drops.');
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
            .toBe('api on vps restarts now. 3 other meshed stacks on 2 nodes also restart to refresh their hostnames, so expect brief connection drops. 1 of those is not running right now, and that deploy brings it up.');
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
            .toBe('1 meshed stack on this node leaves the mesh and restarts. 1 other meshed stack on 1 node also restarts to refresh their hostnames, so expect brief connection drops.');
    });

    it('names the unreachable node whose stacks are skipped', () => {
        const change = { kind: 'opt-in' as const, nodeId: 1, stackName: 'api' };
        const status = [
            node(1, 'home', ['pg']),
            node(2, 'vps', ['app'], { reachableMode: 'unreachable', reachableReason: 'api token missing' }),
        ];
        expect(describeMeshMembershipImpact(computeMeshMembershipImpact(status, change), change))
            .toBe('api on home restarts now. 1 other meshed stack on 1 node also restarts to refresh their hostnames, so expect brief connection drops. 1 meshed stack on vps is skipped, because that node is unreachable.');
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
        expect(text).toBe('api on home restarts now. 2 meshed stacks on vps and edge are skipped, because those nodes are unreachable.');
    });
});
