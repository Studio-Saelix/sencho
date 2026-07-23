import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { NodeRegistry } from '../services/NodeRegistry';
import { PROXY_TIER_HEADER, PROXY_ROLE_HEADER, PROXY_DEPLOY_SOURCE_HEADER, PROXY_DEPLOY_ACTOR_HEADER } from '../services/license-headers';
import { LicenseService } from '../services/LicenseService';
import { isProxyExemptPath } from '../helpers/proxyExemptPaths';
import { remoteSupportsCrossNodeRbac, remoteAdvertisesCapability } from '../helpers/remoteCapabilities';
import { STACK_DOWN_REMOVE_VOLUMES_CAPABILITY, SERVICE_SCOPED_UPDATE_CAPABILITY, SERVICE_SCOPED_STACK_ALERT_CAPABILITY } from '../services/CapabilityRegistry';
import { getErrorMessage } from '../utils/errors';
import { DatabaseService } from '../services/DatabaseService';
import { redactSensitiveText } from '../utils/safeLog';
import { isDebugEnabled } from '../utils/debug';
import { logDebugTiming, templatizeHydrationPath } from '../utils/requestTiming';

/**
 * Per-request hop timing for the critical hydration GETs, kept off the Request
 * type via a WeakMap so the entry is collected with the request. `logged`
 * enforces exactly-once finalization across the downstream finish/close events
 * and the proxy error handler.
 */
type ProxyTimingOutcome = 'ok' | 'non2xx' | 'aborted' | 'error';

interface ProxyTiming {
  startedAt: number;
  template: string;
  logged: boolean;
  upstreamStatus?: number;
  ttfbMs?: number;
}

const proxyTimings = new WeakMap<Request, ProxyTiming>();

/**
 * Arm hop timing for a request that is about to be proxied. No-op unless the
 * gateway has developer_mode on and the path is a critical hydration GET, so
 * non-instrumented traffic pays nothing. Templates never carry a real stack
 * name or query string.
 */
function beginProxyTiming(req: Request, res: Response): void {
  if (req.method !== 'GET' || !isDebugEnabled()) return;
  const template = templatizeHydrationPath(`/api${req.path}`);
  if (!template) return;

  const timing: ProxyTiming = { startedAt: Date.now(), template, logged: false };
  proxyTimings.set(req, timing);

  // A completed response fires 'finish' then 'close'; the logged guard lets the
  // finish result win. A 'close' with no prior 'finish' means the downstream
  // client aborted before the body finished streaming.
  res.once('finish', () => {
    const status = timing.upstreamStatus ?? res.statusCode;
    finalizeProxyTiming(req, status >= 200 && status < 300 ? 'ok' : 'non2xx');
  });
  res.once('close', () => {
    finalizeProxyTiming(req, 'aborted');
  });
}

/** Emit the single `[Proxy:debug]` line for a request, at most once. */
function finalizeProxyTiming(req: Request, outcome: ProxyTimingOutcome): void {
  const timing = proxyTimings.get(req);
  if (!timing || timing.logged) return;
  timing.logged = true;
  logDebugTiming('[Proxy:debug]', {
    route: timing.template,
    nodeId: req.nodeId,
    outcome,
    upstreamStatus: timing.upstreamStatus ?? null,
    ttfbMs: timing.ttfbMs ?? null,
    elapsedMs: Date.now() - timing.startedAt,
  });
}

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
        // Forward the signed-in user's role so the remote enforces their RBAC
        // rather than treating every proxied request as admin. Strip first so a
        // browser/API client cannot smuggle the header through the gateway, then
        // re-set from the authenticated session (authGate runs before this proxy,
        // so req.user is always resolved here).
        proxyReq.removeHeader(PROXY_ROLE_HEADER);
        if (req.user?.role) {
          proxyReq.setHeader(PROXY_ROLE_HEADER, req.user.role);
        }
        // Deploy provenance: always strip client-supplied values, then set
        // interactive manual + authenticated username for proxied browser/API
        // deploys. Background machine callers do not go through this gateway
        // with browser credentials; they set headers on direct machine HTTP.
        proxyReq.removeHeader(PROXY_DEPLOY_SOURCE_HEADER);
        proxyReq.removeHeader(PROXY_DEPLOY_ACTOR_HEADER);
        proxyReq.setHeader(PROXY_DEPLOY_SOURCE_HEADER, 'manual');
        if (req.user?.username) {
          proxyReq.setHeader(PROXY_DEPLOY_ACTOR_HEADER, req.user.username);
        }
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
        // usually intact and http-proxy's req.pipe(proxyReq) forwards it.
        // When a gate must inspect JSON (POST /alerts), we buffer into
        // req.rawBody first; rewrite that buffer here because the stream is
        // already consumed.
        if (req.rawBody) {
          proxyReq.removeHeader('Transfer-Encoding');
          proxyReq.removeHeader('Content-Length');
          if (!proxyReq.getHeader('Content-Type')) {
            proxyReq.setHeader('Content-Type', 'application/json');
          }
          proxyReq.setHeader('Content-Length', req.rawBody.length);
          proxyReq.write(req.rawBody);
        }
      },
      proxyRes: (proxyRes, req) => {
        // Mark every response forwarded from a remote node with a sentinel
        // header. The frontend (apiFetch / fetchForNode) checks this before
        // firing the global 'sencho-unauthorized' event: a 401 from a remote
        // means the stored api_token for that node is invalid, not that the
        // user's own session expired. Without this distinction, any node with
        // a bad token causes an immediate logout loop.
        proxyRes.headers['x-sencho-proxy'] = '1';
        // Record upstream status and time-to-first-byte only; the log is
        // finalized on the downstream finish/close so an abort mid-body is not
        // mislabeled as success.
        const timing = proxyTimings.get(req);
        if (timing) {
          timing.upstreamStatus = proxyRes.statusCode;
          timing.ttfbMs = Date.now() - timing.startedAt;
        }
      },
      error: (err, req, proxyRes) => {
        // Finalize the hop timing with an error outcome before the existing
        // 502 handling; the logged guard keeps the later finish/close a no-op.
        finalizeProxyTiming(req, 'error');
        console.error('[Proxy] Remote node error:', getErrorMessage(err, 'unknown'));
        const path = req.originalUrl || req.url;
        if (req.method === 'POST' && /^\/api\/stacks\/[^/]+\/(?:deploy|update|services\/[^/]+\/(?:update|restore))(?:\?|$)/.test(path)) {
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

    const runGatedProxy = async (): Promise<void> => {
      if (isStackDownWithRemoveVolumes(req)) {
        const supported = await remoteAdvertisesCapability(req.nodeId, STACK_DOWN_REMOVE_VOLUMES_CAPABILITY);
        if (!supported) {
          res.status(400).json({ error: 'Volume removal is not supported on this node' });
          return;
        }
      }

      if (isServiceScopedUpdateRoute(req)) {
        const supported = await remoteAdvertisesCapability(req.nodeId, SERVICE_SCOPED_UPDATE_CAPABILITY);
        if (!supported) {
          res.status(400).json({ error: 'Service-scoped updates are not supported on this node', code: 'capability_unavailable' });
          return;
        }
      }

      // POST /alerts bodies are not on req.body for remote hops (JSON parsing
      // is skipped so the stream can be piped). Buffer once, gate on the
      // parsed service_name, then rewrite rawBody in on.proxyReq.
      if (isAlertCreateRoute(req)) {
        req.rawBody = await bufferRequestBody(req);
        if (alertCreateHasScopedService(req.rawBody)) {
          const supported = await remoteAdvertisesCapability(req.nodeId, SERVICE_SCOPED_STACK_ALERT_CAPABILITY);
          if (!supported) {
            res.status(400).json({
              error: 'Service-scoped alert rules are not supported on this node',
              code: 'capability_unavailable',
            });
            return;
          }
        }
      }

      // Mixed-version RBAC gate (non-admin only).
      if (req.user?.role !== 'admin') {
        const rbacSupported = await remoteSupportsCrossNodeRbac(req.nodeId);
        if (!rbacSupported) {
          res.status(403).json({
            error: `Remote node "${node.name}" is running a version that does not enforce per-user permissions. Upgrade it before non-admin users can act on it.`,
          });
          return;
        }
      }

      req.proxyTarget = target;
      beginProxyTiming(req, res);
      proxy(req, res, next);
    };

    runGatedProxy().catch(next);
  };
}

/** POST /stacks/:stackName/down with ?removeVolumes=true (path is post-/api strip). */
function isStackDownWithRemoveVolumes(req: Request): boolean {
  if (req.method !== 'POST') return false;
  if (!/^\/stacks\/[^/]+\/down$/.test(req.path)) return false;
  return req.query.removeVolumes === 'true';
}

/** Nested service update/restore/recovery routes (path is post-/api strip). */
function isServiceScopedUpdateRoute(req: Request): boolean {
  if (req.method === 'GET') {
    return /^\/stacks\/[^/]+\/services\/[^/]+\/recovery$/.test(req.path);
  }
  if (req.method === 'POST') {
    return /^\/stacks\/[^/]+\/services\/[^/]+\/(?:update|restore)$/.test(req.path);
  }
  return false;
}

/** POST /alerts (path is post-/api strip). */
function isAlertCreateRoute(req: Request): boolean {
  return req.method === 'POST' && /^\/alerts\/?$/.test(req.path);
}

/** True when the buffered JSON alert body targets a specific Compose service. */
function alertCreateHasScopedService(rawBody: Buffer): boolean {
  if (rawBody.length === 0) return false;
  try {
    const parsed = JSON.parse(rawBody.toString('utf-8')) as { service_name?: unknown };
    return typeof parsed.service_name === 'string' && parsed.service_name.trim() !== '';
  } catch {
    // Invalid JSON is forwarded as-is; the remote rejects it. Do not treat
    // parse failure as scoped (would block unscoped typos behind a capability).
    return false;
  }
}

/**
 * Drain the incoming request into a Buffer so a capability gate can inspect
 * JSON without leaving http-proxy with an already-ended empty stream.
 */
async function bufferRequestBody(req: Request): Promise<Buffer> {
  if (req.rawBody) return req.rawBody;
  if (req.readableEnded) return Buffer.alloc(0);

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (buf: Buffer) => {
      if (settled) return;
      settled = true;
      resolve(buf);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk: Buffer) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', fail);
    req.on('aborted', () => {
      fail(Object.assign(new Error('Client aborted request body'), { status: 400, expose: true }));
    });
    req.on('close', () => {
      if (!settled && !req.readableEnded) {
        fail(Object.assign(new Error('Client closed request before body finished'), { status: 400, expose: true }));
      }
    });
  });
}
