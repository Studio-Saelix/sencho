import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import WebSocket, { WebSocketServer } from 'ws';
import DockerController from '../services/DockerController';
import { DatabaseService } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';
import { isDebugEnabled } from '../utils/debug';
import { rejectUpgrade as reject } from './reject';

/**
 * Header the deploy/update/down routes carry the per-deploy correlation id on,
 * mirroring the `sessionId` the frontend sends in `{action:'connectTerminal'}`.
 * Must stay in sync with `DEPLOY_SESSION_HEADER` in `frontend/src/lib/api.ts`.
 */
export const DEPLOY_SESSION_HEADER = 'x-deploy-session-id';

/**
 * Registry of compose-progress sockets keyed by the per-deploy correlation id
 * the frontend sends on `{action:'connectTerminal', sessionId}` and echoes on
 * the deploy/update/down POST via {@link DEPLOY_SESSION_HEADER}. A route resolves
 * the socket for its own deploy with `getTerminalWs(sessionId)`, so concurrent
 * deploys from different tabs or users never cross-stream output to each other.
 *
 * `lastTerminalWs` is the fallback for callers that connect or stream without a
 * session id (bulk operations, legacy clients): the most recent such socket wins.
 */
const terminalRegistry = new Map<string, WebSocket>();
let lastTerminalWs: WebSocket | undefined;

export function getTerminalWs(sessionId?: string): WebSocket | undefined {
  const ws = sessionId ? terminalRegistry.get(sessionId) : lastTerminalWs;
  return ws && ws.readyState === WebSocket.OPEN ? ws : undefined;
}

interface GenericContext {
  decoded: { scope?: string; username?: string; tv?: number };
  isProxyToken: boolean;
}

/**
 * Handle the generic `/ws` upgrade: terminal (container exec) and streaming
 * stats. Gates node-proxy tokens and non-admin users; the subsequent
 * connection handler processes `{action: ...}` messages from the client.
 */
export function handleGenericWs(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
  ctx: GenericContext,
): void {
  const { decoded, isProxyToken } = ctx;

  if (isProxyToken) return reject(socket, 403, 'Forbidden');

  // Admin enforcement: container exec requires admin role.
  // console_session tokens are already admin-gated at creation time.
  // API tokens reaching this point have full-admin scope (read-only /
  // deploy-only are blocked by the upgrade handler's scope gate).
  if (!decoded.scope) {
    const execUser = decoded.username ? DatabaseService.getInstance().getUserByUsername(decoded.username) : undefined;
    if (!execUser) {
      console.warn('[Exec] User account not found:', decoded.username);
      return reject(socket, 401, 'Unauthorized');
    }
    if (decoded.tv !== undefined && execUser.token_version !== decoded.tv) {
      console.warn('[Exec] Session invalidated (token version mismatch):', decoded.username);
      return reject(socket, 401, 'Unauthorized');
    }
    if (execUser.role !== 'admin') {
      console.warn('[Exec] Non-admin user rejected:', decoded.username);
      return reject(socket, 403, 'Forbidden');
    }
  }

  if (isDebugEnabled()) {
    console.debug('[Exec:diag] WS upgrade for exec path', {
      username: decoded.username,
      scope: decoded.scope || 'user-session',
    });
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
}

/**
 * Wire up the `connection` handler on the main wss. Processes `{action}`
 * messages for `connectTerminal` (captures the ws for deploy-output
 * streaming), `streamStats`, and `execContainer`. `{type}` messages (input,
 * resize, ping) are handled by per-session listeners registered inside
 * `execContainer`'s closure.
 */
export function attachGenericConnectionHandlers(wss: WebSocketServer): void {
  wss.on('connection', (ws) => {
    console.log('WebSocket connected');
    let registeredSessionId: string | undefined;

    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message.toString());
        if (!data.action) return;

        if (data.action === 'connectTerminal') {
          lastTerminalWs = ws;
          const sessionId = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : undefined;
          // Rebind this socket to the new id, dropping any prior mapping it held.
          if (registeredSessionId && registeredSessionId !== sessionId && terminalRegistry.get(registeredSessionId) === ws) {
            terminalRegistry.delete(registeredSessionId);
          }
          registeredSessionId = sessionId;
          if (sessionId) terminalRegistry.set(sessionId, ws);
          if (isDebugEnabled()) {
            console.debug('[Deploy:diag] progress stream registered', { sessionId: sessionId ?? '(none)' });
          }
        } else if (data.action === 'streamStats') {
          const requestedId = data.nodeId ? parseInt(data.nodeId, 10) : NodeRegistry.getInstance().getDefaultNodeId();
          // When a WS is proxied from a gateway to this remote instance, the
          // nodeId in the message belongs to the gateway's DB and won't
          // resolve locally. Fall back to local.
          let nodeId = requestedId;
          try { NodeRegistry.getInstance().getDocker(requestedId); } catch { nodeId = NodeRegistry.getInstance().getDefaultNodeId(); }
          DockerController.getInstance(nodeId).streamStats(data.containerId, ws).catch((err: Error) => {
            console.error('[WS] streamStats error:', err.message);
            if (ws.readyState === WebSocket.OPEN) ws.close();
          });
        } else if (data.action === 'execContainer') {
          const requestedId = data.nodeId ? parseInt(data.nodeId, 10) : NodeRegistry.getInstance().getDefaultNodeId();
          let nodeId = requestedId;
          try { NodeRegistry.getInstance().getDocker(requestedId); } catch { nodeId = NodeRegistry.getInstance().getDefaultNodeId(); }
          DockerController.getInstance(nodeId).execContainer(data.containerId, ws).catch((err: Error) => {
            console.error('[WS] execContainer error:', err.message);
            if (ws.readyState === WebSocket.OPEN) ws.close();
          });
        }
      } catch {
        // Malformed JSON - ignore silently
      }
    });

    ws.on('close', () => {
      if (registeredSessionId && terminalRegistry.get(registeredSessionId) === ws) {
        terminalRegistry.delete(registeredSessionId);
      }
      if (lastTerminalWs === ws) lastTerminalWs = undefined;
    });
  });
}
