/**
 * PeerToCentralMeshSessionDialer: peer-side counterpart to the central
 * ingress at `/api/mesh/proxy-tunnel-from-peer`. Reads cached central
 * material from `MeshCentralRegistry`, opens a WebSocket to central
 * carrying the bootstrapped JWT in the Authorization header, and on a
 * successful upgrade installs a local `PilotTunnelBridge` whose loopback
 * URL the local proxy can target as if central had dialed us.
 *
 * Failure handling branches on the central's machine-readable reason
 * code returned in the 401 body: terminal codes (stale,
 * signature_invalid, fingerprint, node_deleted, instance_mismatch,
 * audience_mismatch) clear the cache so we stop dialing with a known-bad
 * credential. Transient codes (clock_skew, mode_mismatch) keep the cache
 * but record the rejection so an operator can see why we stalled.
 * HTTP 404 (older central without the peer ingress endpoint) keeps the
 * cache and arms a longer backoff window so we do not hammer the remote.
 *
 * Process-local rate limit: at most 5 dial attempts per 60s window.
 * Concurrency: a single in-flight promise is shared across callers so
 * parallel `ensureSession()` calls coalesce into one dial.
 */
import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { MAX_FRAME_SIZE_BYTES } from '../pilot/protocol';
import { MeshCentralRegistry } from './MeshCentralRegistry';
import { PilotTunnelBridge } from './PilotTunnelBridge';
import { PilotMetrics } from './PilotMetrics';
import { httpUrlToWs } from '../utils/wsUrl';
import { sanitizeForLog } from '../utils/safeLog';

const HANDSHAKE_TIMEOUT_MS = 15_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 5;
const ENDPOINT_UNAVAILABLE_BACKOFF_MS = 5 * 60_000;
const CALLBACK_PATH = '/api/mesh/proxy-tunnel-from-peer';

/**
 * Reasons that indicate the cached central material is permanently bad
 * (wrong secret, wrong fingerprint, node removed on central, etc.) and
 * should be evicted so the next mesh-enable cycle remints fresh
 * material. `endpoint_not_found` is explicitly NOT in this set because
 * a 404 typically means "central is older than the peer ingress",
 * which is recoverable by waiting.
 */
const REJECT_REASONS_CLEAR = new Set([
    'stale',
    'token_fingerprint_mismatch',
    'node_deleted',
    'instance_mismatch',
    'signature_invalid',
    'audience_mismatch',
    'unknown',
]);

interface DialError extends Error {
    reason?: string;
    httpStatus?: number;
}

export class PeerToCentralMeshSessionDialer extends EventEmitter {
    private static instance: PeerToCentralMeshSessionDialer | null = null;
    private currentSession: PilotTunnelBridge | null = null;
    private inflight: Promise<PilotTunnelBridge | null> | null = null;
    private recentDials: number[] = [];
    private endpointUnavailableUntil = 0;

    private constructor() { super(); }

    public static getInstance(): PeerToCentralMeshSessionDialer {
        if (!this.instance) this.instance = new PeerToCentralMeshSessionDialer();
        return this.instance;
    }

    public static resetForTest(): void {
        if (this.instance) {
            try { this.instance.currentSession?.close(1000, 'test reset'); } catch { /* ignore */ }
        }
        this.instance = null;
    }

    public hasSession(): boolean {
        return this.currentSession !== null;
    }

    public async ensureSession(): Promise<PilotTunnelBridge | null> {
        if (this.currentSession) return this.currentSession;
        if (Date.now() < this.endpointUnavailableUntil) return null;
        if (this.isRateLimited()) return null;
        if (this.inflight) return this.inflight;
        this.inflight = this.dial().finally(() => { this.inflight = null; });
        return this.inflight;
    }

    private isRateLimited(): boolean {
        const now = Date.now();
        this.recentDials = this.recentDials.filter((ts) => now - ts < RATE_LIMIT_WINDOW_MS);
        return this.recentDials.length >= RATE_LIMIT_MAX;
    }

    private async dial(): Promise<PilotTunnelBridge | null> {
        const material = MeshCentralRegistry.getInstance().getActive();
        if (!material) return null;
        this.recentDials.push(Date.now());
        const wsUrl = httpUrlToWs(material.centralApiUrl) + CALLBACK_PATH;
        const ws = new WebSocket(wsUrl, {
            headers: { Authorization: `Bearer ${material.callbackJwt}` },
            handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
            maxPayload: MAX_FRAME_SIZE_BYTES,
        });
        try {
            await this.awaitOpen(ws);
        } catch (err) {
            ws.on('error', () => { /* swallow tail */ });
            try { ws.close(); } catch { /* ignore */ }
            this.handleDialFailure(err, material.centralInstanceId);
            return null;
        }
        return this.attachBridge(ws, material.centralInstanceId);
    }

    private async attachBridge(ws: WebSocket, instanceId: string): Promise<PilotTunnelBridge | null> {
        const bridge = new PilotTunnelBridge(0, ws);
        try {
            await bridge.start();
        } catch {
            try { bridge.close(1011, 'bridge start failed'); } catch { /* ignore */ }
            PilotMetrics.increment('mesh_callback_dials_failed_total');
            return null;
        }
        bridge.once('closed', () => {
            if (this.currentSession === bridge) this.currentSession = null;
        });
        this.currentSession = bridge;
        PilotMetrics.increment('mesh_central_bootstraps_total');
        MeshCentralRegistry.getInstance().markUsed(instanceId);
        return bridge;
    }

    private awaitOpen(ws: WebSocket): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const cleanup = (): void => {
                ws.removeAllListeners('open');
                ws.removeAllListeners('error');
                ws.removeAllListeners('unexpected-response');
            };
            ws.once('open', () => { cleanup(); resolve(); });
            ws.once('error', (err) => { cleanup(); reject(err); });
            ws.once('unexpected-response', (_req, res) => {
                cleanup();
                let body = '';
                res.on('data', (chunk: Buffer) => { body += chunk.toString('utf8'); });
                res.on('end', () => reject(this.buildUpgradeError(res.statusCode, body)));
            });
        });
    }

    private buildUpgradeError(statusCode: number | undefined, body: string): DialError {
        let reason = 'unknown';
        try {
            const parsed = JSON.parse(body) as { reason?: unknown };
            if (typeof parsed.reason === 'string') reason = parsed.reason;
        } catch { /* keep unknown */ }
        if (statusCode === 404) reason = 'endpoint_not_found';
        const err = new Error(`upgrade rejected: HTTP ${statusCode ?? 'unknown'} reason=${reason}`) as DialError;
        err.reason = reason;
        err.httpStatus = statusCode;
        return err;
    }

    private handleDialFailure(err: unknown, instanceId: string): void {
        const reason = (err as DialError).reason ?? 'unknown';
        PilotMetrics.increment('mesh_callback_dials_failed_total');
        if (REJECT_REASONS_CLEAR.has(reason)) {
            MeshCentralRegistry.getInstance().clearForInstance(instanceId);
            PilotMetrics.increment('mesh_callback_auth_failures_total');
        } else {
            MeshCentralRegistry.getInstance().markRejected(instanceId, reason);
            if (reason === 'endpoint_not_found') {
                this.endpointUnavailableUntil = Date.now() + ENDPOINT_UNAVAILABLE_BACKOFF_MS;
            }
        }
        console.warn(`[PeerToCentralMeshSessionDialer] dial failed: ${sanitizeForLog(`reason=${reason}`)}`);
    }
}
