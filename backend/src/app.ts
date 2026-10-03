import express, { type Request, type Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import helmet from 'helmet';
import { globalApiLimiter, pollingLimiter } from './middleware/rateLimiters';
import { conditionalJsonParser } from './middleware/jsonParser';
import { nodeContextMiddleware } from './middleware/nodeContext';
import { isTrustedProxyPeer, logTrustedProxyConfiguration } from './helpers/trustedProxyCidrs';
import { createTrustedProxyWarning } from './middleware/trustedProxyWarning';
import { normalizeAcceptEncoding } from './middleware/normalizeAcceptEncoding';
import './types/express';

/**
 * Build an Express app with the full middleware pipeline installed.
 *
 * Canonical middleware order (20 steps). Do not reorder without re-running the
 * regression checklist in `docs/internal/architecture/middleware-order.md`.
 *
 *   1.  trust proxy + trusted-proxy policy log
 *   2.  trustedProxyWarning
 *   3.  helmet
 *   4.  cors
 *   5.  normalizeAcceptEncoding
 *   6.  compression
 *   7.  cookieParser
 *   8.  globalApiLimiter (at /api)
 *   9.  pollingLimiter (at /api)
 *   10. conditionalJsonParser
 *   11. nodeContextMiddleware
 *   12. authGate (at /api)                -- registered in index.ts
 *   13. auditLog (at /api)                -- registered in index.ts
 *   14. enforceApiTokenScope (at /api)    -- registered in index.ts
 *   15. hubOnlyGuard (at /api)            -- middleware/hubOnlyGuard.ts, registered in index.ts
 *   16. registryDeliveryMiddleware (at /api) -- middleware/registryDelivery.ts, registered in index.ts
 *   17. createRemoteProxyMiddleware       -- proxy/remoteNodeProxy.ts, registered in index.ts
 *   18. routes                            -- registered in index.ts from routes/*
 *   19. static serving + SPA fallback     -- registered in index.ts
 *   20. errorHandler                      -- registered in index.ts
 *
 * Steps 12 to 15 and 17 must run after the public auth routers (meta, auth,
 * mfa, sso) are registered so those routes stay reachable without a session
 * cookie. index.ts mounts those public routers before step 12 to preserve
 * that invariant.
 */
export function createApp(): express.Express {
  const app = express();

  // 1. Trust forwarding headers only from explicitly configured proxy peers.
  // Log the effective policy once at boot so a missing or invalid list does
  // not silently change how client addresses and schemes are resolved.
  app.set('trust proxy', (address: string) => isTrustedProxyPeer(address));
  logTrustedProxyConfiguration();

  // 2. Warn once per untrusted peer when forwarding headers arrive that the
  // policy is ignoring, so a reverse proxy missing from the list is visible.
  app.use(createTrustedProxyWarning());

  // 3. Security headers.
  // crossOriginEmbedderPolicy: disabled because Monaco editor workers lack COEP headers.
  // hsts: disabled. HSTS must only be set over HTTPS; enabling over HTTP
  //   permanently breaks browser access for 1 year.
  // contentSecurityPolicy.upgradeInsecureRequests: explicitly null. Helmet 8
  //   merges custom directives with its defaults, which include this directive.
  //   It tells browsers to silently upgrade every HTTP sub-resource fetch to
  //   HTTPS; on a plain-HTTP self-hosted deployment this causes every JS/CSS
  //   asset to fail with ERR_SSL_PROTOCOL_ERROR, producing a blank page.
  //   Setting null is the Helmet 8 API to remove a default directive.
  app.use(helmet({
    crossOriginEmbedderPolicy: false,
    // COOP is only meaningful over HTTPS. Over HTTP the browser logs a warning
    // and ignores it, creating noise in the console with no security benefit.
    crossOriginOpenerPolicy: false,
    // Origin-Agent-Cluster is only meaningful over HTTPS. Over plain HTTP the
    // browser logs a warning and ignores it. Disabling removes console noise.
    originAgentCluster: false,
    hsts: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        fontSrc: ["'self'", 'https:', 'data:'],
        formAction: ["'self'"],
        frameAncestors: ["'self'"],
        // img-src: 'https:' is required for App Store template icons hosted on
        // external registries (e.g. raw.githubusercontent.com).
        imgSrc: ["'self'", 'data:', 'https:'],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", 'https:', "'unsafe-inline'"],
        // connect-src: explicit 'self' covers same-origin fetch/XHR/WebSocket.
        // ws: and wss: are included for WebSocket connections in any scheme context.
        connectSrc: ["'self'", 'ws:', 'wss:'],
        // worker-src: Monaco editor creates Web Workers via blob: URLs for
        // language services (syntax highlighting, intellisense). Without blob:
        // they silently fail.
        workerSrc: ["'self'", 'blob:'],
        upgradeInsecureRequests: null,
      },
    },
  }));

  // 4. CORS: production restricts to FRONTEND_URL; dev mirrors the request
  // origin so Vite's dev server works.
  const corsOrigin = process.env.NODE_ENV === 'production'
    ? (process.env.FRONTEND_URL || false)
    : true;
  app.use(cors({
    origin: corsOrigin,
    credentials: true,
  }));

  // 5. Drop unknown Accept-Encoding tokens (e.g. `zstd` from Chromium 123+)
  // before compression negotiates. See middleware/normalizeAcceptEncoding.ts
  // for the symptom this prevents.
  app.use(normalizeAcceptEncoding);

  // 6. Compression. SSE streams (Content-Type: text/event-stream) MUST NOT be
  // compressed because compression buffers output and would delay event delivery
  // until a flush, breaking live log and status streams.
  app.use(compression({
    filter: (req: Request, res: Response) => {
      const ct = res.getHeader('Content-Type');
      if (typeof ct === 'string' && ct.includes('text/event-stream')) {
        return false;
      }
      return compression.filter(req, res);
    },
  }));

  // 7. Cookie parser must run before the rate limiters so the hybrid key
  // generator can read req.cookies for per-user rate limit bucketing.
  app.use(cookieParser());

  // 8-9. Tiered rate limiting (see middleware/rateLimiters.ts for the model).
  app.use('/api/', globalApiLimiter);
  app.use('/api/', pollingLimiter);

  // 10. Parse JSON on local requests; preserve the raw stream for remote proxy.
  app.use(conditionalJsonParser);

  // 11. Resolve req.nodeId and short-circuit requests to deleted nodes.
  app.use(nodeContextMiddleware);

  return app;
}
