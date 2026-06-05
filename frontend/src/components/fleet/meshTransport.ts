import type { MeshNodeStatus, MeshReverseCallbackStatus } from '@/types/mesh';

export function reverseBridgeLabel(status: MeshReverseCallbackStatus): string {
    switch (status) {
        case 'connected': return 'connected';
        case 'connecting': return 'connecting';
        case 'unavailable': return 'unavailable';
        case 'not_applicable': return 'n/a';
        default: {
            const _exhaustive: never = status;
            throw new Error(`Unhandled reverse callback status: ${String(_exhaustive)}`);
        }
    }
}

export interface TransportLine {
    label: string;
    value: string;
}

/**
 * One-line transport descriptor for a mesh node, keyed off how the node
 * actually participates in routing. "Pilot tunnel" is shown only for
 * pilot-agent nodes; proxy peers report their API proxy bridge state, and the
 * local node runs in-process. This keeps the Routing diagnostics honest for a
 * fleet that connects its remotes over the HTTP API proxy rather than a pilot.
 */
export function describeTransport(node: MeshNodeStatus | undefined, pilotConnected: boolean): TransportLine {
    if (!node) return { label: 'Transport', value: 'unknown' };
    switch (node.reachableMode) {
        case 'local':
            return { label: 'Transport', value: 'local (in-process)' };
        case 'pilot':
            return { label: 'Pilot tunnel', value: pilotConnected ? 'connected' : 'disconnected' };
        case 'proxy':
            return { label: 'API proxy bridge', value: reverseBridgeLabel(node.reverseCallbackStatus) };
        case 'unreachable':
            return { label: 'Transport', value: 'unreachable' };
        default: {
            const _exhaustive: never = node.reachableMode;
            throw new Error(`Unhandled reachable mode: ${String(_exhaustive)}`);
        }
    }
}
