import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { PROXY_TIER_HEADER } from '../services/license-headers';
import { LicenseService } from '../services/LicenseService';
import { wsProxyServer } from '../proxy/websocketProxy';
import { getErrorMessage } from '../utils/errors';
import { rejectUpgrade as reject } from './reject';

/**
 * Forward a WebSocket upgrade to a remote Sencho instance. Handles the
 * console_session token exchange for interactive paths so the long-lived
 * api_token never reaches an interactive terminal (the remote's upgrade
 * handler rejects node_proxy tokens on those paths).
 *
 * Target resolution lives in the caller (parallel to the HTTP proxy in
 * `proxy/remoteNodeProxy.ts`), so this function works uniformly for
 * proxy-mode remotes (api_url + api_token) and pilot-mode remotes (loopback
 * URL + empty token). When the target carries an empty token, the loopback
 * bridge sits on 127.0.0.1 and demuxes onto an already-authenticated tunnel:
 * we skip the console-token exchange and do not inject a Bearer.
 */
export async function handleRemoteForwarder(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  opts: { pathname: string; target: { apiUrl: string; apiToken: string } },
): Promise<void> {
  const { pathname, target } = opts;
  if (!target.apiUrl) return reject(socket, 503, 'Service Unavailable');

  const wsTarget = target.apiUrl.replace(/\/$/, '').replace(/^https?/, (m) => m === 'https' ? 'wss' : 'ws');
  const isPilotLoopback = target.apiToken === '';

  // Interactive console paths (host console / container exec) are guarded on
  // the remote by an isProxyToken check that rejects the long-lived api_token.
  // Exchange it for a short-lived console_session token before forwarding so
  // the remote allows the connection while keeping the guard intact for
  // direct api_token access. Pilot loopback targets skip this: there is no
  // long-lived api_token to exchange, and host-console is disabled on pilot
  // mode at the capability registry anyway.
  const isInteractiveConsolePath = pathname === '/api/system/host-console' || pathname === '/ws';
  let bearerTokenForProxy = target.apiToken;
  if (isInteractiveConsolePath && !isPilotLoopback) {
    try {
      const consoleHeaders = LicenseService.getInstance().getProxyHeaders();
      const tokenRes = await fetch(`${target.apiUrl.replace(/\/$/, '')}/api/system/console-token`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${target.apiToken}`,
          [PROXY_TIER_HEADER]: consoleHeaders.tier,
        },
      });
      if (!tokenRes.ok) {
        console.error(`[WS Proxy] Remote console-token request failed: ${tokenRes.status}`);
        return reject(socket, 502, 'Bad Gateway');
      }
      const data = await tokenRes.json() as { token?: string };
      if (typeof data.token === 'string') bearerTokenForProxy = data.token;
    } catch (e) {
      console.error('[WS Proxy] Failed to fetch remote console token:', getErrorMessage(e, 'unknown'));
      return reject(socket, 502, 'Bad Gateway');
    }
  }

  if (isPilotLoopback) {
    // The loopback bridge does not authenticate inbound traffic; an
    // Authorization header inherited from the browser would only confuse
    // the agent. Strip it explicitly.
    delete req.headers['authorization'];
  } else {
    req.headers['authorization'] = `Bearer ${bearerTokenForProxy}`;
  }
  delete req.headers['x-node-id'];
  // Strip the browser's session cookie: signed by this instance's JWT secret
  // and would fail verification on the remote. Auth is handled exclusively
  // via the Bearer token (or, for pilot loopback, the tunnel itself).
  delete req.headers['cookie'];
  const fwdHeaders = LicenseService.getInstance().getProxyHeaders();
  req.headers[PROXY_TIER_HEADER] = fwdHeaders.tier;
  // Strip nodeId from the forwarded URL so the remote treats the request as
  // local. The remote has no record of the gateway's nodeId; leaving it would
  // trigger nodeContext's 404 branch.
  const fwdUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  fwdUrl.searchParams.delete('nodeId');
  req.url = fwdUrl.pathname + (fwdUrl.searchParams.toString() ? `?${fwdUrl.searchParams.toString()}` : '');
  wsProxyServer.ws(req, socket, head, { target: wsTarget });
}
