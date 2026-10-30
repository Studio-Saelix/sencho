export type NodeConnection = 'local' | 'proxy' | 'pilot';

export const PIN_TITLE: Record<Exclude<NodeConnection, 'local'>, string> = {
    pilot: 'Pilot agent: this node connects out to the control instance over a tunnel',
    proxy: 'Proxy: the control instance reaches this node over its API',
};

/**
 * How the control instance reaches a node: itself, over its API, or over a Pilot tunnel.
 * `mode` is the node's connection mode: `'pilot_agent'` means Pilot; any other value
 * or none means Proxy, the backend's default for a remote node.
 */
export function nodeConnection(type: 'local' | 'remote', mode?: string | null): NodeConnection {
    if (type === 'local') return 'local';
    return mode === 'pilot_agent' ? 'pilot' : 'proxy';
}
