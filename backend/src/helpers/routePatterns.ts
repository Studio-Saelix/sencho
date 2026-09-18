// Shared route-matching patterns used by multiple middleware modules.

/** Matches webhook trigger paths: /webhooks/<numeric id>/trigger. Used by the
 *  global rate limiter (skip) and the auth gate (skip): webhooks authenticate
 *  via HMAC, not session cookie. */
export const WEBHOOK_TRIGGER_RE = /^\/webhooks\/\d+\/trigger$/;

/** Native Git provider hook ingest: /gitops/hooks/:nodeId/:endpointId */
export const GITOPS_HOOK_INGEST_RE = /^\/gitops\/hooks\/\d+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Internal node hop for forwarded provider hooks. */
export const GITOPS_HOOK_INTERNAL_RE = /^\/gitops\/internal\/hooks\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
