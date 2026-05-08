import type http from 'http';
import type { IncomingMessage } from 'http';
import type { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { DatabaseService, type UserRole } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';
import { COOKIE_NAME } from '../helpers/constants';
import { handlePilotTunnel } from './pilotTunnel';
import { handleNotificationsWs } from './notifications';
import { handleRemoteForwarder } from './remoteForwarder';
import { handleLogsWs } from './logs';
import { handleHostConsoleWs } from './hostConsole';
import { handleGenericWs, attachGenericConnectionHandlers } from './generic';
import { rejectUpgrade as reject } from './reject';

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie || '';
  return Object.fromEntries(
    header
      .split(';')
      .map((c) => c.trim().split('='))
      .filter(([k, v]) => k && v),
  );
}

/**
 * Attach the upgrade dispatcher to the HTTP server and wire the generic
 * `connection` handler on the main wss.
 *
 * Dispatch order (first match wins):
 *   1. `/api/pilot/tunnel`        -> handlePilotTunnel (own auth, own wss)
 *   2. shared cookie/Bearer auth + JWT verify (rejects unauthenticated)
 *   3. API token scope gate (read-only / deploy-only restricted to logs + notifications)
 *   4. `/ws/notifications` local -> handleNotificationsWs
 *   5. remote nodeId path         -> handleRemoteForwarder
 *   6. `/api/stacks/:name/logs`   -> handleLogsWs
 *   7. `/api/system/host-console` -> handleHostConsoleWs
 *   8. fallback                   -> handleGenericWs (`/ws` exec + stats)
 */
export function attachUpgrade(
  server: http.Server,
  deps: { wss: WebSocketServer; pilotTunnelWss: WebSocketServer },
): void {
  const { wss, pilotTunnelWss } = deps;

  attachGenericConnectionHandlers(wss);

  server.on('upgrade', async (req, socket, head) => {
    // Pilot-agent tunnel ingress: machine credentials, no cookies.
    try {
      const reqUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (reqUrl.pathname === '/api/pilot/tunnel') {
        await handlePilotTunnel(req, socket, head, pilotTunnelWss);
        return;
      }
    } catch {
      // URL parse error falls through and will be rejected below.
    }

    const cookies = parseCookies(req);
    const cookieToken = cookies[COOKIE_NAME];
    const authHeader = req.headers['authorization'] as string | undefined;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    // Prefer Bearer over cookie: node-to-node proxy upgrades carry a Bearer
    // token and must not be shadowed by a browser cookie signed with a
    // different instance's JWT secret.
    const token = bearerToken || cookieToken;

    if (!token) return reject(socket, 401, 'Unauthorized');

    try {
      const settings = DatabaseService.getInstance().getGlobalSettings();
      const jwtSecret = settings.auth_jwt_secret;
      if (!jwtSecret) throw new Error('No JWT secret');
      const decoded = jwt.verify(token, jwtSecret) as { username?: string; scope?: string; role?: string; tv?: number };

      // Node proxy tokens are machine-to-machine credentials and must never be
      // granted interactive terminal access (host console or container exec).
      const isProxyToken = decoded.scope === 'node_proxy';

      let wsApiTokenScope: string | null = null;
      if (decoded.scope === 'api_token') {
        const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
        const apiToken = DatabaseService.getInstance().getApiTokenByHash(tokenHash);
        if (!apiToken || apiToken.revoked_at) return reject(socket, 401, 'Unauthorized');
        if (apiToken.expires_at && apiToken.expires_at < Date.now()) return reject(socket, 401, 'Unauthorized');
        DatabaseService.getInstance().updateApiTokenLastUsed(apiToken.id);
        wsApiTokenScope = apiToken.scope;
      }

      // For user session tokens (no scope), resolve against DB for up-to-date
      // role and token_version checks. Scoped tokens (api_token, node_proxy,
      // console_session) skip this: they are validated by their own logic
      // above or by the gateway that issued them.
      let wsResolvedUser: { username: string; role: UserRole; token_version: number } | undefined;
      if (!decoded.scope && decoded.username) {
        const dbUser = DatabaseService.getInstance().getUserByUsername(decoded.username);
        if (!dbUser) return reject(socket, 401, 'Unauthorized');
        if (decoded.tv !== undefined && dbUser.token_version !== decoded.tv) {
          console.log('[Auth] WS session rejected: token version mismatch for:', decoded.username);
          return reject(socket, 401, 'Unauthorized');
        }
        wsResolvedUser = {
          username: dbUser.username,
          role: dbUser.role as UserRole,
          token_version: dbUser.token_version,
        };
      }

      const parsedUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;

      // Gate WebSocket paths by API token scope
      if (wsApiTokenScope) {
        const isLogPath = /^\/api\/stacks\/[^/]+\/logs$/.test(pathname);
        const isNotifPath = pathname === '/ws/notifications';
        if (wsApiTokenScope === 'read-only' || wsApiTokenScope === 'deploy-only') {
          if (!isLogPath && !isNotifPath) return reject(socket, 403, 'Forbidden');
        }
      }

      const nodeIdParam = parsedUrl.searchParams.get('nodeId');
      const nodeId = nodeIdParam ? parseInt(nodeIdParam, 10) : NodeRegistry.getInstance().getDefaultNodeId();
      const node = NodeRegistry.getInstance().getNode(nodeId);

      // Notification push channel: local only when no remote nodeId is
      // specified. When a remote nodeId is provided, fall through to the
      // forwarder so the browser subscribes to that remote node's push stream.
      if (pathname === '/ws/notifications' && (!node || node.type !== 'remote')) {
        handleNotificationsWs(req, socket, head);
        return;
      }

      if (node && node.type === 'remote' && node.api_url && node.api_token) {
        await handleRemoteForwarder(req, socket, head, { node, pathname });
        return;
      }

      const logsMatch = pathname.match(/^\/api\/stacks\/([^/]+)\/logs$/);
      if (logsMatch) {
        handleLogsWs(req, socket, head, { nodeId, stackName: decodeURIComponent(logsMatch[1]) });
        return;
      }

      if (pathname.startsWith('/api/system/host-console')) {
        handleHostConsoleWs(req, socket, head, {
          nodeId,
          decoded,
          isProxyToken,
          wsResolvedUser,
          stackParam: parsedUrl.searchParams.get('stack'),
        });
        return;
      }

      handleGenericWs(req, socket, head, wss, { decoded, isProxyToken });
    } catch {
      return reject(socket, 401, 'Unauthorized');
    }
  });
}
