/**
 * Public exposure account types. The stored shapes are provider-neutral; the
 * only adapter today is Cloudflare Tunnel.
 */

export const CLOUDFLARE_ADAPTER_ID = 'cloudflare-tunnel';

/** A permission Sencho has proven (`confirmed`), seen refused (`missing`), or not yet proven. */
export type ScopeState = 'unconfirmed' | 'confirmed' | 'missing';

/**
 * DNS permission in one zone. `readable` means a DNS read succeeded; only a
 * TXT create and delete with the current token makes it `confirmed`.
 */
export type ZoneDnsState = 'unconfirmed' | 'readable' | 'confirmed' | 'missing';

/** Outcome of the last check against Cloudflare. Each value has its own Answer in the UI. */
export type CheckOutcome =
  | 'ok'
  | 'token_invalid'
  | 'token_inactive'
  | 'token_location_refused'
  | 'credential_unreadable'
  | 'account_not_accessible'
  | 'cloudflare_unreachable'
  | 'rate_limited'
  | 'unexpected_response';

/** Every outcome except `ok`: what a check that did not complete can mean. */
export type FailedOutcome = Exclude<CheckOutcome, 'ok'>;

export const CHECK_OUTCOMES: readonly CheckOutcome[] = [
  'ok', 'token_invalid', 'token_inactive', 'token_location_refused', 'credential_unreadable',
  'account_not_accessible', 'cloudflare_unreachable', 'rate_limited', 'unexpected_response',
];

export interface AccountScopes {
  zoneRead: ScopeState;
  tunnel: ScopeState;
}

export interface LastCheck {
  outcome: CheckOutcome;
  at: number;
  detail: string | null;
  retryAfterSeconds?: number;
  /** Set with `rate_limited`: whether Cloudflare or Sencho's own request budget refused. */
  limitedBy?: 'cloudflare' | 'sencho';
}

/** Journaled intent of a permission-check TXT record, kept until its delete is proven. */
export interface PendingScopeCheck {
  name: string;
  content: string;
  recordId: string | null;
  /** When the intent was journaled. A create that may still land is not declared lost too early. */
  createdAt: number;
}

export interface PublicExposureZoneView {
  zoneRef: string;
  name: string;
  enabled: boolean;
  allowedSuffixes: string[];
  dns: ZoneDnsState;
  dnsCheckedAt: number | null;
  seenAtLastCheck: boolean;
  cleanupPending: { recordName: string } | null;
  /** The TXT record the DNS write check creates and deletes, named in its preview. Null until this instance has an identity. */
  checkRecordName: string | null;
}

export type PublicExposureAccountView =
  | { connected: false }
  | {
      connected: true;
      provider: typeof CLOUDFLARE_ADAPTER_ID;
      accountId: string;
      accountName: string | null;
      scopes: AccountScopes;
      lastCheck: LastCheck;
      verifiedAt: number | null;
      connectedBy: string;
      connectedAt: number;
      zonesVisible: number;
      zones: PublicExposureZoneView[];
      nodeEndpointCount: number;
    };

/** One enabled zone, as the hostname picker of a later slice reads it. */
export interface EnabledZoneView {
  zoneRef: string;
  name: string;
  allowedSuffixes: string[];
  dns: ZoneDnsState;
}

/** Error codes the routes return. The frontend maps each one to its own state. */
export type PublicExposureErrorCode =
  | 'INVALID_INPUT'
  | 'CONTROL_IDENTITY_MISSING'
  | 'NOT_CONNECTED'
  | 'ACCOUNT_BUSY'
  | 'ACCOUNT_CHANGE_NEEDS_DISCONNECT'
  | 'ENDPOINTS_EXIST'
  | 'CLEANUP_PENDING'
  | 'ZONE_NOT_FOUND'
  | 'ZONE_NOT_ENABLED'
  | 'SCOPE_CHECK_CONFLICT'
  | 'TOKEN_INVALID'
  | 'TOKEN_INACTIVE'
  | 'TOKEN_LOCATION_REFUSED'
  | 'ACCOUNT_NOT_ACCESSIBLE'
  | 'CREDENTIAL_UNREADABLE'
  | 'CLOUDFLARE_UNREACHABLE'
  | 'CLOUDFLARE_RATE_LIMITED'
  | 'UNEXPECTED_RESPONSE';

/** A refusal the route turns into a clean JSON error. Its message never holds secret material. */
export class PublicExposureError extends Error {
  constructor(
    readonly code: PublicExposureErrorCode,
    readonly status: number,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'PublicExposureError';
  }
}
