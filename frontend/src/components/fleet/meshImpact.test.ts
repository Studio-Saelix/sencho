import { describe, expect, it } from 'vitest';
import type { MeshNodeStatus } from '@/types/mesh';
import { computeMeshMembershipImpact, describeMeshMembershipImpact } from './meshImpact';

function node(nodeId: number, nodeName: string, stacks: Array<string | { stackName: string; running: boolean }>): MeshNodeStatus {
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
});
