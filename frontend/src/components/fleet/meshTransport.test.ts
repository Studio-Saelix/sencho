import { describe, it, expect } from 'vitest';
import { describeTransport, reverseBridgeLabel } from './meshTransport';
import type { MeshNodeStatus } from '@/types/mesh';

function node(over: Partial<MeshNodeStatus>): MeshNodeStatus {
    return {
        nodeId: 1,
        nodeName: 'n',
        enabled: true,
        localForwarderListening: null,
        pilotConnected: false,
        reachableMode: 'local',
        reachableReason: null,
        reverseCallbackStatus: 'not_applicable',
        optedInStacks: [],
        activeStreamCount: 0,
        ...over,
    };
}

describe('reverseBridgeLabel', () => {
    it('maps every reverse-callback status', () => {
        expect(reverseBridgeLabel('connected')).toBe('connected');
        expect(reverseBridgeLabel('connecting')).toBe('connecting');
        expect(reverseBridgeLabel('unavailable')).toBe('unavailable');
        expect(reverseBridgeLabel('not_applicable')).toBe('n/a');
    });
});

describe('describeTransport', () => {
    it('returns an unknown line for a missing node rather than a false positive', () => {
        expect(describeTransport(undefined, true)).toEqual({ label: 'Transport', value: 'unknown' });
    });

    it('labels a local node as in-process', () => {
        expect(describeTransport(node({ reachableMode: 'local' }), false))
            .toEqual({ label: 'Transport', value: 'local (in-process)' });
    });

    it('still labels a pilot node with its tunnel state', () => {
        expect(describeTransport(node({ reachableMode: 'pilot' }), true))
            .toEqual({ label: 'Pilot tunnel', value: 'connected' });
        expect(describeTransport(node({ reachableMode: 'pilot' }), false))
            .toEqual({ label: 'Pilot tunnel', value: 'disconnected' });
    });

    it('labels a proxy node with its API proxy bridge state, never a pilot tunnel', () => {
        expect(describeTransport(node({ reachableMode: 'proxy', reverseCallbackStatus: 'connected' }), false))
            .toEqual({ label: 'API proxy bridge', value: 'connected' });
        expect(describeTransport(node({ reachableMode: 'proxy', reverseCallbackStatus: 'connecting' }), false).value)
            .toBe('connecting');
        expect(describeTransport(node({ reachableMode: 'proxy', reverseCallbackStatus: 'unavailable' }), false).value)
            .toBe('unavailable');
    });

    it('labels an unreachable node', () => {
        expect(describeTransport(node({ reachableMode: 'unreachable' }), false))
            .toEqual({ label: 'Transport', value: 'unreachable' });
    });
});
