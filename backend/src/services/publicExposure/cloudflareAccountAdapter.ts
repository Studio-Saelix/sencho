import crypto from 'crypto';
import {
  CloudflareApiError,
  cloudflareApiClient,
  type CloudflareApiClient,
  type CloudflareCallOptions,
} from './cloudflareApiClient';
import type { AccountScopes, FailedOutcome, LastCheck, PendingScopeCheck, ZoneDnsState } from './types';

/**
 * The account part of the Cloudflare adapter: token verification, the account
 * check, zone listing, the read probes, and the self-cleaning DNS write check.
 * It maps Cloudflare's answers to Sencho's named states and stores nothing;
 * the account service persists what it returns.
 *
 * Two mappings here are assumptions until the real-account run settles them
 * (ADR §9, Q1): the location-refusal code and message, and that a token
 * whose account listing is refused can still be checked through the
 * account-scoped probes.
 */

/** Cloudflare error code for a token used from an address its IP filter does not allow (assumed; see Q1). */
const LOCATION_REFUSED_CODE = 9109;
/** The message Cloudflare sends with that refusal (assumed; see Q1). */
const LOCATION_REFUSED_MESSAGE = /cannot use the access token from location/i;
const MAX_PARALLEL_DNS_PROBES = 4;
/** Cloudflare object ids are 32 hex characters; anything else never reaches a request path. */
const CLOUDFLARE_ID = /^[0-9a-f]{32}$/;
const CHECK_RECORD_COMMENT = 'Sencho permission check, deleted right away';
/**
 * A create that timed out can still land on Cloudflare's side. A journal
 * younger than this is not declared lost when the record is not there yet.
 */
const LATE_CREATE_WINDOW_MS = 2 * 60_000;

/** The TXT name the DNS write check uses: the control identity keeps two hubs on one account apart. */
export function checkRecordName(controlIdentity: string, zoneName: string): string {
  return `_sencho-check-${controlIdentity}.${zoneName}`;
}

export interface ListedZone {
  zoneRef: string;
  name: string;
}

export interface AccountFacts {
  accountName: string | null;
  scopes: AccountScopes;
  /** Null when the zone listing was refused; reconciliation then changes no zone. */
  zones: ListedZone[] | null;
  /** DNS state of each enabled zone that was probed (zones missing from a complete listing are not). */
  zoneDns: Record<string, Exclude<ZoneDnsState, 'unconfirmed'>>;
}

/** A failed check: the named state and what to show with it. */
export interface CheckFailure {
  outcome: FailedOutcome;
  detail: string | null;
  retryAfterSeconds?: number;
  limitedBy?: LastCheck['limitedBy'];
}

export type AccountCheckResult =
  | { outcome: 'ok'; facts: AccountFacts }
  | CheckFailure;

/** An enabled zone and the DNS state it holds before this check. */
export interface ZoneProbeInput {
  zoneRef: string;
  dns: ZoneDnsState;
}

/** Why a journaled check record is still there. */
export type CleanupCause = 'unreachable' | 'rate_limited' | 'refused' | 'too_recent' | 'unexpected';

export type CleanupResult = { cleaned: true } | { cleaned: false; cause: CleanupCause };

export type DnsWriteResult =
  | { kind: 'confirmed' }
  | { kind: 'missing' }
  | { kind: 'conflict'; recordName: string; recordType: string }
  | { kind: 'cleanup_pending'; recordName: string; cause: CleanupCause | 'ambiguous_create' }
  | ({ kind: 'failed' } & CheckFailure);

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

/** A check stops here. */
class CheckStop extends Error {
  constructor(readonly failure: CheckFailure) {
    super(failure.outcome);
  }
}

function stop(outcome: FailedOutcome, detail: string | null): CheckStop {
  return new CheckStop({ outcome, detail });
}

function isLocationRefusal(error: CloudflareApiError): boolean {
  return error.cfCodes.includes(LOCATION_REFUSED_CODE) || LOCATION_REFUSED_MESSAGE.test(error.message);
}

/** The state a transport-level failure stops a check with, or null for a refusal the caller classifies. */
export function stopOutcomeFor(error: CloudflareApiError): FailedOutcome | null {
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

function failureFrom(error: unknown): CheckFailure {
  if (error instanceof CheckStop) return error.failure;
  if (error instanceof CloudflareApiError) {
    if (isLocationRefusal(error)) return { outcome: 'token_location_refused', detail: error.message };
    const outcome = stopOutcomeFor(error) ?? 'unexpected_response';
    if (outcome === 'rate_limited') {
      const sencho = error.kind === 'budget_exhausted';
      return { outcome, detail: null, retryAfterSeconds: error.retryAfterSeconds, limitedBy: sencho ? 'sencho' : 'cloudflare' };
    }
    const codes = error.cfCodes.length > 0 ? ` (Cloudflare code ${error.cfCodes.join(', ')})` : '';
    return { outcome, detail: `${error.message}${codes}` };
  }
  throw error;
}

function isRefusal(error: unknown): error is CloudflareApiError {
  return error instanceof CloudflareApiError && (error.kind === 'forbidden' || error.kind === 'not_found') && !isLocationRefusal(error);
}

function cleanupCause(error: CloudflareApiError): CleanupCause {
  const outcome = stopOutcomeFor(error);
  if (outcome === 'cloudflare_unreachable') return 'unreachable';
  if (outcome === 'rate_limited') return 'rate_limited';
  if (error.kind === 'forbidden' || error.kind === 'unauthorized') return 'refused';
  return 'unexpected';
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}

export class CloudflareAccountAdapter {
  constructor(
    private readonly client: CloudflareApiClient = cloudflareApiClient,
    private readonly now: () => number = Date.now,
  ) {}

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

      // An account the token cannot see reads as inaccessible, not as missing
      // permissions: the listing is refused, the account-scoped tunnel probe is
      // refused, and the account's zone listing is refused or empty (a mistyped
      // id lists no zones rather than refusing).
      if (!account.listed && tunnelRefused && (zones.refused || zones.list.length === 0)) {
        throw stop('account_not_accessible', `This token cannot reach account ${accountId}.`);
      }

      // A zone missing from a complete listing is reported as not visible, not probed.
      const listed = zones.refused ? null : new Set(zones.list.map((z) => z.zoneRef));
      const probed = listed ? enabledZones.filter((z) => listed.has(z.zoneRef)) : enabledZones;
      const zoneDns = await this.probeDnsRead(token, probed, options);
      return {
        outcome: 'ok',
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
      return failureFrom(error);
    }
  }

  /** Delete a journaled check record by id or by exact match. */
  async resumeCleanup(token: string, zoneRef: string, journal: ScopeCheckJournal, options: CloudflareCallOptions): Promise<CleanupResult> {
    const pending = journal.current();
    if (!pending) return { cleaned: true };
    try {
      let recordId = pending.recordId;
      if (!recordId) {
        let records: DnsRecord[];
        try {
          records = await this.recordsAt(token, zoneRef, pending.name, options);
        } catch (error: unknown) {
          if (error instanceof CloudflareApiError && error.kind === 'not_found' && !isLocationRefusal(error)) {
            // The zone itself is gone, and the record with it.
            journal.write(null);
            return { cleaned: true };
          }
          throw error;
        }
        const match = records.find((r) => r.type === 'TXT' && typeof r.content === 'string' && unquote(r.content) === pending.content);
        if (!match) {
          // A create that timed out a moment ago may still land; wait before declaring it lost.
          if (this.now() - pending.createdAt < LATE_CREATE_WINDOW_MS) return { cleaned: false, cause: 'too_recent' };
          journal.write(null);
          return { cleaned: true };
        }
        if (typeof match.id !== 'string' || !CLOUDFLARE_ID.test(match.id)) return { cleaned: false, cause: 'unexpected' };
        recordId = match.id;
      }
      await this.deleteRecord(token, zoneRef, recordId, options);
      journal.write(null);
      return { cleaned: true };
    } catch (error: unknown) {
      if (error instanceof CloudflareApiError) return { cleaned: false, cause: cleanupCause(error) };
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
    const recordName = checkRecordName(controlIdentity, zone.name);
    const leftover = journal.current();
    if (leftover) {
      const cleanup = await this.resumeCleanup(token, zone.zoneRef, journal, options);
      if (!cleanup.cleaned) return { kind: 'cleanup_pending', recordName: leftover.name, cause: cleanup.cause };
    }

    let existing: DnsRecord[];
    try {
      existing = await this.recordsAt(token, zone.zoneRef, recordName, options);
    } catch (error: unknown) {
      if (error instanceof CloudflareApiError && error.kind === 'forbidden' && !isLocationRefusal(error)) return { kind: 'missing' };
      return { kind: 'failed', ...failureFrom(error) };
    }
    if (existing.length > 0) {
      const type = typeof existing[0].type === 'string' ? existing[0].type : 'unknown';
      return { kind: 'conflict', recordName, recordType: type };
    }

    const pending: PendingScopeCheck = {
      name: recordName,
      content: `sencho-scope-check:${crypto.randomBytes(8).toString('hex')}`,
      recordId: null,
      createdAt: this.now(),
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
        return { kind: 'cleanup_pending', recordName, cause: 'unexpected' };
      }
      recordId = created.result.id;
    } catch (error: unknown) {
      if (!(error instanceof CloudflareApiError)) throw error;
      // Cloudflare refused, or Sencho never sent it: nothing was created.
      const notCreated = error.preSend || error.kind === 'forbidden' || error.kind === 'unauthorized'
        || error.kind === 'bad_request' || error.kind === 'not_found' || error.kind === 'rate_limited' || error.kind === 'budget_exhausted';
      if (notCreated) {
        journal.write(null);
        if (error.kind === 'forbidden' && !isLocationRefusal(error)) return { kind: 'missing' };
        return { kind: 'failed', ...failureFrom(error) };
      }
      // Timeout, 5xx or a dropped connection after sending: the record may exist. Keep the journal.
      return { kind: 'cleanup_pending', recordName, cause: 'ambiguous_create' };
    }

    journal.write({ ...pending, recordId });
    try {
      await this.deleteRecord(token, zone.zoneRef, recordId, options);
    } catch (error: unknown) {
      if (error instanceof CloudflareApiError) return { kind: 'cleanup_pending', recordName, cause: cleanupCause(error) };
      throw error;
    }
    journal.write(null);
    return { kind: 'confirmed' };
  }

  private async verifyToken(token: string, accountId: string, options: CloudflareCallOptions): Promise<void> {
    let verified: TokenVerifyResult;
    try {
      verified = (await this.client.request<TokenVerifyResult>(token, { ...options, method: 'GET', path: '/user/tokens/verify' })).result ?? {};
    } catch (userError: unknown) {
      if (!(userError instanceof CloudflareApiError)) throw userError;
      if (isLocationRefusal(userError)) throw stop('token_location_refused', userError.message);
      if (stopOutcomeFor(userError) !== null) throw userError;
      // An account-owned token verifies only at its account.
      try {
        verified = (await this.client.request<TokenVerifyResult>(token, { ...options, method: 'GET', path: `/accounts/${accountId}/tokens/verify` })).result ?? {};
      } catch (accountError: unknown) {
        if (!(accountError instanceof CloudflareApiError)) throw accountError;
        if (isLocationRefusal(accountError)) throw stop('token_location_refused', accountError.message);
        if (stopOutcomeFor(accountError) !== null) throw accountError;
        // The account endpoint knows the token but not this account: the id is wrong, not the token.
        if (accountError.kind === 'forbidden' || accountError.kind === 'not_found') {
          throw stop('account_not_accessible', `Account ${accountId} is not reachable with this token. Check the account ID.`);
        }
        throw stop('token_invalid', 'Cloudflare rejects this token.');
      }
    }
    if (verified.status !== 'active') {
      const status = typeof verified.status === 'string' ? verified.status : 'not active';
      const expires = typeof verified.expires_on === 'string' ? verified.expires_on : null;
      throw stop('token_inactive', expires ? `Token is ${status}; it expires or expired on ${expires}.` : `Token is ${status}.`);
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
    if (!match) throw stop('account_not_accessible', `Account ${accountId} is not visible to this token.`);
    return { listed: true, name: typeof match.name === 'string' ? match.name : null };
  }

  private async listZonesOrRefusal(token: string, accountId: string, options: CloudflareCallOptions): Promise<{ refused: boolean; list: ListedZone[] }> {
    try {
      const zones = await this.client.paginate<{ id?: unknown; name?: unknown }>(token, '/zones', { 'account.id': accountId }, 50, options);
      const list = zones
        .filter((z): z is { id: string; name: string } => typeof z.id === 'string' && CLOUDFLARE_ID.test(z.id) && typeof z.name === 'string')
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

  private async probeDnsRead(token: string, zones: readonly ZoneProbeInput[], options: CloudflareCallOptions): Promise<AccountFacts['zoneDns']> {
    const result: AccountFacts['zoneDns'] = {};
    for (let i = 0; i < zones.length; i += MAX_PARALLEL_DNS_PROBES) {
      const batch = zones.slice(i, i + MAX_PARALLEL_DNS_PROBES);
      const states = await Promise.all(batch.map(async (zone): Promise<Exclude<ZoneDnsState, 'unconfirmed'>> => {
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
