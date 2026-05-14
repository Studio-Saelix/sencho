import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_FRAME_SIZE_BYTES, decodeBinaryFrame, decodeJsonFrame, wsDataToBuffer, wsDataToString } from '../pilot/protocol';
import {
    TcpStreamSwitchboard,
    attachTcpStreamSwitchboard,
    resolveByComposeLabels,
    type ReverseTcpStreamHandle,
} from '../mesh/tcpStreamSwitchboard';
import { sanitizeForLog } from '../utils/safeLog';
import { isDebugEnabled } from '../utils/debug';
import { rejectUpgrade as reject } from './reject';

/**
 * Mesh proxy-tunnel ingress.
 *
 * The remote side of a Phase C proxy-mode mesh tunnel. Central dials
 * `WSS <api_url>/api/mesh/proxy-tunnel` using the long-lived `api_token`
 * as a Bearer credential; this handler upgrades the connection and wires
 * the shared `TcpStreamSwitchboard` to handle `tcp_open` / `tcp_open_ack`
 * / `tcp_open_reverse` / `tcp_close` and `TcpData` frames.
 *
 * Auth + scope gating happens in `upgradeHandler.ts` before this handler
 * runs (require `full-admin` api_token scope). The handler itself trusts
 * the upgrade; the WS credential is the only trust boundary.
 *
 * Bidirectional: when the tunnel opens, the handler registers itself as
 * the reverse-dialer on the local MeshService so meshed containers on
 * this Sencho can dial cross-node aliases via `tcp_open_reverse` over
 * the same WS. On disconnect the reverse-dialer registration is
 * cleared.
 */
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_SIZE_BYTES });

interface SwitchboardReverseDialer {
    openMeshTcpStream(target: { nodeId: number; stack: string; service: string; port: number }): ReverseTcpStreamHandle | null;
}

export async function handleMeshProxyTunnel(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    // Mesh service is only available on the central deployment (SENCHO_MODE
    // unset or 'central'). Pilot-mode Sencho receives mesh traffic via the
    // pilot tunnel and has no use for the proxy-mode WS path.
    if (process.env.SENCHO_MODE === 'pilot') {
        return reject(socket, 404, 'Not Found');
    }

    await new Promise<void>((resolve) => {
        wss.handleUpgrade(req, socket as Parameters<typeof wss.handleUpgrade>[1], head, (ws) => {
            void attachSwitchboard(ws).finally(resolve);
        });
    });
}

async function attachSwitchboard(ws: WebSocket): Promise<void> {
    let switchboard: TcpStreamSwitchboard | null = null;
    let reverseDialer: SwitchboardReverseDialer | null = null;
    let meshServiceCleanup: (() => void) | null = null;

    try {
        switchboard = attachTcpStreamSwitchboard({
            ws,
            resolveTarget: resolveByComposeLabels,
            logLabel: 'MeshProxy',
        });

        // Register a reverse dialer so this side's MeshForwarder can dial
        // cross-node aliases via `tcp_open_reverse` over the same WS. The
        // CAS swap refuses to overwrite a dialer that another caller
        // (a concurrent proxy-tunnel upgrade, or a pilot agent in a
        // misconfigured deployment) has already installed.
        const { MeshService } = await import('../services/MeshService');
        const meshService = MeshService.getInstance();
        const localSwitchboard = switchboard;
        const localDialer: SwitchboardReverseDialer = {
            openMeshTcpStream(target) {
                return localSwitchboard.openReverseStream(target);
            },
        };
        const installed = meshService.setReverseDialer(localDialer, null);
        if (!installed) {
            console.warn('[MeshProxy] reverse dialer already installed; rejecting concurrent tunnel');
            try { ws.close(1013, 'reverse dialer already installed'); } catch { /* ignore */ }
            switchboard.cleanup('reverse dialer already installed');
            switchboard = null;
            return;
        }
        reverseDialer = localDialer;
        meshServiceCleanup = () => {
            meshService.setReverseDialer(null, localDialer);
        };
    } catch (err) {
        if (isDebugEnabled()) {
            console.warn('[MeshProxy:diag] failed to attach switchboard:', sanitizeForLog((err as Error).message));
        }
        try { ws.close(1011, 'switchboard attach failed'); } catch { /* ignore */ }
        return;
    }

    const onMessage = (data: unknown, isBinary: boolean): void => {
        if (!switchboard) return;
        try {
            if (isBinary) {
                const buf = wsDataToBuffer(data);
                if (!buf) return;
                switchboard.handleBinaryFrame(decodeBinaryFrame(buf));
            } else {
                const text = wsDataToString(data);
                if (text == null) return;
                switchboard.handleJsonFrame(decodeJsonFrame(text));
            }
        } catch (err) {
            if (isDebugEnabled()) {
                console.warn('[MeshProxy:diag] malformed frame:', sanitizeForLog((err as Error).message));
            }
        }
    };

    const teardown = (): void => {
        ws.off('message', onMessage);
        if (switchboard) {
            switchboard.cleanup('mesh proxy-tunnel closed');
            switchboard = null;
        }
        if (meshServiceCleanup) {
            meshServiceCleanup();
            meshServiceCleanup = null;
        }
    };

    ws.on('message', onMessage);
    ws.once('close', teardown);
    ws.once('error', (err) => {
        if (isDebugEnabled()) {
            console.warn('[MeshProxy:diag] ws error:', sanitizeForLog(err.message));
        }
        teardown();
    });
}
