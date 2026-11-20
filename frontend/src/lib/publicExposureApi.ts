import { apiFetch } from '@/lib/api';

/**
 * The hub's public exposure account (Cloudflare). Every call is hub-only, so
 * it always goes to the instance the operator is signed into, whichever node
 * is active. The token is sent once, to connect or replace, and never read
 * back.
 */

export type ScopeState = 'unconfirmed' | 'confirmed' | 'missing';
export type ZoneDnsState = 'unconfirmed' | 'readable' | 'confirmed' | 'missing';
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

export interface PublicExposureZone {
  zoneRef: string;
  name: string;
  enabled: boolean;
  allowedSuffixes: string[];
  dns: ZoneDnsState;
  dnsCheckedAt: number | null;
  seenAtLastCheck: boolean;
  /** `note` is why the latest attempt to delete the record did not finish; null before any attempt failed. A journal that cannot be read always carries its own sentence. */
  cleanupPending: { recordName: string; note: string | null } | null;
  /** The TXT record the DNS write check creates and deletes. Null until the control instance has an identity. */
  checkRecordName: string | null;
}

export interface ConnectedAccountView {
  connected: true;
  provider: 'cloudflare-tunnel';
  accountId: string;
  accountName: string | null;
  scopes: { zoneRead: ScopeState; tunnel: ScopeState };
  lastCheck: {
    outcome: CheckOutcome;
    at: number;
    detail: string | null;
    retryAfterSeconds?: number;
    /** Set with `rate_limited`: whether Cloudflare or Sencho's own request budget refused. */
    limitedBy?: 'cloudflare' | 'sencho';
  };
  verifiedAt: number | null;
  connectedBy: string;
  connectedAt: number;
  zonesVisible: number;
  zones: PublicExposureZone[];
  nodeEndpointCount: number;
}

export type PublicExposureAccountView = { connected: false } | ConnectedAccountView;

/** The answer to a disconnect: the permission-check records it could not delete and left in Cloudflare. */
export interface DisconnectResult {
  connected: false;
  leftInCloudflare: string[];
}

/** A refusal from the public exposure routes, carrying the route's error code. */
export class PublicExposureApiError extends Error {
  readonly code: string | null;
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(message: string, code: string | null, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = 'PublicExposureApiError';
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const BASE = '/public-exposure';

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(`${BASE}${path}`, { ...init, localOnly: true });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const record = (typeof body === 'object' && body !== null ? body : {}) as { error?: unknown; code?: unknown; retryAfterSeconds?: unknown };
    throw new PublicExposureApiError(
      typeof record.error === 'string' ? record.error : `Request failed (${res.status}).`,
      typeof record.code === 'string' ? record.code : null,
      res.status,
      typeof record.retryAfterSeconds === 'number' ? record.retryAfterSeconds : undefined,
    );
  }
  if (typeof body !== 'object' || body === null) {
    throw new PublicExposureApiError('The control instance sent a response Sencho could not read.', null, res.status);
  }
  return body as T;
}

export const publicExposureApi = {
  getAccount: () => call<PublicExposureAccountView>('/account'),
  connect: (token: string, accountId: string) =>
    call<PublicExposureAccountView>('/account', { method: 'PUT', body: JSON.stringify({ token, accountId }) }),
  recheck: () => call<PublicExposureAccountView>('/account/verify', { method: 'POST' }),
  dnsCheck: (zoneRef: string) =>
    call<PublicExposureAccountView>('/account/dns-check', { method: 'POST', body: JSON.stringify({ zoneRef }) }),
  disconnect: async (): Promise<DisconnectResult> => {
    const body = await call<{ connected: false; leftInCloudflare?: unknown }>('/account', { method: 'DELETE' });
    const left = Array.isArray(body.leftInCloudflare) ? body.leftInCloudflare.filter((name): name is string => typeof name === 'string') : [];
    return { connected: false, leftInCloudflare: left };
  },
  setZone: (zoneRef: string, enabled: boolean, allowedSuffixes: string[]) =>
    call<PublicExposureAccountView>(`/zones/${encodeURIComponent(zoneRef)}`, {
      method: 'PUT',
      body: JSON.stringify({ enabled, allowedSuffixes }),
    }),
};
