/**
 * HTTP header names used for Distributed License Enforcement between
 * Sencho instances. A primary instance proxies tier-gated requests to
 * its remote fleet nodes and asserts the license state via these
 * headers; the remote node trusts the headers when the request is
 * authenticated as a node_proxy bearer.
 */
export const PROXY_TIER_HEADER = 'x-sencho-tier';

/**
 * Carries the signed-in user's role from the forwarding primary to the remote
 * node, so the remote enforces that user's RBAC instead of treating every
 * proxied request as admin. Trusted under the same rule as PROXY_TIER_HEADER:
 * only a request authenticated as a node_proxy/pilot_tunnel bearer may set it,
 * and the gateway overwrites it on every proxied request so a browser or API
 * client cannot smuggle a role through.
 */
export const PROXY_ROLE_HEADER = 'x-sencho-actor-role';

/**
 * Trusted deploy provenance for machine-to-machine / proxied deploys.
 * The gateway always strips client-supplied values and, for interactive
 * proxied requests, overwrites with source=manual and the signed-in username.
 * Background callers (scheduler, fleet, blueprint, mesh) set these only on
 * direct machine-originated HTTP after the strip boundary.
 */
export const PROXY_DEPLOY_SOURCE_HEADER = 'x-sencho-deploy-source';
export const PROXY_DEPLOY_ACTOR_HEADER = 'x-sencho-deploy-actor';

/**
 * Bound stack-scoped RBAC evidence for Proxy/Pilot hops. The hub strips any
 * client-supplied values and, when scoped elevation is required, sets the
 * exact stack name plus a comma-separated PermissionAction set conferred by
 * that tuple's hub assignments. Remotes trust these only under node_proxy /
 * pilot_tunnel machine auth.
 */
export const PROXY_SCOPED_STACK_NAME_HEADER = 'x-sencho-scoped-stack-name';
export const PROXY_SCOPED_STACK_ACTIONS_HEADER = 'x-sencho-scoped-stack-actions';

export const DEPLOY_SOURCES = [
  'manual',
  'rollback',
  'template',
  'from_git',
  'git_apply',
  'fleet_snapshot',
  'labels',
  'scheduler',
  'webhook',
  'blueprint',
  'mesh_redeploy',
] as const;

export type DeploySourceHeader = (typeof DEPLOY_SOURCES)[number];

export function isDeploySourceHeader(value: unknown): value is DeploySourceHeader {
  return typeof value === 'string' && (DEPLOY_SOURCES as readonly string[]).includes(value);
}

/** Headers for direct machine-originated deploy HTTP (never for browser clients). */
export function deployProvenanceHeaders(
  source: DeploySourceHeader,
  actor: string,
): Record<string, string> {
  return {
    [PROXY_DEPLOY_SOURCE_HEADER]: source,
    [PROXY_DEPLOY_ACTOR_HEADER]: actor,
  };
}
