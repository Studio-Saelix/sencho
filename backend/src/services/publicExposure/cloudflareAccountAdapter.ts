import crypto from 'crypto';
import {
  CloudflareApiError,
  cloudflareApiClient,
  type CloudflareApiClient,
  type CloudflareCallOptions,
} from './cloudflareApiClient';
import type { AccountScopes, CleanupCause, FailedOutcome, LastCheck, PendingScopeCheck, ZoneDnsState } from './types';

export type { CleanupCause };

/**
 * The account part of the Cloudflare adapter: token verification, the account
 * check, zone listing, the read probes, and the self-cleaning DNS write check.
 * It maps Cloudflare's answers to Sencho's named states and stores nothing;
 * the account service persists what it returns.
 *
 * A real-account run settled two mappings (ADR §9, Q1). Cloudflare answers a
 * plain missing permission with code 9109, the code its location refusal
 * uses too, so only the message tells them apart. A token without account
 * read gets an empty `/accounts` listing, not a refusal, so a missing id there
 * proves nothing on its own; a mistyped account id makes the zone listing
 * answer 400 with code 70503. Still assumed: that the account verify answers
 * 404 for an account id the token does not belong to (a 403 there is read as
 * a rejected token), and that a deleted zone answers 404.
 */

/** The message Cloudflare sends with a token used from an address its IP filter does not allow. Its code, 9109, is shared with plain refusals. */
const LOCATION_REFUSED_MESSAGE = /cannot use the access token from location/i;
/** Cloudflare's code when a zone listing filters on an account id it does not know ("account with given Tag doesn't exist"). */
const ACCOUNT_UNKNOWN_CODE = 70503;
/** 400 codes that name the account id itself as wrong: unknown account, or an invalid object identifier (7003). */
const ACCOUNT_ID_ERROR_CODES: readonly number[] = [ACCOUNT_UNKNOWN_CODE, 7003];
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
  status: string;
  expires_on?: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTokenVerifyResult(value: unknown): value is TokenVerifyResult {
  return isObject(value) && typeof value.status === 'string';
}

/** A Cloudflare success whose body Sencho cannot read stops a check as unexpected; nothing is reconciled from it. */
function malformed(what: string): CloudflareApiError {
  return new CloudflareApiError({ kind: 'invalid_response', message: `Cloudflare answered without ${what} Sencho could read.` });
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
  return LOCATION_REFUSED_MESSAGE.test(error.message);
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
    // A token refused after it verified (revoked mid-check) is a rejected token, not an unreadable answer.
    if (error.kind === 'unauthorized') return { outcome: 'token_invalid', detail: null };
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
  if (error.kind === 'forbidden' && !isLocationRefusal(error)) return 'zone_refused';
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
      // permissions: the account listing is refused, empty or lacks the id, the
      // account-scoped tunnel probe is refused, and the account's zone listing
      // is refused or empty. (A mistyped id usually stops earlier, at the zone
      // listing's 400 with code 70503.)
      if (!account.listed && tunnelRefused && (zones.refused || zones.list.length === 0)) {
        throw stop('account_not_accessible', null);
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
          // The journal is the only handle on a record that may differ from what was journaled. Records
          // at the name that are none of ours keep it; only an empty name proves nothing was created.
          if (records.length > 0) return { cleaned: false, cause: 'unmatched' };
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
   * Settle a zone whose journal column cannot be read. The record's name is
   * rebuilt from the control identity (`name`, null when there is none); the
   * journal is cleared only when Cloudflare lists nothing at that name. Records
   * there are never deleted, since the journaled content that proves one is
   * ours is gone.
   */
  async resumeUnreadableCleanup(token: string, zoneRef: string, name: string | null, journal: ScopeCheckJournal, options: CloudflareCallOptions): Promise<CleanupResult> {
    if (name === null) return { cleaned: false, cause: 'unreadable_journal' };
    try {
      const records = await this.recordsAt(token, zoneRef, name, options);
      if (records.length > 0) return { cleaned: false, cause: 'unmatched' };
    } catch (error: unknown) {
      // A zone that is gone took its records with it.
      if (!(error instanceof CloudflareApiError && error.kind === 'not_found' && !isLocationRefusal(error))) {
        if (error instanceof CloudflareApiError) return { cleaned: false, cause: cleanupCause(error) };
        throw error;
      }
    }
    journal.write(null);
    return { cleaned: true };
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
      if (error instanceof CloudflareApiError) {
        // The token just wrote to this zone, so a 403 here is a refused delete, not a zone out of reach.
        const cause = cleanupCause(error);
        return { kind: 'cleanup_pending', recordName, cause: cause === 'zone_refused' ? 'refused' : cause };
      }
      throw error;
    }
    journal.write(null);
    return { kind: 'confirmed' };
  }

  private async verifyToken(token: string, accountId: string, options: CloudflareCallOptions): Promise<void> {
    let verified: unknown;
    try {
      verified = (await this.client.request<unknown>(token, { ...options, method: 'GET', path: '/user/tokens/verify' })).result;
    } catch (userError: unknown) {
      if (!(userError instanceof CloudflareApiError)) throw userError;
      if (isLocationRefusal(userError)) throw stop('token_location_refused', userError.message);
      if (stopOutcomeFor(userError) !== null) throw userError;
      // An account-owned token verifies only at its account.
      try {
        verified = (await this.client.request<unknown>(token, { ...options, method: 'GET', path: `/accounts/${accountId}/tokens/verify` })).result;
      } catch (accountError: unknown) {
        if (!(accountError instanceof CloudflareApiError)) throw accountError;
        if (isLocationRefusal(accountError)) throw stop('token_location_refused', accountError.message);
        if (stopOutcomeFor(accountError) !== null) throw accountError;
        // The account endpoint answers 404 for an account the token does not belong to: the id is wrong, not the token.
        if (accountError.kind === 'not_found') throw stop('account_not_accessible', null);
        // A malformed or unknown account id can also answer 400 with an id error instead of 404.
        if (accountError.kind === 'bad_request' && accountError.cfCodes.some((code) => ACCOUNT_ID_ERROR_CODES.includes(code))) {
          throw stop('account_not_accessible', null);
        }
        throw stop('token_invalid', null);
      }
    }
    // A success with no readable status says nothing about the token: unexpected, not inactive.
    if (!isTokenVerifyResult(verified)) throw malformed('a token status');
    if (verified.status !== 'active') {
      const expires = typeof verified.expires_on === 'string' ? verified.expires_on : null;
      throw stop('token_inactive', expires ? `Token is ${verified.status}; it expires or expired on ${expires}.` : `Token is ${verified.status}.`);
    }
  }

  private async findAccount(token: string, accountId: string, options: CloudflareCallOptions): Promise<{ listed: boolean; name: string | null }> {
    let accounts: Array<{ id: string; name?: unknown }>;
    try {
      const listed = await this.client.paginate<unknown>(token, '/accounts', {}, 50, options);
      if (!listed.every((a): a is { id: string; name?: unknown } => isObject(a) && typeof a.id === 'string')) throw malformed('an account list');
      accounts = listed;
    } catch (error: unknown) {
      if (isRefusal(error)) return { listed: false, name: null };
      throw error;
    }
    // A token without account read lists no accounts: an id missing here is decided by the account-scoped probes.
    const match = accounts.find((a) => a.id === accountId);
    if (!match) return { listed: false, name: null };
    return { listed: true, name: typeof match.name === 'string' ? match.name : null };
  }

  private async listZonesOrRefusal(token: string, accountId: string, options: CloudflareCallOptions): Promise<{ refused: boolean; list: ListedZone[] }> {
    try {
      const zones = await this.client.paginate<unknown>(token, '/zones', { 'account.id': accountId }, 50, options);
      // One unreadable element makes the whole listing unreadable: a filtered list would pass for a complete one.
      const list = zones.map((z) => {
        if (!isObject(z) || typeof z.id !== 'string' || !CLOUDFLARE_ID.test(z.id) || typeof z.name !== 'string') throw malformed('a zone list');
        return { zoneRef: z.id, name: z.name.toLowerCase() };
      });
      return { refused: false, list };
    } catch (error: unknown) {
      if (isRefusal(error)) return { refused: true, list: [] };
      if (error instanceof CloudflareApiError && error.kind === 'bad_request' && error.cfCodes.includes(ACCOUNT_UNKNOWN_CODE)) {
        throw stop('account_not_accessible', null);
      }
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
    const records = await this.client.paginate<unknown>(token, `/zones/${zoneRef}/dns_records`, { name }, 100, options);
    if (!records.every(isObject)) throw malformed('a record list');
    return records as DnsRecord[];
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
