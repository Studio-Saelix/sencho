import { DatabaseService } from '../DatabaseService';
import { CHECK_OUTCOMES, CLEANUP_CAUSES, CLOUDFLARE_ID, type AccountScopes, type CheckOutcome, type CleanupCause, type LastCheck, type PendingScopeCheck, type ScopeState, type ZoneDnsState } from './types';

/**
 * SQL for the public exposure hub tables. Rows are parsed into typed records
 * here; the credential column is read only by `getCredential` and never
 * appears on a record another module could spread into a response.
 */

export interface AccountRecord {
  id: number;
  adapterId: string;
  accountId: string;
  accountName: string | null;
  /** When the last complete zone listing ran; zones seen then carry this as their last_seen_at. */
  zonesListedAt: number | null;
  scopes: AccountScopes;
  lastCheck: LastCheck;
  verifiedAt: number | null;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface ZoneRecord {
  zoneRef: string;
  name: string;
  enabled: boolean;
  allowedSuffixes: string[];
  dns: ZoneDnsState;
  dnsCheckedAt: number | null;
  pending: PendingScopeCheck | null;
  /**
   * The journal column holds something that is not a readable journal. The
   * zone still has a check record that may be in Cloudflare, so it counts as
   * pending (`hasCheckRecord`) even though there is no record to read.
   */
  journalUnreadable: boolean;
  lastSeenAt: number;
}

/** True while a permission-check record may still exist in Cloudflare for this zone. */
export function hasCheckRecord(zone: ZoneRecord): boolean {
  return zone.pending !== null || zone.journalUnreadable;
}

interface AccountRow {
  id: number;
  adapter_id: string;
  config_json: string;
  scopes_json: string;
  last_check_json: string;
  verified_at: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

interface ZoneRow {
  zone_ref: string;
  name: string;
  enabled: number;
  allowed_suffixes_json: string;
  dns_scope: string;
  dns_checked_at: number | null;
  scope_check_pending_json: string | null;
  last_seen_at: number;
}

const SCOPE_STATES: readonly ScopeState[] = ['unconfirmed', 'confirmed', 'missing'];
const DNS_STATES: readonly ZoneDnsState[] = ['unconfirmed', 'readable', 'confirmed', 'missing'];

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function scopeState(value: unknown): ScopeState {
  return SCOPE_STATES.includes(value as ScopeState) ? (value as ScopeState) : 'unconfirmed';
}

function dnsState(value: unknown): ZoneDnsState {
  return DNS_STATES.includes(value as ZoneDnsState) ? (value as ZoneDnsState) : 'unconfirmed';
}

function parseLastCheck(text: string): LastCheck {
  const raw = asRecord(parseJson(text));
  // An outcome this build does not know (a corrupted or newer row) reads as unexpected, never as ok.
  const known = CHECK_OUTCOMES.includes(raw.outcome as CheckOutcome);
  const check: LastCheck = {
    outcome: known ? (raw.outcome as CheckOutcome) : 'unexpected_response',
    at: typeof raw.at === 'number' ? raw.at : 0,
    detail: typeof raw.detail === 'string' ? raw.detail : null,
  };
  if (typeof raw.retryAfterSeconds === 'number') check.retryAfterSeconds = raw.retryAfterSeconds;
  if (raw.limitedBy === 'sencho' || raw.limitedBy === 'cloudflare') check.limitedBy = raw.limitedBy;
  return check;
}

/** A NULL column is no journal. Anything else that is not a name and content is an unreadable journal, never an empty one. */
function parsePending(text: string | null): { pending: PendingScopeCheck | null; unreadable: boolean } {
  if (text === null) return { pending: null, unreadable: false };
  const record = asRecord(parseJson(text));
  if (typeof record.name !== 'string' || typeof record.content !== 'string') return { pending: null, unreadable: true };
  const pending: PendingScopeCheck = {
    name: record.name,
    content: record.content,
    // A stored id that is not a Cloudflare id is no handle: cleanup finds the record by name and content instead.
    recordId: typeof record.recordId === 'string' && CLOUDFLARE_ID.test(record.recordId) ? record.recordId : null,
    createdAt: typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) && record.createdAt > 0 ? record.createdAt : 0,
  };
  if (CLEANUP_CAUSES.includes(record.cause as CleanupCause)) pending.cause = record.cause as CleanupCause;
  return { pending, unreadable: false };
}

function toAccount(row: AccountRow): AccountRecord {
  const config = asRecord(parseJson(row.config_json));
  const scopes = asRecord(parseJson(row.scopes_json));
  return {
    id: row.id,
    adapterId: row.adapter_id,
    accountId: typeof config.accountId === 'string' ? config.accountId : '',
    accountName: typeof config.accountName === 'string' ? config.accountName : null,
    zonesListedAt: typeof config.zonesListedAt === 'number' ? config.zonesListedAt : null,
    scopes: { zoneRead: scopeState(scopes.zoneRead), tunnel: scopeState(scopes.tunnel) },
    lastCheck: parseLastCheck(row.last_check_json),
    verifiedAt: row.verified_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toZone(row: ZoneRow): ZoneRecord {
  const suffixes = parseJson(row.allowed_suffixes_json);
  const journal = parsePending(row.scope_check_pending_json);
  return {
    zoneRef: row.zone_ref,
    name: row.name,
    enabled: row.enabled === 1,
    allowedSuffixes: Array.isArray(suffixes) ? suffixes.filter((s): s is string => typeof s === 'string') : [],
    dns: dnsState(row.dns_scope),
    dnsCheckedAt: row.dns_checked_at,
    pending: journal.pending,
    journalUnreadable: journal.unreadable,
    lastSeenAt: row.last_seen_at,
  };
}

const ACCOUNT_COLUMNS = 'id, adapter_id, config_json, scopes_json, last_check_json, verified_at, created_by, created_at, updated_at';
const ZONE_COLUMNS = 'zone_ref, name, enabled, allowed_suffixes_json, dns_scope, dns_checked_at, scope_check_pending_json, last_seen_at';

function configJson(input: { accountId: string; accountName: string | null; zonesListedAt: number | null }): string {
  return JSON.stringify({ accountId: input.accountId, accountName: input.accountName, zonesListedAt: input.zonesListedAt });
}

function db() {
  return DatabaseService.getInstance().getDb();
}

export const publicExposureStore = {
  transaction<T>(fn: () => T): T {
    return db().transaction(fn)();
  },

  getAccount(adapterId: string): AccountRecord | null {
    const row = db().prepare(`SELECT ${ACCOUNT_COLUMNS} FROM exposure_accounts WHERE adapter_id = ?`).get(adapterId) as AccountRow | undefined;
    return row ? toAccount(row) : null;
  },

  /** The stored ciphertext. Only the account service reads it, to decrypt for a Cloudflare call. */
  getCredential(accountRowId: number): string | null {
    const row = db().prepare('SELECT credential_enc FROM exposure_accounts WHERE id = ?').get(accountRowId) as { credential_enc: string } | undefined;
    return row?.credential_enc ?? null;
  },

  insertAccount(input: {
    adapterId: string;
    credentialEnc: string;
    accountId: string;
    accountName: string | null;
    zonesListedAt: number | null;
    scopes: AccountScopes;
    lastCheck: LastCheck;
    verifiedAt: number | null;
    createdBy: string;
    now: number;
  }): number {
    const result = db().prepare(
      `INSERT INTO exposure_accounts (adapter_id, credential_enc, config_json, scopes_json, last_check_json, verified_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.adapterId,
      input.credentialEnc,
      configJson(input),
      JSON.stringify(input.scopes),
      JSON.stringify(input.lastCheck),
      input.verifiedAt,
      input.createdBy,
      input.now,
      input.now,
    );
    return Number(result.lastInsertRowid);
  },

  updateCredential(accountRowId: number, credentialEnc: string, now: number): void {
    db().prepare('UPDATE exposure_accounts SET credential_enc = ?, updated_at = ? WHERE id = ?').run(credentialEnc, now, accountRowId);
  },

  updateCheck(accountRowId: number, input: {
    accountId: string;
    accountName: string | null;
    zonesListedAt: number | null;
    scopes: AccountScopes;
    lastCheck: LastCheck;
    verifiedAt: number | null;
    now: number;
  }): void {
    db().prepare(
      'UPDATE exposure_accounts SET config_json = ?, scopes_json = ?, last_check_json = ?, verified_at = ?, updated_at = ? WHERE id = ?',
    ).run(
      configJson(input),
      JSON.stringify(input.scopes),
      JSON.stringify(input.lastCheck),
      input.verifiedAt,
      input.now,
      accountRowId,
    );
  },

  updateLastCheck(accountRowId: number, lastCheck: LastCheck, now: number): void {
    db().prepare('UPDATE exposure_accounts SET last_check_json = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(lastCheck), now, accountRowId);
  },

  deleteAccount(accountRowId: number): void {
    db().prepare('DELETE FROM exposure_zones WHERE account_id = ?').run(accountRowId);
    db().prepare('DELETE FROM exposure_accounts WHERE id = ?').run(accountRowId);
  },

  countEndpoints(): number {
    const row = db().prepare('SELECT COUNT(*) AS n FROM exposure_node_endpoints').get() as { n: number };
    return row.n;
  },

  listZones(accountRowId: number): ZoneRecord[] {
    const rows = db().prepare(`SELECT ${ZONE_COLUMNS} FROM exposure_zones WHERE account_id = ? ORDER BY name`).all(accountRowId) as ZoneRow[];
    return rows.map(toZone);
  },

  getZone(accountRowId: number, zoneRef: string): ZoneRecord | null {
    const row = db().prepare(`SELECT ${ZONE_COLUMNS} FROM exposure_zones WHERE account_id = ? AND zone_ref = ?`).get(accountRowId, zoneRef) as ZoneRow | undefined;
    return row ? toZone(row) : null;
  },

  /** Upsert a listed zone. Touches only the provider columns, never enablement or suffixes. */
  upsertListedZone(accountRowId: number, zoneRef: string, name: string, seenAt: number): void {
    db().prepare(
      `INSERT INTO exposure_zones (account_id, zone_ref, name, last_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id, zone_ref) DO UPDATE SET name = excluded.name, last_seen_at = excluded.last_seen_at`,
    ).run(accountRowId, zoneRef, name, seenAt);
  },

  deleteZone(accountRowId: number, zoneRef: string): void {
    db().prepare('DELETE FROM exposure_zones WHERE account_id = ? AND zone_ref = ?').run(accountRowId, zoneRef);
  },

  setZoneEnablement(accountRowId: number, zoneRef: string, enabled: boolean, suffixes: string[]): void {
    db().prepare('UPDATE exposure_zones SET enabled = ?, allowed_suffixes_json = ? WHERE account_id = ? AND zone_ref = ?')
      .run(enabled ? 1 : 0, JSON.stringify(suffixes), accountRowId, zoneRef);
  },

  setZoneDns(accountRowId: number, zoneRef: string, dns: ZoneDnsState, checkedAt: number | null): void {
    db().prepare('UPDATE exposure_zones SET dns_scope = ?, dns_checked_at = ? WHERE account_id = ? AND zone_ref = ?')
      .run(dns, checkedAt, accountRowId, zoneRef);
  },

  /** A token change resets every write proof; a proof made with another token says nothing about this one. */
  resetZoneWriteProofs(accountRowId: number): void {
    db().prepare(`UPDATE exposure_zones SET dns_scope = 'unconfirmed', dns_checked_at = NULL WHERE account_id = ?`).run(accountRowId);
  },

  /** A new token makes the last failed cleanup's cause stale: drop it from every journal that can be read; the next attempt writes a fresh one. */
  clearCleanupCauses(accountRowId: number): void {
    db().prepare(
      `UPDATE exposure_zones SET scope_check_pending_json = json_remove(scope_check_pending_json, '$.cause')
       WHERE account_id = ? AND scope_check_pending_json IS NOT NULL AND json_valid(scope_check_pending_json)`,
    ).run(accountRowId);
  },

  setZonePending(accountRowId: number, zoneRef: string, pending: PendingScopeCheck | null): void {
    db().prepare('UPDATE exposure_zones SET scope_check_pending_json = ? WHERE account_id = ? AND zone_ref = ?')
      .run(pending ? JSON.stringify(pending) : null, accountRowId, zoneRef);
  },
};
