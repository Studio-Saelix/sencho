import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { ClientRequest, IncomingMessage } from 'http';
import { createProxyMiddleware } from 'http-proxy-middleware';
import type { OnProxyEvent } from 'http-proxy-middleware';
import {
  REMOTE_READ_BODY_IDLE_TIMEOUT_MS,
  REMOTE_READ_FAILURE_HEADER,
  REMOTE_READ_TIMEOUT_HEADER,
  isStreamingOrDownloadResponse,
  remoteReadTimeoutBody,
  remoteReadTimeoutMs,
} from './interactiveRemoteRead';
import {
  IDENTITY_PROXY_TIMEOUT_MS,
  isIdentityFailure,
  filterRemoteIdentityPayload,
  handleIdentityResponse,
  hubNodeIdFor,
  isGitOpsIdentityJsonRoute,
  prepareIdentityQuery,
  rewriteIdentityPayload,
  stripConditionalRequestHeaders,
} from './gitopsIdentityProxy';
import { satisfiesGitOpsRead } from '../services/gitops/readAuth';
import { handleImageUpdateResponse } from './imageUpdateVerificationProxy';
import { NodeRegistry } from '../services/NodeRegistry';
import {
  PROXY_TIER_HEADER,
  PROXY_ROLE_HEADER,
  PROXY_DEPLOY_SOURCE_HEADER,
  PROXY_DEPLOY_ACTOR_HEADER,
  PROXY_SCOPED_STACK_NAME_HEADER,
  PROXY_SCOPED_STACK_ACTIONS_HEADER,
} from '../services/license-headers';
import { LicenseService } from '../services/LicenseService';
import { isProxyExemptPath } from '../helpers/proxyExemptPaths';
import { remoteAdvertisesCapability, probeRemoteCapability } from '../helpers/remoteCapabilities';
import { hubImageUpdateJsonParser } from '../middleware/jsonParser';
import {
  CROSS_NODE_RBAC_CAPABILITY,
  STACK_DOWN_REMOVE_VOLUMES_CAPABILITY,
  STACK_DELETE_PRUNE_VOLUMES_CAPABILITY,
  SERVICE_SCOPED_UPDATE_CAPABILITY,
  SERVICE_SCOPED_STACK_ALERT_CAPABILITY,
  SCOPED_STACK_AUTH_EVIDENCE_CAPABILITY,
  HOST_USAGE_UNKNOWN_HEADER,
  HOST_USAGE_UNKNOWN_HEADER_VALUE,
} from '../services/CapabilityRegistry';
import { getErrorMessage } from '../utils/errors';
import { DatabaseService } from '../services/DatabaseService';
import { removeStackMuteRules } from '../helpers/notificationSuppressionSync';
import { redactSensitiveText } from '../utils/safeLog';
import { isValidStackName } from '../utils/validation';
import { isDebugEnabled } from '../utils/debug';
import { logDebugTiming, templatizeHydrationPath } from '../utils/requestTiming';
import { invalidateFleetUpdateCache, isFullStackUpdatePath, isUpdatePreviewPath } from '../helpers/fleetUpdateCache';
import {
  classifyStackApiPath,
  formatScopedStackActionsHeader,
} from '../helpers/stackRouteAuth';
import {
  checkPermission,
  ROLE_PERMISSIONS,
  scopedActionsForStack,
} from '../middleware/permissions';
import type { PermissionAction } from '../middleware/permissions';
import { SETTING_WRITE_PERMISSIONS } from '../routes/settings';
import { rejectApiTokenScope } from '../middleware/apiTokenScope';
import { requestAcceptsUnknownHostUsage } from '../helpers/hostUsageNegotiation';
import { RegistryDeliveryService } from '../services/RegistryDeliveryService';
import {
  assertSafeOutboundUrl,
  safeHttpAgent,
  safeHttpsAgent,
  UnsafeOutboundTargetError,
} from '../utils/outboundTarget';
import {
  classifyRegistryDeliveryRouteClass,
  getRegistryDeliveryTotalBodyLimit,
} from '../helpers/registryDeliveryBodyLimits';
import { classifyRegistryDeliveryOp } from '../helpers/registryOpClassifier';
import { augmentRemoteProxyWithRegistryDelivery, evaluateRegistryDeliveryProxyGate } from '../helpers/registryDeliveryProxy';

/**
 * Per-request hop timing for the critical hydration GETs, kept off the Request
 * type via a WeakMap so the entry is collected with the request. `logged`
 * enforces exactly-once finalization across the downstream finish/close events
 * and the proxy error handler.
 */
type ProxyTimingOutcome = 'ok' | 'non2xx' | 'aborted' | 'error' | 'timeout';

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
 * Deadline state for an interactive read against a remote node, kept off the
 * Request type via WeakMaps so it is collected with the request. `fired` lets
 * the proxy error handler tell our own upstream abort from a real transport
 * failure; the entry stays for the life of the request, because the abort it
 * triggers arrives after the deadline has already answered.
 */
interface InteractiveReadDeadline {
  /** Time-to-headers budget; cleared as soon as the remote answers. */
  headerTimer?: NodeJS.Timeout;
  /** Idle bound on a body that has started but stopped sending. */
  bodyIdleTimer?: NodeJS.Timeout;
  stopBodyWatch?: () => void;
  fired: boolean;
}

const interactiveReadDeadlines = new WeakMap<Request, InteractiveReadDeadline>();
/** The upstream request the hop opened, so a missed deadline can abort it. */
const proxyRequests = new WeakMap<Request, ClientRequest>();

/**
 * Bound an interactive read's time to the remote's headers. On expiry the
 * gateway answers 504 with the timeout code and destroys the upstream request,
 * so a remote that accepted the connection and then went silent cannot hold a
 * socket or a page's loading state.
 */
function armInteractiveReadDeadline(
  req: Request,
  res: Response,
  nodeName: string | undefined,
  timeoutMs: number,
): void {
  const deadline: InteractiveReadDeadline = { fired: false };
  deadline.headerTimer = setTimeout(() => {
    deadline.fired = true;
    const upstream = proxyRequests.get(req);
    if (res.headersSent) {
      // Headers are already on the wire, so the only honest answer left is to
      // end the response rather than append a JSON error to a partial body. The
      // hop is still recorded as a timeout: the visible symptom is a truncated
      // body, and the log should name the bound that caused it.
      finalizeProxyTiming(req, 'timeout');
      res.destroy();
    } else {
      finalizeProxyTiming(req, 'timeout');
      res.status(504);
      res.setHeader(REMOTE_READ_TIMEOUT_HEADER, '1');
      res.json(remoteReadTimeoutBody(nodeName, timeoutMs));
    }
    upstream?.destroy();
  }, timeoutMs);
  interactiveReadDeadlines.set(req, deadline);
  res.once('finish', () => releaseInteractiveReadDeadline(req));
  res.once('close', () => releaseInteractiveReadDeadline(req));
}

/**
 * The remote answered. Release the time-to-headers budget for every response,
 * then bound only a body that stalls mid-flight. Streams and downloads keep
 * their own lifetime from the first byte.
 */
function noteInteractiveReadHeaders(req: Request, res: Response, proxyRes: IncomingMessage): void {
  const deadline = interactiveReadDeadlines.get(req);
  if (!deadline || deadline.fired) return;
  if (deadline.headerTimer) {
    clearTimeout(deadline.headerTimer);
    deadline.headerTimer = undefined;
  }
  if (isStreamingOrDownloadResponse(proxyRes.headers)) {
    releaseInteractiveReadDeadline(req);
    return;
  }

  const stopBodyWatch = (): void => {
    if (deadline.bodyIdleTimer) {
      clearTimeout(deadline.bodyIdleTimer);
      deadline.bodyIdleTimer = undefined;
    }
    deadline.stopBodyWatch = undefined;
  };
  const onBodyData = (): void => {
    if (deadline.fired) return;
    if (deadline.bodyIdleTimer) clearTimeout(deadline.bodyIdleTimer);
    deadline.bodyIdleTimer = setTimeout(() => {
      deadline.fired = true;
      stopBodyWatch();
      proxyRes.off('data', onBodyData);
      // The body stopped moving after it started: end the transfer instead of
      // holding both sockets open forever. There is no honest status left to
      // send after the headers, so the response is destroyed and the log names
      // the bound that ended it.
      finalizeProxyTiming(req, 'timeout');
      res.destroy();
      proxyRequests.get(req)?.destroy();
    }, REMOTE_READ_BODY_IDLE_TIMEOUT_MS);
  };
  deadline.stopBodyWatch = () => {
    stopBodyWatch();
    proxyRes.off('data', onBodyData);
  };
  proxyRes.on('data', onBodyData);
  onBodyData();
}

/** Release an armed deadline and both of its timers. A deadline that already
 *  fired stays recorded so the abort it caused is not reported as a transport
 *  failure. */
function releaseInteractiveReadDeadline(req: Request): void {
  const deadline = interactiveReadDeadlines.get(req);
  if (!deadline) return;
  if (deadline.headerTimer) {
    clearTimeout(deadline.headerTimer);
    deadline.headerTimer = undefined;
  }
  deadline.stopBodyWatch?.();
  if (!deadline.fired) interactiveReadDeadlines.delete(req);
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
  // Shared by both hops. The identity hop replaces only `proxyRes`, so
  // credential stripping, role and tier assertion, and error handling stay
  // identical however a request is forwarded.
  const sharedOn: OnProxyEvent<Request, Response> = {
    proxyReq: (proxyReq, req) => {
      // Remember the upstream request so a missed read deadline can abort it.
      proxyRequests.set(req, proxyReq);
      // A deadline that fired before the connection existed had nothing to
      // abort. Destroy the socket as soon as it appears rather than leaving the
      // hop talk to a remote nobody is waiting for.
      if (interactiveReadDeadlines.get(req)?.fired) {
        proxyReq.destroy();
        return;
      }
      // Strip headers that must not reach the remote instance:
      // - x-node-id: remote Sencho treats all requests as local
      // - cookie: the browser's sencho_token is signed with THIS instance's JWT secret;
      //   the remote would try to verify it with its own secret and return 401.
      //   Authentication is handled exclusively via the Bearer token below.
      proxyReq.removeHeader('x-node-id');
      proxyReq.removeHeader('cookie');
      // Forwarding headers must describe what THIS instance validated, not
      // what the caller sent. A remote that trusts this instance resolves the
      // client from these headers, so relaying a caller-supplied
      // X-Forwarded-For would let the caller choose the address the remote
      // records. Replace them with the values Express resolved under this
      // instance's own trusted-proxy policy. Strip every x-forwarded-* name
      // first so the invariant does not depend on which names this handler
      // happens to know about, then set the two this instance vouches for.
      const validatedClientIp = req.ip;
      const validatedProtocol = req.protocol;
      for (const name of Object.keys(proxyReq.getHeaders())) {
        if (name.startsWith('x-forwarded-')) proxyReq.removeHeader(name);
      }
      proxyReq.removeHeader('x-real-ip');
      proxyReq.removeHeader('forwarded');
      if (validatedClientIp) {
        proxyReq.setHeader('x-forwarded-for', validatedClientIp);
      }
      proxyReq.setHeader('x-forwarded-proto', validatedProtocol);
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
      // Advertise nullable host usage only when this hop's caller can render
      // it. A browser session always can (it runs this same build); a machine
      // client (an API token, or a hub older than the capability) must send the
      // header itself, or it keeps the numeric shape its dashboard and
      // monitoring scripts expect. The remote decides from this header alone,
      // so forwarding the caller's own negotiation is the whole contract:
      // overriding it would turn a token caller's numeric shape into a `null`
      // it never asked for. Strip first so a browser cannot choose the remote's
      // shape and a caller's value is never trusted verbatim.
      proxyReq.removeHeader(HOST_USAGE_UNKNOWN_HEADER);
      if (requestAcceptsUnknownHostUsage(req)) {
        proxyReq.setHeader(HOST_USAGE_UNKNOWN_HEADER, HOST_USAGE_UNKNOWN_HEADER_VALUE);
      }
      // Forward the signed-in user's role so the remote enforces their RBAC
      // rather than treating every proxied request as admin. Strip first so a
      // browser/API client cannot smuggle the header through the gateway, then
      // re-set from the authenticated session (authGate runs before this proxy,
      // so req.user is always resolved here).
      proxyReq.removeHeader(PROXY_ROLE_HEADER);
      if (req.proxyElevatedRole) {
        proxyReq.setHeader(PROXY_ROLE_HEADER, req.proxyElevatedRole);
      } else if (req.user?.role) {
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
      // Scoped stack evidence: always strip client-supplied values, then
      // attach hub-built evidence when the gate stashed elevation for this hop.
      proxyReq.removeHeader(PROXY_SCOPED_STACK_NAME_HEADER);
      proxyReq.removeHeader(PROXY_SCOPED_STACK_ACTIONS_HEADER);
      if (req.proxyScopedStackEvidence) {
        proxyReq.setHeader(PROXY_SCOPED_STACK_NAME_HEADER, req.proxyScopedStackEvidence.stackName);
        proxyReq.setHeader(
          PROXY_SCOPED_STACK_ACTIONS_HEADER,
          formatScopedStackActionsHeader(req.proxyScopedStackEvidence.actions),
        );
      }
      // Strip the ?nodeId= query param so the remote's nodeContextMiddleware
      // doesn't reject the request with 404 ("Node X not found") - the remote
      // has no record of the gateway's node IDs and should treat the request
      // as local. This affects endpoints like EventSource /api/containers/:id/logs
      // that pass nodeId as a query param rather than the x-node-id header.
      if (req.gitopsIdentity !== undefined) {
        // The identity hop already decided this query, including whether the
        // remote is being asked to filter to its own node. Apply it whole so
        // the generic strip below cannot undo that decision.
        const [pathname] = proxyReq.path.split('?');
        proxyReq.path = pathname + (req.gitopsIdentity.query ? `?${req.gitopsIdentity.query}` : '');
        // A remote answering a conditional request with 304 would bypass the
        // hub's rewrite and per-row filtering entirely, so the client is never
        // allowed to ask the remote to revalidate. Identity-hop only: the
        // streaming forwards keep client conditionals, which optimistic-
        // concurrency file writes depend on.
        stripConditionalRequestHeaders(proxyReq);
      } else if (proxyReq.path.includes('nodeId=')) {
        const [pathname, qs] = proxyReq.path.split('?');
        const params = new URLSearchParams(qs || '');
        params.delete('nodeId');
        // Hub-synthesized only; a caller must never smuggle one to a remote.
        params.delete('gitopsLocalTarget');
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
    proxyRes: (proxyRes, req, res) => {
      // The remote answered: release the time-to-headers budget for every
      // response, then keep only the body-idle bound. A stream or download is
      // released entirely from the first byte and keeps its own lifetime.
      noteInteractiveReadHeaders(req, res, proxyRes);
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
      // Hub fleet aggregation is local-only. A successful remote full-stack
      // Apply or update-preview reconcile must drop the hub cache so the next
      // fleet poll does not revive a verified-cleared card from a stale entry.
      const status = proxyRes.statusCode ?? 0;
      if (
        req.method === 'POST'
        && status >= 200
        && status < 300
        && (isFullStackUpdatePath(req.path) || isUpdatePreviewPath(req.path))
      ) {
        invalidateFleetUpdateCache();
      }
      // Successful remote stack DELETE: clear hub grants for this (node, stack)
      // only. Failed / non-2xx responses must preserve assignments. Use the
      // gate-stashed classification: pathRewrite mutates req.url before this
      // callback, so re-running classifyStackApiPath(req.path) would miss.
      if (req.method === 'DELETE' && status >= 200 && status < 300) {
        const route = req.proxyNamedStackRoute;
        if (route?.action === 'stack:delete') {
          try {
            DatabaseService.getInstance().deleteRoleAssignmentsByStack(req.nodeId, route.stackName);
          } catch (cleanupErr) {
            console.warn(
              '[Proxy] Failed to clear role assignments after remote stack delete:',
              getErrorMessage(cleanupErr, 'unknown'),
            );
          }
          // Mute rules for the stack are authored on the hub, so the remote's own
          // delete cleanup cannot reach them.
          removeStackMuteRules(req.nodeId, route.stackName);
        }
      }
    },
    error: (err, req, proxyRes) => {
      // The read deadline aborts the upstream request itself. That abort is not
      // a transport failure to report, and the 504 has already answered, so the
      // error handler must not turn it into a 502 or an audit entry.
      if (interactiveReadDeadlines.get(req)?.fired) return;
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
};

  // The outer gate caches the target on the request before any of these
  // proxies run, and http-proxy-middleware requires the router to return a
  // target. Fail loudly if that invariant ever breaks instead of letting the
  // hop fall back to the placeholder target below.
  const routerTarget = (req: Request): string => {
    const target = req.proxyTarget;
    if (!target) {
      throw new Error('remote proxy router ran without a proxy target');
    }
    return target.apiUrl.replace(/\/$/, '');
  };

  const baseOptions = {
    target: 'http://localhost:0', // placeholder - overridden per-request by router
    changeOrigin: true,
    router: routerTarget,
    // When mounted at app.use('/api/', ...), Express strips the '/api/' prefix from
    // req.url before the middleware sees it. Re-add it so the remote Sencho instance
    // receives the full path (e.g. '/stats' becomes '/api/stats').
    pathRewrite: (path: string) => '/api' + path,
  };

  const createStreamingProxy = (agent?: typeof safeHttpAgent | typeof safeHttpsAgent) =>
    createProxyMiddleware<Request, Response>({ ...baseOptions, ...(agent ? { agent } : {}), on: sharedOn });
  const proxy = createStreamingProxy();
  const safeHttpProxy = createStreamingProxy(safeHttpAgent);
  const safeHttpsProxy = createStreamingProxy(safeHttpsAgent);

  const createUpdateProxy = (agent?: typeof safeHttpAgent | typeof safeHttpsAgent) =>
    createProxyMiddleware<Request, Response>({
      ...baseOptions, ...(agent ? { agent } : {}), selfHandleResponse: true,
      on: {
        ...sharedOn,
        proxyRes: (upstream, req, res) => {
          sharedOn.proxyRes?.(upstream, req, res);
          void handleImageUpdateResponse(upstream, req, res);
        },
      },
    });
  const updateProxy = createUpdateProxy();
  const safeHttpUpdateProxy = createUpdateProxy(safeHttpAgent);
  const safeHttpsUpdateProxy = createUpdateProxy(safeHttpsAgent);

  /**
   * The identity hop: buffers the response so node ids inside it can be
   * corrected to this hub's numbering before the client sees them.
   *
   * Separate from the streaming hop rather than a mode of it, because
   * buffering is exactly what the streaming hop must never do. Logs, event
   * streams, and downloads keep flowing through that one untouched.
   */
  const createIdentityProxy = (agent?: typeof safeHttpAgent | typeof safeHttpsAgent) =>
    createProxyMiddleware<Request, Response>({
    ...baseOptions,
    ...(agent ? { agent } : {}),
    selfHandleResponse: true,
    // Bounded so a remote that sends headers and then stalls cannot pin the
    // buffered body and both sockets indefinitely. No pathFilter: the
    // dispatcher already gated the route, and a second predicate derived from
    // a normalized pathname could disagree and hand a remote request to a
    // local handler.
    proxyTimeout: IDENTITY_PROXY_TIMEOUT_MS,
    on: {
      ...sharedOn,
      proxyRes: (proxyRes, req, res) => {
        // The same header-time release as the streaming hop: this hop buffers
        // the body, so its 30 s proxyTimeout is the idle stall bound, not a
        // reason to keep the read deadline armed after the remote answered.
        noteInteractiveReadHeaders(req, res, proxyRes);
        proxyRes.headers['x-sencho-proxy'] = '1';
        const timing = proxyTimings.get(req);
        if (timing) {
          timing.upstreamStatus = proxyRes.statusCode;
          timing.ttfbMs = Date.now() - timing.startedAt;
        }
        const nodeId = hubNodeIdFor(req);
        handleIdentityResponse(proxyRes, res, {
          transform: (payload) => {
            // Without an id there is nothing to rewrite the remote's numbering
            // to, and passing its ids through unchanged is the exact defect
            // this hop exists to prevent. Refuse rather than answer with
            // identities from another instance's namespace.
            if (nodeId === undefined) throw new Error('proxied request has no node id to rewrite identities to');
            const identity = req.gitopsIdentity;
            if (identity === undefined) throw new Error('identity hop ran without a stashed pre-rewrite path');
            // Correct identities first so the collection filter classifies
            // against this hub's node ids rather than the remote's.
            rewriteIdentityPayload(payload, nodeId);
            return filterRemoteIdentityPayload(
              // No fallback to `req.path`: pathRewrite has already prefixed
              // `/api` by now, so falling back would match no collection and
              // ship every remote row unfiltered under a 200.
              identity.preRewritePath,
              payload,
              requirement => satisfiesGitOpsRead(req, requirement, nodeId),
              nodeId,
            );
          },
          finalizeTiming: (kind) => {
            finalizeProxyTiming(req, isIdentityFailure(kind) ? 'error' : 'ok');
          },
        });
      },
    },
  });
  const identityProxy = createIdentityProxy();
  const safeHttpIdentityProxy = createIdentityProxy(safeHttpAgent);
  const safeHttpsIdentityProxy = createIdentityProxy(safeHttpsAgent);

  return (req: Request, res: Response, next: NextFunction): void => {
    // The `/api/` mount strips the `/api` prefix, so req.path is now `/auth/…`,
    // `/nodes/…`, etc. Gateway-level concerns are always handled locally.
    if (isProxyExemptPath(`/api${req.path}`)) {
      next();
      return;
    }

    // SSO configuration routes are human-session-only. The destination-side
    // rejectApiTokenScope cannot detect the original API token because this
    // proxy replaces incoming credentials with a node-to-node JWT. Reject
    // API-token-authenticated requests here, covering the /sso/config collection
    // and all descendant paths (req.path is post-/api strip). Express matches
    // routes case-insensitively, so this guard must too (the i flag).
    if (/^\/sso\/config(?:\/|$)/i.test(req.path)) {
      if (rejectApiTokenScope(req, res, 'API tokens cannot access SSO configuration.')) {
        return;
      }
    }

    const node = NodeRegistry.getInstance().getNode(req.nodeId);
    if (!node || node.type !== 'remote') {
      next();
      return;
    }

    const target = NodeRegistry.getInstance().getProxyTarget(req.nodeId);
    if (!target) {
      if (node.mode === 'pilot_agent') {
        res.setHeader(REMOTE_READ_FAILURE_HEADER, 'pilot-disconnected');
        res.status(503).json({
          error: `Pilot tunnel to "${node.name}" is disconnected. Operations will resume when the agent reconnects.`,
        });
      } else {
        res.setHeader(REMOTE_READ_FAILURE_HEADER, 'not-configured');
        res.status(503).json({
          error: `Remote node "${node.name}" has no API URL or token configured. Update it in Settings → Nodes.`,
        });
      }
      return;
    }

    const runGatedProxy = async (): Promise<void> => {
      // The read budget covers the whole wait, including any capability probe
      // this hop must run before it can forward. Time already spent on the gates
      // is subtracted from the hop's own deadline, so a slow /api/meta probe and
      // a silent read still add up to one bounded wait instead of two.
      const readBudgetMs = remoteReadTimeoutMs(req.method, req.path);
      const gatesStartedAt = Date.now();
      const remainingReadBudgetMs = (): number | null => {
        if (readBudgetMs === null) return null;
        return Math.max(250, readBudgetMs - (Date.now() - gatesStartedAt));
      };

      if (node.mode === 'proxy') {
        try {
          await assertSafeOutboundUrl(target.apiUrl);
        } catch (error: unknown) {
          if (!(error instanceof UnsafeOutboundTargetError)) throw error;
          const message = error.reason === 'blocked'
            ? 'Remote node target is not allowed.'
            : 'Remote node target host could not be resolved.';
          console.warn(`[Proxy] Refused remote target for node ${node.id}: ${error.reason}`);
          res.setHeader(REMOTE_READ_FAILURE_HEADER, 'refused');
          res.status(502).json({ error: message });
          return;
        }
      }

      if (isStackDownWithRemoveVolumes(req)) {
        const supported = await remoteAdvertisesCapability(req.nodeId, STACK_DOWN_REMOVE_VOLUMES_CAPABILITY);
        if (!supported) {
          res.status(400).json({ error: 'Volume removal is not supported on this node' });
          return;
        }
      }

      if (isUnacknowledgedStackDelete(req)) {
        const supported = await remoteAdvertisesCapability(req.nodeId, STACK_DELETE_PRUNE_VOLUMES_CAPABILITY);
        if (!supported) {
          res.status(400).json({
            error: 'This node cannot guarantee volumes are preserved on delete. Upgrade it before deleting this stack.',
            code: 'capability_unavailable',
          });
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

      // Mixed-version RBAC gate (non-admin only). Runs before alert body
      // buffering so an unauthorized client cannot force unbounded memory use.
      //
      // Tri-state: a node that did not answer proved nothing about its version,
      // so it is reported as unavailable rather than as an old node. Only a
      // reachable remote that answered without the capability is a version
      // problem, and only that answer deserves the upgrade message.
      if (req.user?.role !== 'admin') {
        const rbac = await probeRemoteCapability(req.nodeId, CROSS_NODE_RBAC_CAPABILITY);
        if (rbac.kind === 'unreachable') {
          // Only a transport failure establishes silence. An HTTP error or a
          // malformed body means the node answered, and "did not answer" would
          // send the operator to the wrong fix.
          const silent = rbac.detail === 'transport_failure';
          res.setHeader(REMOTE_READ_FAILURE_HEADER, silent ? 'unreachable' : 'unverified');
          res.status(503).json({
            error: rbacUnavailableMessage(node.name, rbac.detail),
            code: silent ? 'remote_unreachable' : 'remote_unverified',
            retryable: true,
          });
          return;
        }
        if (rbac.kind === 'unsupported') {
          res.status(403).json({
            error: `Remote node "${node.name}" is running a version that does not enforce per-user permissions. Upgrade it before non-admin users can act on it.`,
          });
          return;
        }
      }

      // Named-stack hub pre-check + optional scoped-evidence elevation.
      const classified = classifyStackApiPath(req.method, req.path);
      if (classified.kind === 'unknown-named') {
        res.status(403).json({ error: 'Permission denied.', code: 'PERMISSION_DENIED' });
        return;
      }
      if (classified.kind === 'named-stack') {
        if (!checkPermission(req, classified.action, 'stack', classified.stackName)) {
          res.status(403).json({ error: 'Permission denied.', code: 'PERMISSION_DENIED' });
          return;
        }
        // Stash before pathRewrite so proxyRes DELETE cleanup can see the route.
        req.proxyNamedStackRoute = {
          stackName: classified.stackName,
          action: classified.action,
        };
        const globalRole = req.user?.role;
        const globalGrantsPrimary =
          globalRole === 'admin'
          || (globalRole != null && (ROLE_PERMISSIONS[globalRole]?.includes(classified.action) ?? false));
        if (!globalGrantsPrimary) {
          const evidenceSupported = await remoteAdvertisesCapability(
            req.nodeId,
            SCOPED_STACK_AUTH_EVIDENCE_CAPABILITY,
          );
          if (!evidenceSupported) {
            res.status(403).json({
              error: `Remote node "${node.name}" does not support scoped stack authorization. Upgrade it before scoped users can act on it.`,
            });
            return;
          }
          if (!req.user) {
            res.status(403).json({ error: 'Permission denied.', code: 'PERMISSION_DENIED' });
            return;
          }
          const actions = scopedActionsForStack(req.user.userId, req.nodeId, classified.stackName);
          req.proxyScopedStackEvidence = {
            stackName: classified.stackName,
            actions,
          };
        }
      }

      // POST /alerts bodies are not on req.body for remote hops (JSON parsing
      // is skipped so the stream can be piped). Buffer once under the same
      // 100 KB cap as express.json(), gate on service_name, then rewrite
      // rawBody in on.proxyReq. Compressed bodies are rejected: the hub cannot
      // inspect them, and treating parse failure as unscoped would bypass the
      // mixed-version gate.
      if (isAlertCreateRoute(req)) {
        if (hasNonIdentityContentEncoding(req)) {
          await drainRequestBody(req);
          res.status(415).json({
            error: 'Compressed request bodies are not supported for remote alert creates',
            code: 'encoding_unsupported',
          });
          return;
        }
        try {
          req.rawBody = await bufferRequestBody(req, ALERT_PROXY_BODY_LIMIT);
        } catch (err) {
          const status = Number((err as { status?: number }).status);
          if (status === 413) {
            console.error('[remoteNodeProxy] alert body rejected as too large:', err);
            res.status(413).json({ error: 'Alert payload too large', code: 'entity_too_large' });
            return;
          }
          if (status === 400) {
            console.error('[remoteNodeProxy] alert body incomplete:', err);
            res.status(400).json({ error: 'Incomplete request body' });
            return;
          }
          throw err;
        }
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

      // Settings-write pre-auth gate: when a non-admin, non-global-node-admin
      // user writes settings on a remote node, the remote only sees the global
      // role header and cannot verify scoped assignments. Check hub-side first
      // and elevate PROXY_ROLE_HEADER to node-admin when the scoped check passes.
      if (isSettingsWrite(req) && req.user?.role !== 'admin' && req.user?.role !== 'node-admin') {
        if (hasNonIdentityContentEncoding(req)) {
          await drainRequestBody(req);
          res.status(415).json({
            error: 'Compressed request bodies are not supported for remote settings writes',
            code: 'encoding_unsupported',
          });
          return;
        }
        try {
          req.rawBody = await bufferRequestBody(req, SETTINGS_PROXY_BODY_LIMIT);
        } catch (err) {
          const status = Number((err as { status?: number }).status);
          if (status === 413) {
            res.status(413).json({ error: 'Settings payload too large', code: 'entity_too_large' });
            return;
          }
          if (status === 400) {
            res.status(400).json({ error: 'Incomplete request body' });
            return;
          }
          throw err;
        }
        const needed = settingsBodyPermissions(req.rawBody);
        // Fail-closed on empty/unparseable body: require hub-side node:manage on
        // the target node (mirrors requireSettingsWritePermission's empty-keys
        // branch in routes/settings.ts:62-68). A user with no scoped grant is
        // denied; a user with a scoped grant passes through elevated.
        let preAuthOk = true;
        if (needed.length === 0) {
          preAuthOk = checkNodeManageOnHub(req);
        } else {
          for (const action of needed) {
            const ok = action === 'node:manage'
              ? checkNodeManageOnHub(req)
              : checkPermission(req, action);
            if (!ok) {
              preAuthOk = false;
              break;
            }
          }
        }
        if (!preAuthOk) {
          res.status(403).json({ error: 'Permission denied.', code: 'PERMISSION_DENIED' });
          return;
        }
        req.proxyElevatedRole = 'node-admin';
      }

      // Alerts POST scoped-evidence gate: when a non-admin, non-node-admin user
      // creates a stack-scoped alert on a remote node, forward the scoped grant
      // as evidence so the remote can authorize the write. The body was already
      // buffered by the isAlertCreateRoute block above; this gate only inspects
      // the stack_name field from the buffered JSON. Non-stack-scoped creates
      // (no stack_name in body) pass through without evidence.
      if (isAlertCreateRoute(req) && req.user?.role !== 'admin' && req.user?.role !== 'node-admin') {
        if (!userHasGlobalStackEdit(req)) {
          const stackName = req.rawBody ? parseBodyStackName(req.rawBody) : null;
          if (stackName === undefined) {
            // Body is non-empty but not valid JSON; client error, not auth.
            console.error('[remoteNodeProxy] alert body is not valid JSON');
            res.status(400).json({ error: 'Request body is not valid JSON' });
            return;
          }
          if (stackName) {
            if (!await remoteSupportsScopedStackEdit(req, res, node)) return;
            if (!checkPermission(req, 'stack:edit', 'stack', stackName)) {
              res.status(403).json({ error: 'Permission denied.', code: 'PERMISSION_DENIED' });
              return;
            }
            attachScopedStackEditEvidence(req, stackName);
          }
        }
      }

      // Auto-heal POST scoped-evidence gate: same pattern as alerts but
      // auto-heal has no pre-existing body buffering, so this gate handles
      // its own encoding rejection and buffering.
      if (isAutoHealCreateRoute(req) && req.user?.role !== 'admin' && req.user?.role !== 'node-admin') {
        if (!userHasGlobalStackEdit(req)) {
          const rawBody = await bufferProxyJsonBody(req, res, PROXY_JSON_BODY_LIMIT, {
            logPrefix: '[remoteNodeProxy] auto-heal',
            encodingError: 'Compressed request bodies are not supported for remote auto-heal creates',
            tooLargeError: 'Auto-heal payload too large',
          });
          if (!rawBody) return;
          req.rawBody = rawBody;
          const stackName = parseBodyStackName(rawBody);
          if (stackName === undefined) {
            console.error('[remoteNodeProxy] auto-heal body is not valid JSON');
            res.status(400).json({ error: 'Request body is not valid JSON' });
            return;
          }
          if (stackName) {
            if (!await remoteSupportsScopedStackEdit(req, res, node)) return;
            if (!checkPermission(req, 'stack:edit', 'stack', stackName)) {
              res.status(403).json({ error: 'Permission denied.', code: 'PERMISSION_DENIED' });
              return;
            }
            attachScopedStackEditEvidence(req, stackName);
          }
        }
      }

      // POST /git-sources/ssh-host-key scoped-evidence gate: stack_name lives in
      // the JSON body, so classifyStackApiPath cannot authorize the edit flow.
      if (isSshHostKeyProbeRoute(req)) {
        const rawBody = await bufferProxyJsonBody(req, res, PROXY_JSON_BODY_LIMIT, {
          logPrefix: '[remoteNodeProxy] ssh-host-key',
          encodingError: 'Compressed request bodies are not supported for remote SSH host key probes',
          tooLargeError: 'SSH host key probe payload too large',
        });
        if (!rawBody) return;
        req.rawBody = rawBody;
        const stackName = parseBodyStackName(rawBody);
        if (stackName === undefined) {
          console.error('[remoteNodeProxy] ssh-host-key body is not valid JSON');
          res.status(400).json({ error: 'Request body is not valid JSON' });
          return;
        }
        if (stackName) {
          if (!checkPermission(req, 'stack:edit', 'stack', stackName)) {
            res.status(403).json({ error: 'Permission denied.', code: 'PERMISSION_DENIED' });
            return;
          }
          if (
            req.user?.role !== 'admin'
            && req.user?.role !== 'node-admin'
            && !userHasGlobalStackEdit(req)
          ) {
            if (!await remoteSupportsScopedStackEdit(req, res, node)) return;
            attachScopedStackEditEvidence(req, stackName);
          }
        } else if (!checkPermission(req, 'stack:create')) {
          res.status(403).json({ error: 'Permission denied.', code: 'PERMISSION_DENIED' });
          return;
        }
      }

      // Node-wide image refresh elevation gate: when a non-admin, non-node-admin
      // user triggers a manual refresh on a remote node, check the hub-side
      // scoped node:manage grant and elevate PROXY_ROLE_HEADER so the remote
      // sees the user as node-admin for this hop (matching the pattern used
      // for scoped Settings writes).
      if (isImageRefreshNodeWide(req) && req.user?.role !== 'admin' && req.user?.role !== 'node-admin') {
        if (!checkNodeManageOnHub(req)) {
          res.status(403).json({ error: 'Permission denied.', code: 'PERMISSION_DENIED' });
          return;
        }
        req.proxyElevatedRole = 'node-admin';
      }

      // Target settings, security and the recheck-target alias stay on the target.
      // Exact image reads, previews and refreshes use the hub's authority.
      const overlayPreview = (req.method === 'GET' || req.method === 'POST')
        && /^\/stacks\/[^/]+\/update-preview\/?$/i.test(req.path);
      const overlayRead = req.method === 'GET' && /^\/image-updates(?:\/detail)?\/?$/i.test(req.path);
      const overlayRefresh = req.method === 'POST' && /^\/image-updates\/refresh(?:\/[^/]+)?\/?$/i.test(req.path);
      if (overlayRead || overlayRefresh || overlayPreview) {
        const capability = await probeRemoteCapability(req.nodeId, 'remote-image-inspect-v1');
        if (capability.kind === 'supported') {
          if (req.method === 'POST') hubImageUpdateJsonParser(req, res, next);
          else next();
          return;
        }
      }

      if (req.method === 'POST' && /^\/auto-update\/execute\/?$/i.test(req.path)) {
        const inspect = await probeRemoteCapability(req.nodeId, 'remote-image-inspect-v1');
        const execute = inspect.kind === 'supported'
          ? await probeRemoteCapability(req.nodeId, 'remote-auto-update-checked-v1') : null;
        if (execute?.kind === 'supported') {
          hubImageUpdateJsonParser(req, res, next);
          return;
        }
      }

      // Registry credential delivery: when the remote supports the exact-ref
      // contract, run hop-1 discover and either attach the envelope to the
      // forwarded JSON body or refuse per the delivery matrix; a compressed
      // body is refused with 415 before the hop runs. Unsupported and
      // unreachable remotes forward unchanged.
      const deliveryApiPath = `/api${req.path}`;
      if (RegistryDeliveryService.getInstance().isDeliveryEligibleRoute(req.method, deliveryApiPath)) {
        const gate = await evaluateRegistryDeliveryProxyGate(
          req,
          res,
          req.nodeId,
          req.method,
          deliveryApiPath,
        );
        if (gate.outcome === 'stop') {
          return;
        }
        if (gate.outcome === 'run-delivery') {
          if (hasNonIdentityContentEncoding(req)) {
            await drainRequestBody(req);
            res.status(415).json({
              error: 'Compressed request bodies are not supported for remote registry delivery',
              code: 'encoding_unsupported',
            });
            return;
          }
          const routeClass = classifyRegistryDeliveryRouteClass(req.method, deliveryApiPath);
          if (routeClass) {
            const bodyLimit = getRegistryDeliveryTotalBodyLimit(routeClass);
            try {
              req.rawBody = await bufferRequestBody(req, bodyLimit);
            } catch (err) {
              const status = Number((err as { status?: number }).status);
              if (status === 413) {
                res.status(413).json({ error: 'Request body too large for registry delivery' });
                return;
              }
              if (status === 400) {
                res.status(400).json({ error: 'Incomplete request body' });
                return;
              }
              throw err;
            }
            // Create-from-git authorization gate. Hop-1 discovery runs a full
            // git fetch on the target with the caller's credentials, before
            // the target's own permission check. Verify the caller on the hub
            // first, mirroring the direct route's checks; the target still
            // enforces both. Only the create-from-git stage carries a fetch.
            const stage = classifyRegistryDeliveryOp(req.method, deliveryApiPath).stage;
            if (stage === 'from-git-deploy-now' && !authorizeFromGitOnHub(req, res, req.rawBody)) {
              return;
            }
            const deliveryResult = await augmentRemoteProxyWithRegistryDelivery(
              req,
              req.nodeId,
              node,
              target,
              req.rawBody,
              gate.probe,
            );
            if (!deliveryResult.forward) {
              if (req.registryDeliveryAbortController?.signal.aborted) {
                return;
              }
              res.status(deliveryResult.status).json({
                error: deliveryResult.error,
                code: deliveryResult.code,
              });
              return;
            }
          }
        }
      }

      req.proxyTarget = target;

      // Identity routes are reworked before the hop, not during it: a request
      // naming a node this instance cannot answer for is refused here rather
      // than forwarded, so the remote never answers about itself a question
      // that was asked about somebody else.
      if (isGitOpsIdentityJsonRoute(req.path, req.method)) {
        const prepared = prepareIdentityQuery(
          new URLSearchParams(req.url.split('?')[1] ?? ''),
          req.path,
          hubNodeIdFor(req),
        );
        if (prepared.kind === 'refuse') {
          res.status(400).json({ error: prepared.error, code: 'gitops_history_node_mismatch' });
          return;
        }
        req.gitopsIdentity = { query: prepared.search.toString(), preRewritePath: req.path };
        beginProxyTiming(req, res);
        // The identity hop's 30 s proxyTimeout bounds a stalled body. It is not a
        // UX deadline: a Git sources or drift page is hydration like any other, so
        // a GET that answers a page is on the interactive clock here too. The
        // drift re-check is a POST and stays off it.
        const identityBudgetMs = remainingReadBudgetMs();
        if (identityBudgetMs !== null) {
          armInteractiveReadDeadline(req, res, node.name, identityBudgetMs);
        }
        const selectedIdentityProxy = node.mode === 'pilot_agent'
          ? identityProxy
          : target.apiUrl.startsWith('https:') ? safeHttpsIdentityProxy : safeHttpIdentityProxy;
        selectedIdentityProxy(req, res, next);
        return;
      }

      beginProxyTiming(req, res);
      if (req.registryDeliveryAbortController?.signal.aborted) {
        return;
      }
      // Ordinary interactive reads are bounded; work and streams are not. The
      // budget already includes any gate time above, so only the hop that
      // actually answers a page is on the clock.
      const hopBudgetMs = remainingReadBudgetMs();
      if (hopBudgetMs !== null) {
        armInteractiveReadDeadline(req, res, node.name, hopBudgetMs);
      }
      if (req.method === 'POST' && /^\/stacks\/[^/]+\/update\/?$/i.test(req.path)
        && (await probeRemoteCapability(req.nodeId, 'remote-image-inspect-v1')).kind === 'supported') {
        const selectedUpdateProxy = node.mode === 'pilot_agent'
          ? updateProxy
          : target.apiUrl.startsWith('https:') ? safeHttpsUpdateProxy : safeHttpUpdateProxy;
        selectedUpdateProxy(req, res, next);
        return;
      }
      const selectedProxy = node.mode === 'pilot_agent'
        ? proxy
        : target.apiUrl.startsWith('https:') ? safeHttpsProxy : safeHttpProxy;
      selectedProxy(req, res, next);
    };

    runGatedProxy().catch(next);
  };
}

/**
 * Name the mixed-version RBAC refusal by what the probe actually observed. An
 * HTTP error or a malformed body is not silence: saying the node "did not
 * answer" would send the operator to check a node that answered.
 */
function rbacUnavailableMessage(
  nodeName: string,
  detail: 'no_target' | 'transport_failure' | 'http_failure' | 'malformed',
): string {
  switch (detail) {
    case 'http_failure':
      return `Remote node "${nodeName}" answered with an error, so its permission model could not be verified. Try again once the node is healthy.`;
    case 'malformed':
      return `Remote node "${nodeName}" answered with a response this instance could not read, so its permission model could not be verified. Try again once the node is healthy.`;
    case 'no_target':
      return `Remote node "${nodeName}" has no reachable API target, so its permission model could not be verified. Check the node in Settings → Nodes.`;
    case 'transport_failure':
      return `Remote node "${nodeName}" did not answer, so its permission model could not be verified. Try again when the node is reachable.`;
  }
}

/** Max request body size for buffered settings writes (same as ALERT_PROXY_BODY_LIMIT). */
const SETTINGS_PROXY_BODY_LIMIT = 100 * 1024;

/**
 * True when the request configures a remote node's own settings and must run
 * the node-admin elevation check on the hop (path is post-/api strip).
 */
function isSettingsWrite(req: Request): boolean {
  if (req.method !== 'POST' && req.method !== 'PATCH') return false;
  if (/^\/settings\/?$/.test(req.path)) return true;
  // Polling cadence is configured per instance, so the hub PATCH must reach
  // the target node's own route; classify it like a settings write so the
  // same node-admin elevation check applies before the hop.
  return /^\/git-sources\/polling\/?$/.test(req.path);
}

/**
 * Hub-side `node:manage` resolve against the active node so scoped Node Admin
 * grants on the target remote node are detected before the hop.
 */
function checkNodeManageOnHub(req: Request): boolean {
  if (typeof req.nodeId === 'number') {
    return checkPermission(req, 'node:manage', 'node', String(req.nodeId));
  }
  return checkPermission(req, 'node:manage');
}

/**
 * Hub-side authorization for create-from-git before hop-1 discovery runs.
 * The permission check runs first, regardless of body shape, matching the
 * direct route: stack:create globally, then stack:deploy when the request
 * asks to deploy. Returns false after answering 403 when the caller is not
 * authorized. For an authorized caller, a body without a stack name skips
 * only the deploy sub-check; the target's field validation answers before
 * its own fetch.
 */
function authorizeFromGitOnHub(req: Request, res: Response, rawBody: Buffer): boolean {
  if (!checkPermission(req, 'stack:create')) {
    res.status(403).json({ error: 'Permission denied.', code: 'PERMISSION_DENIED' });
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf-8'));
  } catch {
    return true;
  }
  if (parsed === null || typeof parsed !== 'object') return true;
  const body = parsed as Record<string, unknown>;
  const stackName = typeof body.stack_name === 'string' ? body.stack_name : null;
  const deployRequested = body.deploy_now === true || body.auto_deploy_on_apply === true;
  if (stackName && deployRequested && !checkPermission(req, 'stack:deploy', 'stack', stackName)) {
    res.status(403).json({ error: 'Permission denied.', code: 'PERMISSION_DENIED' });
    return false;
  }
  return true;
}

/**
 * Extract the set of required PermissionAction values from a buffered settings
 * body. Returns the distinct actions for a valid body, or an empty array when
 * the body is empty or JSON.parse fails (caller must then fall back to requiring
 * checkNodeManageOnHub, fail-closed).
 */
function settingsBodyPermissions(rawBody: Buffer): PermissionAction[] {
  if (rawBody.length === 0) return [];
  try {
    const parsed = JSON.parse(rawBody.toString('utf-8')) as Record<string, unknown>;
    // POST /api/settings sends { key, value }; PATCH sends a flat key/value map.
    const keys = typeof parsed.key === 'string' ? [parsed.key] : Object.keys(parsed);
    if (keys.length === 0) return [];
    const needed = new Set<PermissionAction>();
    for (const key of keys) {
      const action = SETTING_WRITE_PERMISSIONS[key];
      if (action) needed.add(action);
    }
    return [...needed];
  } catch {
    return [];
  }
}

/** POST /stacks/:stackName/down with ?removeVolumes=true (path is post-/api strip). */
function isStackDownWithRemoveVolumes(req: Request): boolean {
  if (req.method !== 'POST') return false;
  if (!/^\/stacks\/[^/]+\/down$/.test(req.path)) return false;
  return req.query.removeVolumes === 'true';
}

/**
 * DELETE /stacks/:stackName without an explicit ?pruneVolumes=true (path is post-/api
 * strip). downStack() hardcoded --volumes on every delete before stack-delete-prune-volumes
 * existed, unlike runDown which was already volume-safe. So an unacknowledged delete
 * forwarded to a remote lacking the capability would silently destroy volumes the
 * operator asked to keep, with no local route or UI check able to catch it. Gate the
 * unacknowledged path here; an explicit pruneVolumes=true matches what an unsupported
 * remote will do anyway and needs no gate.
 */
function isUnacknowledgedStackDelete(req: Request): boolean {
  if (req.method !== 'DELETE') return false;
  if (!/^\/stacks\/[^/]+\/?$/.test(req.path)) return false;
  return req.query.pruneVolumes !== 'true';
}

/** Nested service update/restore/recovery routes (path is post-/api strip). */
function isServiceScopedUpdateRoute(req: Request): boolean {
  if (req.method === 'GET') {
    return /^\/stacks\/[^/]+\/services\/[^/]+\/recovery$/.test(req.path)
      || /^\/stacks\/[^/]+\/recoveries$/.test(req.path);
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

/** Max request body size for buffered JSON proxy gates (same as express.json()). */
const PROXY_JSON_BODY_LIMIT = 100 * 1024;

/** Same default as express.json(); remote alert creates must not exceed it. */
const ALERT_PROXY_BODY_LIMIT = PROXY_JSON_BODY_LIMIT;

/** POST /auto-heal/policies (path is post-/api strip). */
function isAutoHealCreateRoute(req: Request): boolean {
  return req.method === 'POST' && /^\/auto-heal\/policies\/?$/.test(req.path);
}

/** POST /git-sources/ssh-host-key (path is post-/api strip). */
function isSshHostKeyProbeRoute(req: Request): boolean {
  return req.method === 'POST' && /^\/git-sources\/ssh-host-key\/?$/.test(req.path);
}

/** Node-wide refresh and target-scanner alias share the same permission gate. */
function isImageRefreshNodeWide(req: Request): boolean {
  return req.method === 'POST' && /^\/image-updates\/(?:refresh|recheck-target)\/?$/i.test(req.path);
}

/**
 * Extract the stack_name from a buffered JSON POST body.
 * Returns a valid stack name, `null` when the field is absent or
 * invalid (pass-through, remote enforces), or `undefined` when the
 * body is not valid JSON (fail-closed, callers must 403).
 */
function parseBodyStackName(rawBody: Buffer): string | null | undefined {
  if (rawBody.length === 0) return null;
  try {
    const parsed = JSON.parse(rawBody.toString('utf-8')) as { stack_name?: unknown };
    const raw = typeof parsed.stack_name === 'string' ? parsed.stack_name.trim() : '';
    if (!raw || !isValidStackName(raw)) return null;
    return raw;
  } catch {
    return undefined;
  }
}

/** Max time to wait for leftover body bytes after a size/encoding reject. */
const DRAIN_TIMEOUT_MS = 5_000;

function userHasGlobalStackEdit(req: Request): boolean {
  return req.user?.role != null
    && (ROLE_PERMISSIONS[req.user.role]?.includes('stack:edit') ?? false);
}

async function remoteSupportsScopedStackEdit(
  req: Request,
  res: Response,
  node: { name: string },
): Promise<boolean> {
  const evidenceSupported = await remoteAdvertisesCapability(
    req.nodeId,
    SCOPED_STACK_AUTH_EVIDENCE_CAPABILITY,
  );
  if (!evidenceSupported) {
    res.status(403).json({
      error: `Remote node "${node.name}" does not support scoped stack authorization. Upgrade it before scoped users can act on it.`,
    });
    return false;
  }
  return true;
}

function attachScopedStackEditEvidence(req: Request, stackName: string): void {
  req.proxyScopedStackEvidence = { stackName, actions: ['stack:edit'] };
}

async function bufferProxyJsonBody(
  req: Request,
  res: Response,
  limit: number,
  labels: { logPrefix: string; encodingError: string; tooLargeError: string },
): Promise<Buffer | null> {
  if (hasNonIdentityContentEncoding(req)) {
    await drainRequestBody(req);
    res.status(415).json({ error: labels.encodingError, code: 'encoding_unsupported' });
    return null;
  }
  try {
    return await bufferRequestBody(req, limit);
  } catch (err) {
    const status = Number((err as { status?: number }).status);
    if (status === 413) {
      console.error(`${labels.logPrefix} body rejected as too large:`, err);
      res.status(413).json({ error: labels.tooLargeError, code: 'entity_too_large' });
      return null;
    }
    if (status === 400) {
      console.error(`${labels.logPrefix} body incomplete:`, err);
      res.status(400).json({ error: 'Incomplete request body' });
      return null;
    }
    throw err;
  }
}

/** Error with HTTP status for the alert-body gate catch mapper. */
function alertBodyError(message: string, status: number): Error {
  return Object.assign(new Error(message), { status, expose: true });
}

/** True when Content-Encoding is present and not identity (gzip/deflate/br/…). */
function hasNonIdentityContentEncoding(req: Request): boolean {
  const raw = req.headers['content-encoding'];
  if (raw == null) return false;
  const value = Array.isArray(raw) ? raw.join(',') : raw;
  return value.split(',').some((part) => {
    const encoding = part.trim().toLowerCase();
    return encoding.length > 0 && encoding !== 'identity';
  });
}

/** True when the buffered JSON alert body targets a specific Compose service. */
function alertCreateHasScopedService(rawBody: Buffer): boolean {
  if (rawBody.length === 0) return false;
  try {
    const parsed = JSON.parse(rawBody.toString('utf-8')) as { service_name?: unknown };
    return typeof parsed.service_name === 'string' && parsed.service_name.trim() !== '';
  } catch {
    // Identity-encoded non-JSON is forwarded as-is; the remote rejects it.
    // Encoded bodies never reach here (rejected earlier).
    return false;
  }
}

/**
 * Consume remaining request bytes (or wait for abort/close) so the response
 * can flush without leaving the socket half-open. Does not buffer into memory.
 * Caps wait time so a stalled or endless chunked stream cannot hang the gate.
 */
function drainRequestBody(req: Request): Promise<void> {
  return new Promise((resolve) => {
    if (req.readableEnded || req.destroyed) {
      resolve();
      return;
    }
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('end', done);
      req.off('error', done);
      req.off('aborted', done);
      req.off('close', done);
      resolve();
    };
    // Bound hang time: destroy after timeout so mid-stream rejects still settle.
    const timer = setTimeout(() => {
      if (!req.destroyed) req.destroy();
      done();
    }, DRAIN_TIMEOUT_MS);
    req.resume();
    req.once('end', done);
    req.once('error', done);
    req.once('aborted', done);
    req.once('close', done);
  });
}

/**
 * Buffer the request so a capability gate can inspect JSON without leaving
 * http-proxy with an already-ended empty stream. Enforces `limit` on both
 * declared Content-Length and streamed accumulation.
 */
async function bufferRequestBody(req: Request, limit: number): Promise<Buffer> {
  if (req.rawBody) {
    if (req.rawBody.length > limit) {
      throw alertBodyError('Alert payload too large', 413);
    }
    return req.rawBody;
  }
  if (req.readableEnded) return Buffer.alloc(0);

  const declared = Number.parseInt(String(req.headers['content-length'] ?? ''), 10);
  if (Number.isFinite(declared) && declared > limit) {
    // Reject immediately so the client gets a structured 413; drain leftover
    // bytes in the background so the socket can close without holding the gate.
    void drainRequestBody(req);
    throw alertBodyError('Alert payload too large', 413);
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const finish = (buf: Buffer) => settle(() => resolve(buf));
    const fail = (err: Error) => settle(() => reject(err));

    const onData = (chunk: Buffer) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buf.length;
      if (total > limit) {
        chunks.length = 0;
        // fail() removes listeners; drain leftover bytes so the socket can close.
        fail(alertBodyError('Alert payload too large', 413));
        void drainRequestBody(req);
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => finish(Buffer.concat(chunks));
    const onError = (err: Error) => fail(err);
    const onAborted = () => fail(alertBodyError('Client aborted request body', 400));
    const onClose = () => {
      if (!settled && !req.readableEnded) {
        fail(alertBodyError('Client closed request before body finished', 400));
      }
    };

    function cleanup(): void {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
    }

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
  });
}
