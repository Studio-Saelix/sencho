/**
 * HTTP header names used for Distributed License Enforcement between
 * Sencho instances. A primary instance proxies tier-gated requests to
 * its remote fleet nodes and asserts the license state via these
 * headers; the remote node trusts the headers when the request is
 * authenticated as a node_proxy bearer.
 */
export const PROXY_TIER_HEADER = 'x-sencho-tier';
