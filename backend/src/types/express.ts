import type { UserRole, ApiTokenScope, ApiToken } from '../services/DatabaseService';
import type { LicenseTier } from '../services/license-types';
import type { PermissionAction } from '../middleware/permissions';

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
      /** User ID carried by a scoped `mfa_pending` token. Only set while the user is completing the MFA challenge. */
      mfaPendingUserId?: number;
      /** True when the pending MFA session originated from an SSO login (LDAP or OIDC) rather than a password login. */
      mfaPendingSso?: boolean;
      /** True when the caller's current user-session cookie was issued with "stay signed in". Read by reissueSessionAfterTokenBump so a password/MFA change doesn't silently shorten a remembered session. */
      sessionRemember?: boolean;
      /** Cached remote-proxy target resolved by `remoteNodeProxy`'s outer gate so the http-proxy router/proxyReq callbacks do not re-resolve. */
      proxyTarget?: { apiUrl: string; apiToken: string };
      /** Trusted deploy provenance from machine auth or gateway overwrite. */
      deployContext?: import('../services/network/missingExternalNetworksError').DeployInvocationContext;
      /** Verified JWT scope for machine credentials (`node_proxy` / `pilot_tunnel`). */
      machineAuthScope?: 'node_proxy' | 'pilot_tunnel';
      /**
       * Hub-bound stack-scoped action evidence, trusted only when set under
       * machine auth (`node_proxy` / `pilot_tunnel`). Never set from browser sessions.
       */
      scopedStackEvidence?: { stackName: string; actions: ReadonlySet<PermissionAction> };
      /**
       * Hub-side pending evidence to attach on the outbound proxy hop when
       * the caller's global role alone would not grant the primary action.
       */
      proxyScopedStackEvidence?: { stackName: string; actions: readonly PermissionAction[] };
      /**
       * Named-stack classification from the hub gate. Stashed because
       * http-proxy pathRewrite mutates req.url before proxyRes, so
       * re-classifying req.path there would miss DELETE cleanup.
       */
      proxyNamedStackRoute?: { stackName: string; action: PermissionAction };
      /**
       * Elevated role for a single proxied request. Set by the settings
       * pre-authorization gate when the hub-side scoped permission check
       * passes for a non-admin user. Resets to undefined after the hop.
       */
      proxyElevatedRole?: UserRole;
    }
  }
}

export {};
