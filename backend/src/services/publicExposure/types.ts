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

/**
 * Why a check record cleanup did not finish. `zone_refused` is a 403 on the
 * zone's records that is not a location refusal; on its own it does not prove
 * the zone is out of reach, but together with the zone missing from the last
 * complete listing it does. `refused` is a rejected token (401), a refused
 * location, or a refused delete right after the DNS check's own create, none
 * of which say the zone is out of reach. `unmatched` is records at the check
 * name that are none of the journaled one; `unreadable_journal` is a journal
 * that cannot be read and cannot be rebuilt from the control identity.
 */
export type CleanupCause =
  | 'unreachable'
  | 'rate_limited'
  | 'refused'
  | 'zone_refused'
  | 'too_recent'
  | 'unexpected'
  | 'unmatched'
  | 'unreadable_journal';

export const CLEANUP_CAUSES: readonly CleanupCause[] = [
  'unreachable', 'rate_limited', 'refused', 'zone_refused', 'too_recent', 'unexpected', 'unmatched', 'unreadable_journal',
];

/** Journaled intent of a permission-check TXT record, kept until its delete is proven. */
export interface PendingScopeCheck {
  name: string;
  content: string;
  recordId: string | null;
  /** When the intent was journaled. A create that may still land is not declared lost too early. */
  createdAt: number;
  /** Why the latest attempt to delete the record did not finish; unset until one fails. */
  cause?: CleanupCause;
}

export interface PublicExposureZoneView {
  zoneRef: string;
  name: string;
  enabled: boolean;
  allowedSuffixes: string[];
  dns: ZoneDnsState;
  dnsCheckedAt: number | null;
  seenAtLastCheck: boolean;
  /** `note` is the sentence for the latest cleanup attempt that did not finish; null before any attempt failed. */
  cleanupPending: { recordName: string; note: string | null } | null;
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
