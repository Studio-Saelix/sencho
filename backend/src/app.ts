import express, { type Request, type Response } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import helmet from 'helmet';
import { globalApiLimiter, pollingLimiter } from './middleware/rateLimiters';
import { conditionalJsonParser } from './middleware/jsonParser';
import { nodeContextMiddleware } from './middleware/nodeContext';
import { normalizeAcceptEncoding } from './middleware/normalizeAcceptEncoding';
import './types/express';

/**
 * Build an Express app with the full middleware pipeline installed.
 *
 * Canonical middleware order (18 steps). Do not reorder without re-running the
 * regression checklist in `docs/internal/architecture/middleware-order.md`.
 *
 *   1.  trust proxy
 *   2.  helmet
 *   3.  cors
 *   4.  normalizeAcceptEncoding
 *   5.  compression
 *   6.  cookieParser
 *   7.  globalApiLimiter (at /api)
 *   8.  pollingLimiter (at /api)
 *   9.  conditionalJsonParser
 *   10. nodeContextMiddleware
 *   11. authGate (at /api)                -- registered in index.ts
 *   12. auditLog (at /api)                -- registered in index.ts
 *   13. enforceApiTokenScope (at /api)    -- registered in index.ts
 *   14. hubOnlyGuard (at /api)            -- middleware/hubOnlyGuard.ts, registered in index.ts
 *   15. createRemoteProxyMiddleware       -- proxy/remoteNodeProxy.ts, registered in index.ts
 *   16. routes                            -- registered in index.ts from routes/*
 *   17. static serving + SPA fallback     -- registered in index.ts
 *   18. errorHandler                      -- registered in index.ts
 *
 * Steps 11 to 14 and 16 must run after the public auth routers (meta, auth,
 * mfa, sso) are registered so those routes stay reachable without a session
 * cookie. index.ts mounts those public routers before step 11 to preserve
 * that invariant.
 */
export function createApp(): express.Express {
  const app = express();

  // 1. Trust the first reverse proxy (nginx, Traefik, etc.) for correct
  // req.protocol, req.ip, and secure cookie detection behind a proxy.
  app.set('trust proxy', 1);

  // 2. Security headers.
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

  // 3. CORS: production restricts to FRONTEND_URL; dev mirrors the request
  // origin so Vite's dev server works.
  const corsOrigin = process.env.NODE_ENV === 'production'
    ? (process.env.FRONTEND_URL || false)
    : true;
  app.use(cors({
    origin: corsOrigin,
    credentials: true,
  }));

  // 4. Drop unknown Accept-Encoding tokens (e.g. `zstd` from Chromium 123+)
  // before compression negotiates. See middleware/normalizeAcceptEncoding.ts
  // for the symptom this prevents.
  app.use(normalizeAcceptEncoding);

  // 5. Compression. SSE streams (Content-Type: text/event-stream) MUST NOT be
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

  // 6. Cookie parser must run before the rate limiters so the hybrid key
  // generator can read req.cookies for per-user rate limit bucketing.
  app.use(cookieParser());

  // 7-8. Tiered rate limiting (see middleware/rateLimiters.ts for the model).
  app.use('/api/', globalApiLimiter);
  app.use('/api/', pollingLimiter);

  // 9. Parse JSON on local requests; preserve the raw stream for remote proxy.
  app.use(conditionalJsonParser);

  // 10. Resolve req.nodeId and short-circuit requests to deleted nodes.
  app.use(nodeContextMiddleware);

  return app;
}
