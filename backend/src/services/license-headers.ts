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
