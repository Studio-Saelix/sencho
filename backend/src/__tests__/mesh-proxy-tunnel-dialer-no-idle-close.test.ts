/**
 * `MeshProxyTunnelDialer` default-TTL contract.
 *
 * The bridge is now a persistent bidirectional control-plane channel
 * (peer→central reverse traffic multiplexes over the same WS that
 * central uses to send forward `tcp_open` frames). The default
 * `SENCHO_MESH_PROXY_TUNNEL_IDLE_MS` is `0`, which disables the idle
 * sweeper entirely, so the dialer never tears the bridge down for
 * inactivity. The env override is retained as an escape hatch for the
 * legacy stream-scoped behavior.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MeshProxyTunnelDialer } from '../services/MeshProxyTunnelDialer';

let prev: string | undefined;

beforeEach(() => {
    prev = process.env.SENCHO_MESH_PROXY_TUNNEL_IDLE_MS;
    delete process.env.SENCHO_MESH_PROXY_TUNNEL_IDLE_MS;
});

afterEach(() => {
    if (prev === undefined) delete process.env.SENCHO_MESH_PROXY_TUNNEL_IDLE_MS;
    else process.env.SENCHO_MESH_PROXY_TUNNEL_IDLE_MS = prev;
});

describe('MeshProxyTunnelDialer idle-close default', () => {
    it('defaults to no idle close (TTL 0) and never starts the sweep timer', () => {
        const dialer = MeshProxyTunnelDialer.resetForTest() as unknown as {
            idleTtlMs: number;
            idleCheckTimer: NodeJS.Timeout | null;
        };
        expect(dialer.idleTtlMs).toBe(0);
        expect(dialer.idleCheckTimer).toBeNull();
    });

    it('respects an explicit env override to re-enable the legacy stream-scoped TTL', () => {
        process.env.SENCHO_MESH_PROXY_TUNNEL_IDLE_MS = '300000';
        const dialer = MeshProxyTunnelDialer.resetForTest() as unknown as {
            idleTtlMs: number;
            idleCheckTimer: NodeJS.Timeout | null;
        };
        expect(dialer.idleTtlMs).toBe(300_000);
        expect(dialer.idleCheckTimer).not.toBeNull();
    });

    it('respects an explicit override of `0` (no idle close) without scheduling', () => {
        process.env.SENCHO_MESH_PROXY_TUNNEL_IDLE_MS = '0';
        const dialer = MeshProxyTunnelDialer.resetForTest() as unknown as {
            idleTtlMs: number;
            idleCheckTimer: NodeJS.Timeout | null;
        };
        expect(dialer.idleTtlMs).toBe(0);
        expect(dialer.idleCheckTimer).toBeNull();
    });

    it('exposes isDialing(nodeId) which is false when no dial is in flight', () => {
        const dialer = MeshProxyTunnelDialer.resetForTest();
        expect(dialer.isDialing(42)).toBe(false);
    });
});
