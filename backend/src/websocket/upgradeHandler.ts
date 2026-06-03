import type http from 'http';
import type { IncomingMessage } from 'http';
import type { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import { DatabaseService, type UserRole } from '../services/DatabaseService';
import { LicenseService } from '../services/LicenseService';
import { NodeRegistry } from '../services/NodeRegistry';
import { COOKIE_NAME } from '../helpers/constants';
import { handlePilotTunnel } from './pilotTunnel';
import { handleMeshProxyTunnel } from './meshProxyTunnel';
import { handleNotificationsWs } from './notifications';
import { handleRemoteForwarder } from './remoteForwarder';
import { handleLogsWs } from './logs';
import { handleHostConsoleWs } from './hostConsole';
import { handleGenericWs, attachGenericConnectionHandlers } from './generic';
import { rejectUpgrade as reject } from './reject';
import { looksLikeApiToken } from '../utils/apiTokenFormat';
import { validateApiToken, touchApiTokenLastUsed } from '../utils/apiTokenAuth';
import { isDebugEnabled } from '../utils/debug';
import { PROXY_TIER_HEADER, PROXY_VARIANT_HEADER } from '../services/license-headers';
import { isLicenseTier, normalizeTier, isLicenseVariant, normalizeVariant } from '../services/license-normalize';

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
 *   1. `/api/pilot/tunnel`                  -> handlePilotTunnel (own auth, own wss)
 *   2. shared cookie/Bearer auth + JWT verify (rejects unauthenticated)
 *   3. API token scope gate (read-only / deploy-only restricted to logs + notifications)
 *   4. `/api/mesh/proxy-tunnel`             -> handleMeshProxyTunnel (machine-to-machine: node_proxy or full-admin api_token; bidirectional bridge for both forward and reverse mesh traffic)
 *   5. `/ws/notifications` local           -> handleNotificationsWs
 *   6. remote nodeId path                   -> handleRemoteForwarder
 *   7. `/api/stacks/:name/logs`             -> handleLogsWs
 *   8. `/api/system/host-console`           -> handleHostConsoleWs
 *   9. fallback                             -> handleGenericWs (`/ws` exec + stats)
 */
export function attachUpgrade(
  server: http.Server,
  deps: { wss: WebSocketServer; pilotTunnelWss: WebSocketServer },
): void {
  const { wss, pilotTunnelWss } = deps;

  attachGenericConnectionHandlers(wss);

  server.on('upgrade', async (req, socket, head) => {
    // Pilot-agent tunnel ingress: machine credentials, no cookies. Runs its
    // own auth before the shared cookie/Bearer pipeline because the
    // credential is not a user session and would fail the shared
    // user-existence check.
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
      // Opaque sen_sk_ API tokens: handled before jwt.verify. Prefix +
      // length + checksum reject malformed keys without touching SQLite.
      let decoded: { username?: string; scope?: string; role?: string; tv?: number };
      let wsApiTokenScope: string | null = null;
      if (looksLikeApiToken(token)) {
        const validation = validateApiToken(token);
        if (!validation.ok) {
          if (isDebugEnabled()) console.log('[Auth:diag] WS API token rejected:', validation.reason);
          return reject(socket, 401, 'Unauthorized');
        }
        touchApiTokenLastUsed(validation.token);
        wsApiTokenScope = validation.token.scope;
        decoded = { scope: 'api_token' };
      } else {
        const settings = DatabaseService.getInstance().getGlobalSettings();
        const jwtSecret = settings.auth_jwt_secret;
        if (!jwtSecret) throw new Error('No JWT secret');
        decoded = jwt.verify(token, jwtSecret) as { username?: string; scope?: string; role?: string; tv?: number };
      }

      // Node proxy tokens are machine-to-machine credentials and must never be
      // granted interactive terminal access (host console or container exec).
      const isProxyToken = decoded.scope === 'node_proxy';

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

      // Mesh proxy-tunnel ingress: a sibling Sencho is dialing this node
      // to carry mesh TCP traffic. Accept any machine-to-machine credential:
      // node_proxy JWT (the token enrolled nodes carry) or a full-admin
      // api_token. Session cookies fall through to a 403 here because their
      // decoded scope is undefined (isProxyToken=false, wsApiTokenScope=null).
      // Restricted api_token scopes (read-only, deploy-only) are blocked
      // earlier by the scope gate above before this branch is reached.
      //
      // Admiral entitlement is decided against the *central's* license, not
      // the receiver's, matching every HTTP mesh route in routes/mesh.ts that
      // uses `requireAdmiral` / `effectiveTier`. On the node_proxy path the
      // central forwards `x-sencho-tier` / `x-sencho-variant` and the WS
      // dispatcher trusts them off the node_proxy credential (same rule as
      // middleware/auth.ts:117-135 for HTTP). On the full-admin api_token
      // path no central is asserting tier, so we fall back to the receiver's
      // own license. Both produce paid+admiral or the upgrade is rejected.
      if (pathname === '/api/mesh/proxy-tunnel') {
        if (!isProxyToken && wsApiTokenScope !== 'full-admin') {
          return reject(socket, 403, 'Forbidden');
        }
        const license = LicenseService.getInstance();
        const tunnelTierHeader = req.headers[PROXY_TIER_HEADER] as string | undefined;
        const tunnelVariantHeader = req.headers[PROXY_VARIANT_HEADER] as string | undefined;
        const tunnelTier = isProxyToken && isLicenseTier(tunnelTierHeader)
          ? normalizeTier(tunnelTierHeader)
          : license.getTier();
        const tunnelVariant = isProxyToken && tunnelVariantHeader !== undefined && isLicenseVariant(tunnelVariantHeader)
          ? normalizeVariant(tunnelVariantHeader)
          : license.getVariant();
        if (tunnelTier !== 'paid' || tunnelVariant !== 'admiral') {
          return reject(socket, 403, 'Forbidden');
        }
        await handleMeshProxyTunnel(req, socket, head);
        return;
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

      if (node && node.type === 'remote') {
        // Resolve the proxy target through NodeRegistry so pilot-mode nodes
        // (empty api_url + api_token, loopback bridge instead) and proxy-mode
        // nodes share one dispatch path. Mirrors proxy/remoteNodeProxy.ts.
        const target = NodeRegistry.getInstance().getProxyTarget(nodeId);
        if (!target) {
          // Pilot tunnel disconnected, or proxy-mode node missing credentials.
          // Reject the upgrade cleanly; falling through to local handlers would
          // serve gateway-local data for a request that named a remote node.
          return reject(socket, 503, 'Service Unavailable');
        }
        await handleRemoteForwarder(req, socket, head, { pathname, target });
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
