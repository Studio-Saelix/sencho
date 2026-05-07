// Path prefixes whose /api/* requests are handled locally even when an
// x-node-id header targets a remote node. These endpoints are gateway-level
// concerns (auth, node registry, licensing, fleet aggregation, webhooks,
// meta) that must never be proxied to a remote Sencho instance.
//
// Consumed by:
//   - middleware/jsonParser.ts  → skip JSON parsing only for non-exempt remote proxy requests
//   - middleware/nodeContext.ts → skip node resolution for exempt paths
export const PROXY_EXEMPT_PREFIXES: readonly string[] = [
  '/api/auth/',
  '/api/nodes',
  '/api/license',
  '/api/fleet/',
  '/api/webhooks',
  '/api/meta',
];

/** Returns true when the path should bypass the remote proxy (handled locally). */
export function isProxyExemptPath(path: string): boolean {
  for (const prefix of PROXY_EXEMPT_PREFIXES) {
    if (path.startsWith(prefix)) return true;
  }
  return false;
}
