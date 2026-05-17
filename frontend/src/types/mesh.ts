export type MeshRoutePillState = 'healthy' | 'degraded' | 'unreachable' | 'tunnel-down' | 'not-authorized';

export type MeshDataPlaneReason =
    | 'ok'
    | 'not_started'
    | 'subnet_invalid'
    | 'subnet_overlap'
    | 'subnet_mismatch'
    | 'ip_in_use'
    | 'attach_failed'
    | 'not_in_docker';

export interface MeshDataPlaneStatus {
    ok: boolean;
    reason: MeshDataPlaneReason;
    message: string | null;
    subnet: string;
}

export interface MeshAlias {
    host: string;
    nodeId: number;
    nodeName: string;
    stackName: string;
    serviceName: string;
    port: number;
}

export type MeshReachableMode = 'local' | 'pilot' | 'proxy' | 'unreachable';

export interface MeshNodeStatus {
    nodeId: number;
    nodeName: string;
    enabled: boolean;
    /** Forwarder state for the LOCAL Sencho instance only. `null` for non-local nodes; cross-node forwarder state lands in Phase B. */
    localForwarderListening: boolean | null;
    /** True iff a pilot tunnel is currently registered. Only meaningful when `reachableMode === 'pilot'`. */
    pilotConnected: boolean;
    /** How this node participates in mesh routing. Drives Routing tab badge state. */
    reachableMode: MeshReachableMode;
    /** Operator-facing reason when `reachableMode === 'unreachable'`. Null otherwise. */
    reachableReason: string | null;
    optedInStacks: string[];
    activeStreamCount: number;
}

export interface MeshRouteDiagnostic {
    alias: string;
    target: {
        nodeId: number;
        stack: string;
        service: string;
        port: number;
        alias: string;
    } | null;
    pilot: { connected: boolean; lastSeen: number | null };
    lastError: { ts: number; message: string } | null;
    lastProbeMs: number | null;
    state: 'healthy' | 'degraded' | 'unreachable' | 'tunnel down' | 'not authorized';
}

export interface MeshNodeDiagnostic {
    nodeId: number;
    forwarder: { listening: boolean; listenerCount: number };
    pilot: { connected: boolean; bufferedAmount: number; lastSeen: number | null };
    activeStreams: Array<{ streamId: number; alias?: string; bytesIn: number; bytesOut: number; ageMs: number }>;
    aliasCache: Array<{ host: string; targetNodeId: number; port: number }>;
}

export interface MeshProbeResult {
    ok: boolean;
    latencyMs?: number;
    where?: 'no_route' | 'pilot_tunnel' | 'agent_resolve' | 'agent_dial' | 'target_port';
    code?: string;
    message?: string;
}

export interface MeshActivityEvent {
    ts: number;
    source: 'pilot' | 'mesh';
    level: 'info' | 'warn' | 'error';
    type: string;
    nodeId?: number;
    alias?: string;
    streamId?: number;
    message: string;
    details?: Record<string, unknown>;
}

export interface MeshStackEntry {
    name: string;
    optedIn: boolean;
}
