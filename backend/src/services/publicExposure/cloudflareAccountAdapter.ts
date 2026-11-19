import crypto from 'crypto';
import {
  CloudflareApiError,
  cloudflareApiClient,
  type CloudflareApiClient,
  type CloudflareCallOptions,
} from './cloudflareApiClient';
import type { AccountScopes, CheckOutcome, PendingScopeCheck, ZoneDnsState } from './types';

/**
 * The account part of the Cloudflare adapter: token verification, the account
 * check, zone listing, the read probes, and the self-cleaning DNS write check.
 * It maps Cloudflare's answers to Sencho's named states and stores nothing;
 * the account service persists what it returns.
 */

/** Cloudflare error code for a token used from an address its IP filter does not allow. */
const LOCATION_REFUSED_CODE = 9109;
const MAX_PARALLEL_DNS_PROBES = 4;
/** Cloudflare object ids are 32 hex characters; anything else never reaches a request path. */
const CLOUDFLARE_ID = /^[0-9a-f]{32}$/;
const CHECK_RECORD_COMMENT = 'Sencho permission check, deleted right away';

export interface ListedZone {
  zoneRef: string;
  name: string;
}

export interface AccountCheckResult {
  outcome: CheckOutcome;
  detail: string | null;
  retryAfterSeconds?: number;
  /** Set only when the check completed (`outcome: 'ok'`). */
  facts: {
    accountName: string | null;
    scopes: AccountScopes;
    /** Null when the zone listing was refused; reconciliation then changes no zone. */
    zones: ListedZone[] | null;
    zoneDns: Record<string, ZoneDnsState>;
  } | null;
}

/** An enabled zone and the DNS state it holds before this check. */
export interface ZoneProbeInput {
  zoneRef: string;
  dns: ZoneDnsState;
}

export type DnsWriteResult =
  | { kind: 'confirmed' }
  | { kind: 'missing' }
  | { kind: 'conflict'; recordName: string; recordType: string }
  | { kind: 'cleanup_pending'; recordName: string }
  | { kind: 'failed'; outcome: CheckOutcome; detail: string; retryAfterSeconds?: number };

/** Persists the TXT journal between Cloudflare calls, so an interrupted check can be cleaned up. */
export interface ScopeCheckJournal {
  current(): PendingScopeCheck | null;
  write(pending: PendingScopeCheck | null): void;
}

interface TokenVerifyResult {
  status?: unknown;
  expires_on?: unknown;
}

interface DnsRecord {
  id?: unknown;
  type?: unknown;
  name?: unknown;
  content?: unknown;
}

/** A check stops here: the named state, and what to show with it. */
class CheckStop extends Error {
  constructor(readonly outcome: CheckOutcome, readonly detail: string | null, readonly retryAfterSeconds?: number) {
    super(outcome);
  }
}

function isLocationRefusal(error: CloudflareApiError): boolean {
  return error.cfCodes.includes(LOCATION_REFUSED_CODE) || /\blocation\b/i.test(error.message);
}

/** The state a transport-level failure stops a check with, or null for a refusal the caller classifies. */
export function stopOutcomeFor(error: CloudflareApiError): CheckOutcome | null {
  switch (error.kind) {
    case 'network':
    case 'timeout':
    case 'server':
      return 'cloudflare_unreachable';
    case 'rate_limited':
    case 'budget_exhausted':
      return 'rate_limited';
    case 'invalid_response':
      return 'unexpected_response';
    default:
      return null;
  }
}

function toStop(error: unknown): CheckStop {
  if (error instanceof CheckStop) return error;
  if (error instanceof CloudflareApiError) {
    if (isLocationRefusal(error)) return new CheckStop('token_location_refused', error.message);
    const outcome = stopOutcomeFor(error) ?? 'unexpected_response';
    const detail = error.kind === 'budget_exhausted' ? "Sencho's own request limit" : error.message;
    return new CheckStop(outcome, detail, error.retryAfterSeconds);
  }
  throw error;
}

function isRefusal(error: unknown): error is CloudflareApiError {
  return error instanceof CloudflareApiError && (error.kind === 'forbidden' || error.kind === 'not_found') && !isLocationRefusal(error);
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

export class CloudflareAccountAdapter {
  constructor(private readonly client: CloudflareApiClient = cloudflareApiClient) {}

  /**
   * Verify the token, check the account, list zones, and probe tunnel read and
   * DNS read in each enabled zone. Stops at the first transport failure, so a
   * failed check never fans out into "missing" permissions.
   */
  async checkAccount(token: string, accountId: string, enabledZones: readonly ZoneProbeInput[], options: CloudflareCallOptions): Promise<AccountCheckResult> {
    try {
      await this.verifyToken(token, accountId, options);
      const account = await this.findAccount(token, accountId, options);
      const zones = await this.listZonesOrRefusal(token, accountId, options);
      const tunnelRefused = await this.tunnelReadRefused(token, accountId, options);

      // An account the token cannot see at all reads as inaccessible, not as missing permissions.
      if (!account.listed && zones.refused && tunnelRefused) {
        throw new CheckStop('account_not_accessible', `This token cannot reach account ${accountId}.`);
      }

      const zoneDns = await this.probeDnsRead(token, enabledZones, options);
      return {
        outcome: 'ok',
        detail: null,
        facts: {
          accountName: account.name,
          scopes: {
            zoneRead: zones.refused ? 'missing' : 'confirmed',
            tunnel: tunnelRefused ? 'missing' : 'unconfirmed',
          },
          zones: zones.refused ? null : zones.list,
          zoneDns,
        },
      };
    } catch (error: unknown) {
      const stop = toStop(error);
      return { outcome: stop.outcome, detail: stop.detail, retryAfterSeconds: stop.retryAfterSeconds, facts: null };
    }
  }

  /** Delete a journaled check record by id or by exact match. True when nothing of it is left. */
  async resumeCleanup(token: string, zoneRef: string, journal: ScopeCheckJournal, options: CloudflareCallOptions): Promise<boolean> {
    const pending = journal.current();
    if (!pending) return true;
    try {
      let recordId = pending.recordId;
      if (!recordId) {
        const records = await this.recordsAt(token, zoneRef, pending.name, options);
        const match = records.find((r) => r.type === 'TXT' && typeof r.content === 'string' && unquote(r.content) === pending.content);
        if (!match) {
          // The create never landed.
          journal.write(null);
          return true;
        }
        if (typeof match.id !== 'string' || !CLOUDFLARE_ID.test(match.id)) return false;
        recordId = match.id;
      }
      await this.deleteRecord(token, zoneRef, recordId, options);
      journal.write(null);
      return true;
    } catch (error: unknown) {
      if (error instanceof CloudflareApiError) return false;
      throw error;
    }
  }

  /**
   * Prove DNS Edit in one zone: create a TXT record at a name only this hub
   * uses, then delete it. The intent is journaled before the create and the
   * record id after it, so an interrupted check is cleaned up later.
   */
  async proveDnsWrite(
    token: string,
    zone: { zoneRef: string; name: string },
    controlIdentity: string,
    journal: ScopeCheckJournal,
    options: CloudflareCallOptions,
  ): Promise<DnsWriteResult> {
    const recordName = `_sencho-check-${controlIdentity}.${zone.name}`;
    if (journal.current() && !(await this.resumeCleanup(token, zone.zoneRef, journal, options))) {
      return { kind: 'cleanup_pending', recordName: journal.current()?.name ?? recordName };
    }

    let existing: DnsRecord[];
    try {
      existing = await this.recordsAt(token, zone.zoneRef, recordName, options);
    } catch (error: unknown) {
      if (isRefusal(error)) return { kind: 'missing' };
      return this.failed(error);
    }
    if (existing.length > 0) {
      const type = typeof existing[0].type === 'string' ? existing[0].type : 'unknown';
      return { kind: 'conflict', recordName, recordType: type };
    }

    const pending: PendingScopeCheck = {
      name: recordName,
      content: `sencho-scope-check:${crypto.randomBytes(8).toString('hex')}`,
      recordId: null,
    };
    journal.write(pending);

    let recordId: string;
    try {
      const created = await this.client.request<{ id?: unknown }>(token, {
        ...options,
        method: 'POST',
        path: `/zones/${zone.zoneRef}/dns_records`,
        body: { type: 'TXT', name: recordName, content: pending.content, ttl: 60, proxied: false, comment: CHECK_RECORD_COMMENT },
      });
      if (typeof created.result?.id !== 'string' || !CLOUDFLARE_ID.test(created.result.id)) {
        // Created but unnamed: keep the journal; the exact-match cleanup finds it.
        return { kind: 'cleanup_pending', recordName };
      }
      recordId = created.result.id;
    } catch (error: unknown) {
      if (error instanceof CloudflareApiError) {
        if (error.kind === 'forbidden') {
          journal.write(null);
          return { kind: 'missing' };
        }
        const permanent = error.kind === 'bad_request' || error.kind === 'unauthorized' || error.kind === 'not_found'
          || (error.kind === 'network' && error.preSend) || error.kind === 'budget_exhausted';
        if (permanent || error.kind === 'rate_limited') {
          // The record was not created.
          journal.write(null);
          return this.failed(error);
        }
        // Timeout, 5xx or a dropped connection: the record may exist. Keep the journal.
        return { kind: 'cleanup_pending', recordName };
      }
      throw error;
    }

    journal.write({ ...pending, recordId });
    try {
      await this.deleteRecord(token, zone.zoneRef, recordId, options);
    } catch (error: unknown) {
      if (error instanceof CloudflareApiError) return { kind: 'cleanup_pending', recordName };
      throw error;
    }
    journal.write(null);
    return { kind: 'confirmed' };
  }

  private failed(error: unknown): DnsWriteResult {
    const stop = toStop(error);
    const codes = error instanceof CloudflareApiError && error.cfCodes.length > 0 ? ` (Cloudflare code ${error.cfCodes.join(', ')})` : '';
    return { kind: 'failed', outcome: stop.outcome, detail: `${stop.detail ?? 'Cloudflare refused the request.'}${codes}`, retryAfterSeconds: stop.retryAfterSeconds };
  }

  private async verifyToken(token: string, accountId: string, options: CloudflareCallOptions): Promise<void> {
    let verified: TokenVerifyResult;
    try {
      verified = (await this.client.request<TokenVerifyResult>(token, { ...options, method: 'GET', path: '/user/tokens/verify' })).result ?? {};
    } catch (userError: unknown) {
      if (!(userError instanceof CloudflareApiError)) throw userError;
      if (isLocationRefusal(userError)) throw new CheckStop('token_location_refused', userError.message);
      if (userError.kind !== 'unauthorized' && userError.kind !== 'bad_request') throw userError;
      // An account-owned token verifies only at its account.
      try {
        verified = (await this.client.request<TokenVerifyResult>(token, { ...options, method: 'GET', path: `/accounts/${accountId}/tokens/verify` })).result ?? {};
      } catch (accountError: unknown) {
        if (!(accountError instanceof CloudflareApiError)) throw accountError;
        if (isLocationRefusal(accountError)) throw new CheckStop('token_location_refused', accountError.message);
        if (stopOutcomeFor(accountError) !== null) throw accountError;
        throw new CheckStop('token_invalid', 'Cloudflare rejects this token.');
      }
    }
    if (verified.status !== 'active') {
      const status = typeof verified.status === 'string' ? verified.status : 'not active';
      const expires = typeof verified.expires_on === 'string' ? verified.expires_on : null;
      throw new CheckStop('token_inactive', expires ? `Token is ${status}; it expires or expired on ${expires}.` : `Token is ${status}.`);
    }
  }

  private async findAccount(token: string, accountId: string, options: CloudflareCallOptions): Promise<{ listed: boolean; name: string | null }> {
    let accounts: Array<{ id?: unknown; name?: unknown }>;
    try {
      accounts = await this.client.paginate(token, '/accounts', {}, 50, options);
    } catch (error: unknown) {
      if (isRefusal(error)) return { listed: false, name: null };
      throw error;
    }
    const match = accounts.find((a) => a.id === accountId);
    if (!match) throw new CheckStop('account_not_accessible', `Account ${accountId} is not visible to this token.`);
    return { listed: true, name: typeof match.name === 'string' ? match.name : null };
  }

  private async listZonesOrRefusal(token: string, accountId: string, options: CloudflareCallOptions): Promise<{ refused: boolean; list: ListedZone[] }> {
    try {
      const zones = await this.client.paginate<{ id?: unknown; name?: unknown }>(token, '/zones', { 'account.id': accountId }, 50, options);
      const list = zones
        .filter((z): z is { id: string; name: string } => typeof z.id === 'string' && typeof z.name === 'string')
        .map((z) => ({ zoneRef: z.id, name: z.name.toLowerCase() }));
      return { refused: false, list };
    } catch (error: unknown) {
      if (isRefusal(error)) return { refused: true, list: [] };
      throw error;
    }
  }

  private async tunnelReadRefused(token: string, accountId: string, options: CloudflareCallOptions): Promise<boolean> {
    try {
      await this.client.request(token, { ...options, method: 'GET', path: `/accounts/${accountId}/cfd_tunnel`, query: { is_deleted: false, per_page: 1 } });
      return false;
    } catch (error: unknown) {
      if (isRefusal(error)) return true;
      throw error;
    }
  }

  private async probeDnsRead(token: string, zones: readonly ZoneProbeInput[], options: CloudflareCallOptions): Promise<Record<string, ZoneDnsState>> {
    const result: Record<string, ZoneDnsState> = {};
    for (let i = 0; i < zones.length; i += MAX_PARALLEL_DNS_PROBES) {
      const batch = zones.slice(i, i + MAX_PARALLEL_DNS_PROBES);
      const states = await Promise.all(batch.map(async (zone): Promise<ZoneDnsState> => {
        try {
          await this.client.request(token, { ...options, method: 'GET', path: `/zones/${zone.zoneRef}/dns_records`, query: { per_page: 1 } });
          return zone.dns === 'confirmed' ? 'confirmed' : 'readable';
        } catch (error: unknown) {
          if (isRefusal(error)) return 'missing';
          throw error;
        }
      }));
      batch.forEach((zone, index) => { result[zone.zoneRef] = states[index]; });
    }
    return result;
  }

  private async recordsAt(token: string, zoneRef: string, name: string, options: CloudflareCallOptions): Promise<DnsRecord[]> {
    return this.client.paginate<DnsRecord>(token, `/zones/${zoneRef}/dns_records`, { name }, 100, options);
  }

  private async deleteRecord(token: string, zoneRef: string, recordId: string, options: CloudflareCallOptions): Promise<void> {
    try {
      await this.client.request(token, { ...options, method: 'DELETE', path: `/zones/${zoneRef}/dns_records/${recordId}` });
    } catch (error: unknown) {
      if (error instanceof CloudflareApiError && error.kind === 'not_found') return;
      throw error;
    }
  }
}
