import type { UserRole, ApiTokenScope, ApiToken } from '../services/DatabaseService';
import type { LicenseTier, LicenseVariant } from '../services/license-types';

// Extend Express Request type for user and node context.
// This file is imported for its side effects only (ambient declaration).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Express type augmentation requires namespace syntax
  namespace Express {
    interface Request {
      user?: { username: string; role: UserRole; userId: number };
      nodeId: number;
      apiTokenScope?: ApiTokenScope;
      /** Active API token resolved by the rate limiter's key generator (which runs before auth), memoized so `authMiddleware` reuses it without a second DB lookup. Set only for a request bearing a real, non-revoked, non-expired API token. */
      _apiToken?: ApiToken;
      rawBody?: Buffer;
      /** License tier asserted by the main instance on proxied requests. Only set for trusted node_proxy tokens. */
      proxyTier?: LicenseTier;
      /** License variant asserted by the main instance on proxied requests. Only set for trusted node_proxy tokens. */
      proxyVariant?: LicenseVariant;
      /** User ID carried by a scoped `mfa_pending` token. Only set while the user is completing the MFA challenge. */
      mfaPendingUserId?: number;
      /** True when the pending MFA session originated from an SSO login (LDAP or OIDC) rather than a password login. */
      mfaPendingSso?: boolean;
      /** Cached remote-proxy target resolved by `remoteNodeProxy`'s outer gate so the http-proxy router/proxyReq callbacks do not re-resolve. */
      proxyTarget?: { apiUrl: string; apiToken: string };
    }
  }
}

export {};
