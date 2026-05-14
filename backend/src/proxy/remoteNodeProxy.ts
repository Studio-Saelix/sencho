import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { NodeRegistry } from '../services/NodeRegistry';
import { PROXY_TIER_HEADER, PROXY_VARIANT_HEADER } from '../services/license-headers';
import { LicenseService } from '../services/LicenseService';
import { isProxyExemptPath } from '../helpers/proxyExemptPaths';
import { getErrorMessage } from '../utils/errors';
import { DatabaseService } from '../services/DatabaseService';
import { redactSensitiveText } from '../utils/safeLog';

/**
 * Build the remote-node HTTP proxy middleware. Mount once at `/api/` after
 * authGate / auditLog / apiTokenScope; the middleware decides per-request
 * whether to proxy or call next().
 *
 * A single http-proxy instance is shared across all remote nodes so we do not
 * accumulate 'close' listeners or re-trigger the DEP0060 `util._extend`
 * warning on every request (which the old per-handler factory pattern did).
 * Per-request target resolution is handled via the `router` option.
 */
export function createRemoteProxyMiddleware(): RequestHandler {
  const proxy = createProxyMiddleware<Request, Response>({
    target: 'http://localhost:0', // placeholder - overridden per-request by router
    changeOrigin: true,
    router: (req) => req.proxyTarget?.apiUrl.replace(/\/$/, ''),
    // When mounted at app.use('/api/', ...), Express strips the '/api/' prefix from
    // req.url before the middleware sees it. Re-add it so the remote Sencho instance
    // receives the full path (e.g. '/stats' becomes '/api/stats').
    pathRewrite: (path) => '/api' + path,
    on: {
      proxyReq: (proxyReq, req) => {
        // Strip headers that must not reach the remote instance:
        // - x-node-id: remote Sencho treats all requests as local
        // - cookie: the browser's sencho_token is signed with THIS instance's JWT secret;
        //   the remote would try to verify it with its own secret and return 401.
        //   Authentication is handled exclusively via the Bearer token below.
        proxyReq.removeHeader('x-node-id');
        proxyReq.removeHeader('cookie');
        // Pilot-agent targets carry an empty token; see NodeRegistry.getProxyTarget.
        if (req.proxyTarget?.apiToken) {
          proxyReq.setHeader('Authorization', `Bearer ${req.proxyTarget.apiToken}`);
        }
        // Distributed License Enforcement: assert the main instance's license
        // tier to the remote node so tier-gated routes honor the main's
        // license instead of the node's local (likely Community) tier. The
        // remote's authMiddleware only trusts these headers when the request
        // carries a valid node_proxy JWT. The cached snapshot here invalidates
        // on activate / deactivate / validate so the headers track license
        // state changes within one proxy call.
        const headers = LicenseService.getInstance().getProxyHeaders();
        proxyReq.setHeader(PROXY_TIER_HEADER, headers.tier);
        proxyReq.setHeader(PROXY_VARIANT_HEADER, headers.variant || '');
        // Strip the ?nodeId= query param so the remote's nodeContextMiddleware
        // doesn't reject the request with 404 ("Node X not found") - the remote
        // has no record of the gateway's node IDs and should treat the request
        // as local. This affects endpoints like EventSource /api/containers/:id/logs
        // that pass nodeId as a query param rather than the x-node-id header.
        if (proxyReq.path.includes('nodeId=')) {
          const [pathname, qs] = proxyReq.path.split('?');
          const params = new URLSearchParams(qs || '');
          params.delete('nodeId');
          const newQs = params.toString();
          proxyReq.path = pathname + (newQs ? `?${newQs}` : '');
        }
        // Body forwarding: conditionalJsonParser skips parsing for remote
        // requests (see middleware/jsonParser.ts), so req's raw stream is
        // intact and http-proxy's req.pipe(proxyReq) forwards the body
        // automatically.
      },
      proxyRes: (proxyRes) => {
        // Mark every response forwarded from a remote node with a sentinel
        // header. The frontend (apiFetch / fetchForNode) checks this before
        // firing the global 'sencho-unauthorized' event: a 401 from a remote
        // means the stored api_token for that node is invalid, not that the
        // user's own session expired. Without this distinction, any node with
        // a bad token causes an immediate logout loop.
        proxyRes.headers['x-sencho-proxy'] = '1';
      },
      error: (err, req, proxyRes) => {
        console.error('[Proxy] Remote node error:', getErrorMessage(err, 'unknown'));
        const path = req.originalUrl || req.url;
        if (req.method === 'POST' && /^\/api\/stacks\/[^/]+\/(?:deploy|update)(?:\?|$)/.test(path)) {
          try {
            DatabaseService.getInstance().insertAuditLog({
              timestamp: Date.now(),
              username: req.user?.username ?? 'unknown',
              method: req.method,
              path,
              status_code: 502,
              node_id: req.nodeId,
              ip_address: req.ip ?? '',
              summary: `remote deploy proxy error: ${redactSensitiveText(getErrorMessage(err, 'unknown'))}`,
            });
          } catch (auditErr) {
            console.warn('[Proxy] Failed to record remote deploy proxy error:', getErrorMessage(auditErr, 'unknown'));
          }
        }
        // proxyRes can be either a ServerResponse (HTTP) or a raw Socket
        // (WS/TCP errors). Only attempt to send an HTTP 502 if it is a
        // proper ServerResponse with a headersSent flag; otherwise silently
        // drop (the socket will be destroyed).
        const res = proxyRes as { headersSent?: boolean; status?: (n: number) => { json: (b: unknown) => void } };
        if (typeof res?.headersSent === 'boolean' && !res.headersSent && typeof res.status === 'function') {
          res.status(502).json({
            error: 'Remote node is unreachable. Check the API URL and ensure Sencho is running on that host.',
          });
        }
      },
    },
  });

  return (req: Request, res: Response, next: NextFunction): void => {
    // The `/api/` mount strips the `/api` prefix, so req.path is now `/auth/…`,
    // `/nodes/…`, etc. Gateway-level concerns are always handled locally.
    if (isProxyExemptPath(`/api${req.path}`)) {
      next();
      return;
    }

    const node = NodeRegistry.getInstance().getNode(req.nodeId);
    if (!node || node.type !== 'remote') {
      next();
      return;
    }

    const target = NodeRegistry.getInstance().getProxyTarget(req.nodeId);
    if (!target) {
      if (node.mode === 'pilot_agent') {
        res.status(503).json({
          error: `Pilot tunnel to "${node.name}" is disconnected. Operations will resume when the agent reconnects.`,
        });
      } else {
        res.status(503).json({
          error: `Remote node "${node.name}" has no API URL or token configured. Update it in Settings → Nodes.`,
        });
      }
      return;
    }

    req.proxyTarget = target;
    proxy(req, res, next);
  };
}
