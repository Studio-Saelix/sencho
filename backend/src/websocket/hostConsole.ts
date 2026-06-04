import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import WebSocket, { WebSocketServer } from 'ws';
import { FileSystemService } from '../services/FileSystemService';
import { NodeRegistry } from '../services/NodeRegistry';
import { HostTerminalService } from '../services/HostTerminalService';
import { PROXY_TIER_HEADER } from '../services/license-headers';
import {
  isLicenseTier,
  normalizeTier,
} from '../services/license-normalize';
import { LicenseService } from '../services/LicenseService';
import { ROLE_PERMISSIONS, type PermissionAction } from '../middleware/permissions';
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
 * Enforces three gates before spawning the host PTY:
 *  1. Machine-credential rejection: node_proxy tokens cannot reach an
 *     interactive host shell.
 *  2. RBAC: user session tokens require the `system:console` permission.
 *     console_session tokens are pre-gated at issuance (see
 *     `routes/console.ts`) and skip this check.
 *  3. License: host console requires the paid tier. For console_session
 *     tokens the tier is trusted from the gateway-supplied header;
 *     otherwise the local LicenseService is consulted.
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
    const consolePermission: PermissionAction = 'system:console';
    if (!userRole || !ROLE_PERMISSIONS[userRole]?.includes(consolePermission)) {
      console.log('[HostConsole] Access denied: insufficient permissions', {
        username: wsResolvedUser?.username || decoded.username,
        role: userRole,
      });
      return reject(socket, 403, 'Forbidden');
    }
  }

  const consoleTierHeader = req.headers[PROXY_TIER_HEADER] as string | undefined;
  const ls = LicenseService.getInstance();
  const consoleTier = (isConsoleSession && isLicenseTier(consoleTierHeader))
    ? normalizeTier(consoleTierHeader)
    : ls.getTier();
  if (consoleTier !== 'paid') {
    return reject(socket, 403, 'Forbidden');
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
    // The shell may end up rooted at a different node than requested if the
    // requested node's directory cannot be resolved; the audit row must name
    // the node the shell actually runs in, so track it alongside the directory.
    let auditNodeId: number = nodeId;
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
      const fallbackNodeId = NodeRegistry.getInstance().getDefaultNodeId();
      console.error('[HostConsole] Failed to resolve console directory; falling back to the default node base dir', {
        user: consoleUsername,
        nodeId,
        fallbackNodeId,
        stack: stackParam || '(root)',
        error: getErrorMessage(error, 'unknown'),
      });
      targetDirectory = FileSystemService.getInstance(fallbackNodeId).getBaseDir();
      auditNodeId = fallbackNodeId;
    }
    const auditCtx = { username: consoleUsername, nodeId: auditNodeId, ipAddress };
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
