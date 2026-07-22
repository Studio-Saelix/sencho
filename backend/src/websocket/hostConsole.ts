import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import WebSocket, { WebSocketServer } from 'ws';
import { FileSystemService } from '../services/FileSystemService';
import { HostTerminalService } from '../services/HostTerminalService';
import { ROLE_PERMISSIONS } from '../middleware/permissions';
import type { UserRole } from '../services/DatabaseService';
import { getErrorMessage } from '../utils/errors';
import { rejectUpgrade as reject } from './reject';

interface HostConsoleContext {
  nodeId: number;
  decoded: { scope?: string; username?: string };
  isProxyToken: boolean;
  wsResolvedUser: { username: string; role: UserRole; token_version: number } | undefined;
  stackParam: string | null;
}

/**
 * Handle `/api/system/host-console` WebSocket upgrades.
 *
 * Enforces two gates before spawning the host PTY:
 *  1. Machine-credential rejection: node_proxy tokens cannot reach an
 *     interactive host shell directly (remote forwarding mints a
 *     console_session via POST /console-token instead).
 *  2. RBAC: user session tokens require the `system:console` permission.
 *     console_session tokens are pre-gated at issuance (see
 *     `routes/console.ts`) and skip this check.
 */
export function handleHostConsoleWs(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  ctx: HostConsoleContext,
): void {
  const { nodeId, decoded, isProxyToken, wsResolvedUser, stackParam } = ctx;

  if (isProxyToken) return reject(socket, 403, 'Forbidden');

  const isConsoleSession = decoded.scope === 'console_session';
  if (!isConsoleSession) {
    const userRole = wsResolvedUser?.role;
    if (!userRole || !ROLE_PERMISSIONS[userRole]?.includes('system:console')) {
      console.log('[HostConsole] Access denied: insufficient permissions', {
        username: wsResolvedUser?.username || decoded.username,
        role: userRole,
      });
      return reject(socket, 403, 'Forbidden');
    }
  }

  const consoleUsername = wsResolvedUser?.username || decoded.username || 'console_session';
  console.log('[HostConsole] WebSocket upgrade accepted', {
    username: consoleUsername,
    nodeId,
    stack: stackParam || '(root)',
  });

  // Client IP for the audit trail. Express's req.ip is unavailable on a raw
  // upgrade socket, so take the first x-forwarded-for hop and fall back to the
  // socket address.
  const forwarded = req.headers['x-forwarded-for'];
  const xff = typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '';
  const ipAddress = xff || req.socket.remoteAddress || '';

  const hostConsoleWss = new WebSocketServer({ noServer: true });
  hostConsoleWss.handleUpgrade(req, socket, head, (ws) => {
    hostConsoleWss.close();
    let targetDirectory: string;
    try {
      const baseDir = FileSystemService.getInstance(nodeId).getBaseDir();
      const resolved = HostTerminalService.resolveConsoleDirectory(baseDir, stackParam);
      if (resolved === null) {
        ws.send('Error: Invalid stack path\r\n');
        ws.close();
        return;
      }
      targetDirectory = resolved;
    } catch (error) {
      console.error('[HostConsole] Failed to resolve console directory', {
        user: consoleUsername,
        nodeId,
        stack: stackParam || '(root)',
        error: getErrorMessage(error, 'unknown'),
      });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send('Error: Failed to resolve console directory.\r\n');
        ws.close();
      }
      return;
    }
    const auditCtx = { username: consoleUsername, nodeId, ipAddress };
    try {
      HostTerminalService.spawnTerminal(ws, targetDirectory, auditCtx);
    } catch (error) {
      console.error('[HostConsole] Unhandled spawn error:', { user: consoleUsername, error: getErrorMessage(error, 'unknown') });
      if (ws.readyState === WebSocket.OPEN) {
        ws.send('Error: Failed to start terminal session.\r\n');
        ws.close();
      }
    }
  });
}
