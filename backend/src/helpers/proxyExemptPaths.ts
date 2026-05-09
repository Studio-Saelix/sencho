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

// Path prefixes that are hub-only: they manage state owned by the local hub
// (centralized audit, fleet schedules, notification routing rules). Routed
// to the local hub when nodeId resolves to local, but rejected with 409 when
// nodeId resolves to a remote node so a script/curl call cannot trick the
// proxy into forwarding hub-only authority across a node boundary.
//
// Frontend nav surfaces are gated separately via `HUB_ONLY_VIEWS` in
// useViewNavigationState.ts; this list is the backend defense-in-depth.
//
// Consumed by:
//   - middleware/hubOnlyGuard.ts → 409 when nodeId is remote
export const HUB_ONLY_PREFIXES: readonly string[] = [
  '/api/scheduled-tasks/',
  '/api/audit-log/',
  '/api/notification-routes/',
];

/** Returns true when the path is hub-only and must not be proxied to a remote node. */
export function isHubOnlyPath(path: string): boolean {
  for (const prefix of HUB_ONLY_PREFIXES) {
    if (path.startsWith(prefix)) return true;
  }
  return false;
}
