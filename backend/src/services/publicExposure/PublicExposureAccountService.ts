import { CryptoService } from '../CryptoService';
import { FleetSyncService } from '../FleetSyncService';
import { errorMessageForLog } from '../../utils/safeLog';
import { recordPublicExposureAudit, type PublicExposureAuditContext } from './audit';
import { CloudflareAccountAdapter, checkRecordName, type AccountCheckResult, type ScopeCheckJournal } from './cloudflareAccountAdapter';
import type { CloudflareCallOptions } from './cloudflareApiClient';
import { validateAllowedSuffixes } from './exposureHostnames';
import { publicExposureStore as store, type AccountRecord, type ZoneRecord } from './publicExposureStore';
import {
  CLOUDFLARE_ADAPTER_ID,
  PublicExposureError,
  type CheckOutcome,
  type EnabledZoneView,
  type LastCheck,
  type PublicExposureAccountView,
} from './types';

/** A whole connect, recheck or DNS check finishes within this, below common reverse-proxy timeouts. */
const OPERATION_TIMEOUT_MS = 45_000;

const OUTCOME_ERRORS: Record<Exclude<CheckOutcome, 'ok'>, { code: PublicExposureError['code']; status: number; message: string }> = {
  token_invalid: { code: 'TOKEN_INVALID', status: 422, message: 'Cloudflare rejects this token.' },
  token_inactive: { code: 'TOKEN_INACTIVE', status: 422, message: 'This token is disabled or expired in Cloudflare.' },
  token_location_refused: { code: 'TOKEN_LOCATION_REFUSED', status: 422, message: "Cloudflare refuses this token from this control instance's address." },
  account_not_accessible: { code: 'ACCOUNT_NOT_ACCESSIBLE', status: 422, message: 'This token cannot reach that Cloudflare account.' },
  credential_unreadable: { code: 'CREDENTIAL_UNREADABLE', status: 422, message: 'The stored token cannot be read on this control instance.' },
  cloudflare_unreachable: { code: 'CLOUDFLARE_UNREACHABLE', status: 502, message: 'Could not reach api.cloudflare.com.' },
  unexpected_response: { code: 'UNEXPECTED_RESPONSE', status: 502, message: 'Cloudflare sent a response Sencho could not read.' },
  rate_limited: { code: 'CLOUDFLARE_RATE_LIMITED', status: 503, message: 'Cloudflare is limiting requests. Try again shortly.' },
};

function outcomeError(outcome: Exclude<CheckOutcome, 'ok'>, detail: string | null, retryAfterSeconds?: number): PublicExposureError {
  const mapped = OUTCOME_ERRORS[outcome];
  const message = detail && detail !== mapped.message ? `${mapped.message} ${detail}` : mapped.message;
  return new PublicExposureError(mapped.code, mapped.status, message, retryAfterSeconds);
}

function lastCheckFrom(result: AccountCheckResult, at: number): LastCheck {
  const check: LastCheck = { outcome: result.outcome, at, detail: result.detail };
  if (result.retryAfterSeconds !== undefined) check.retryAfterSeconds = result.retryAfterSeconds;
  return check;
}

/**
 * The hub's public exposure account: connect, replace, recheck, the DNS write
 * check, zone enablement and disconnect. Every write runs one at a time under
 * one in-process lock and one operation deadline. The token is encrypted at
 * rest, decrypted only for a Cloudflare call, and never returned.
 */
export class PublicExposureAccountService {
  private static instance: PublicExposureAccountService | null = null;
  private busy = false;

  static getInstance(): PublicExposureAccountService {
    if (!PublicExposureAccountService.instance) PublicExposureAccountService.instance = new PublicExposureAccountService();
    return PublicExposureAccountService.instance;
  }

  constructor(private readonly adapter: CloudflareAccountAdapter = new CloudflareAccountAdapter()) {}

  getView(): PublicExposureAccountView {
    const account = store.getAccount(CLOUDFLARE_ADAPTER_ID);
    if (!account) return { connected: false };
    let lastCheck = account.lastCheck;
    if (this.readToken(account) === null) {
      lastCheck = { outcome: 'credential_unreadable', at: Date.now(), detail: null };
    }
    const zones = store.listZones(account.id);
    const controlIdentity = FleetSyncService.getControlIdentity();
    const seen = (zone: ZoneRecord) => account.zonesListedAt !== null && zone.lastSeenAt === account.zonesListedAt;
    return {
      connected: true,
      provider: CLOUDFLARE_ADAPTER_ID,
      accountId: account.accountId,
      accountName: account.accountName,
      scopes: account.scopes,
      lastCheck,
      verifiedAt: account.verifiedAt,
      connectedBy: account.createdBy,
      connectedAt: account.createdAt,
      zonesVisible: zones.filter(seen).length,
      zones: zones.map((zone) => ({
        zoneRef: zone.zoneRef,
        name: zone.name,
        enabled: zone.enabled,
        allowedSuffixes: zone.allowedSuffixes,
        dns: zone.dns,
        dnsCheckedAt: zone.dnsCheckedAt,
        seenAtLastCheck: seen(zone),
        cleanupPending: zone.pending ? { recordName: zone.pending.name } : null,
        checkRecordName: checkRecordName(controlIdentity, zone.name),
      })),
      nodeEndpointCount: store.countEndpoints(),
    };
  }

  listEnabledZones(): EnabledZoneView[] {
    const account = store.getAccount(CLOUDFLARE_ADAPTER_ID);
    if (!account) return [];
    return store.listZones(account.id)
      .filter((zone) => zone.enabled)
      .map((zone) => ({ zoneRef: zone.zoneRef, name: zone.name, allowedSuffixes: zone.allowedSuffixes, dns: zone.dns }));
  }

  /**
   * Connect, or replace the token of the connected account. Nothing is stored
   * unless Cloudflare accepts the token and the account is reachable. A token
   * for a different account is refused until the account is disconnected.
   */
  async connect(token: string, accountId: string, actor: PublicExposureAuditContext): Promise<PublicExposureAccountView> {
    return this.exclusive(async (options) => {
      const existing = store.getAccount(CLOUDFLARE_ADAPTER_ID);
      if (existing && existing.accountId !== accountId) throw this.accountChangeRefusal(existing);
      // A replaced token starts with no write proof: probe from 'unconfirmed'.
      const enabled = existing ? store.listZones(existing.id).filter((z) => z.enabled).map((z) => ({ zoneRef: z.zoneRef, dns: 'unconfirmed' as const })) : [];

      const result = await this.adapter.checkAccount(token, accountId, enabled, options);
      if (result.outcome !== 'ok' || !result.facts) throw outcomeError(result.outcome === 'ok' ? 'unexpected_response' : result.outcome, result.detail, result.retryAfterSeconds);
      const facts = result.facts;

      const now = Date.now();
      const credentialEnc = CryptoService.getInstance().encrypt(token);
      const replaced = store.transaction(() => {
        const current = store.getAccount(CLOUDFLARE_ADAPTER_ID);
        if (current && current.accountId !== accountId) throw this.accountChangeRefusal(current);
        const lastCheck = lastCheckFrom(result, now);
        const zonesListedAt = facts.zones ? now : current?.zonesListedAt ?? null;
        let rowId: number;
        if (current) {
          rowId = current.id;
          store.updateCredential(rowId, credentialEnc, now);
          store.updateCheck(rowId, { accountId, accountName: facts.accountName, zonesListedAt, scopes: facts.scopes, lastCheck, verifiedAt: now, now });
          store.resetZoneWriteProofs(rowId);
        } else {
          rowId = store.insertAccount({
            adapterId: CLOUDFLARE_ADAPTER_ID, credentialEnc, accountId, accountName: facts.accountName, zonesListedAt,
            scopes: facts.scopes, lastCheck, verifiedAt: now, createdBy: actor.username, now,
          });
        }
        this.applyZoneFacts(rowId, result, now);
        return current !== null;
      });

      recordPublicExposureAudit(actor, replaced ? 'public_exposure.account.replaced' : 'public_exposure.account.connected', {
        account: accountId, result: result.outcome, zone_read: facts.scopes.zoneRead, tunnel: facts.scopes.tunnel,
      });
      return this.getView();
    });
  }

  /** Re-run every probe with the stored token. A failed check keeps the last facts and records the outcome. */
  async recheck(actor: PublicExposureAuditContext): Promise<PublicExposureAccountView> {
    return this.exclusive(async (options) => {
      const account = this.requireAccount();
      const token = this.readToken(account);
      const now = Date.now();
      if (token === null) {
        store.updateLastCheck(account.id, { outcome: 'credential_unreadable', at: now, detail: null }, now);
        recordPublicExposureAudit(actor, 'public_exposure.account.rechecked', { account: account.accountId, result: 'credential_unreadable' });
        return this.getView();
      }

      const zones = store.listZones(account.id);
      for (const zone of zones.filter((z) => z.pending)) {
        const cleaned = await this.adapter.resumeCleanup(token, zone.zoneRef, this.journalFor(account.id, zone), options);
        if (!cleaned) console.warn(`[PublicExposure] Permission-check record cleanup in zone ${zone.name} did not finish; it stays pending.`);
      }

      const enabled = zones.filter((z) => z.enabled).map((z) => ({ zoneRef: z.zoneRef, dns: z.dns }));
      const result = await this.adapter.checkAccount(token, account.accountId, enabled, options);
      const at = Date.now();
      store.transaction(() => {
        if (result.outcome === 'ok' && result.facts) {
          store.updateCheck(account.id, {
            accountId: account.accountId, accountName: result.facts.accountName,
            zonesListedAt: result.facts.zones ? at : account.zonesListedAt, scopes: result.facts.scopes,
            lastCheck: lastCheckFrom(result, at), verifiedAt: at, now: at,
          });
          this.applyZoneFacts(account.id, result, at);
        } else {
          store.updateLastCheck(account.id, lastCheckFrom(result, at), at);
        }
      });
      recordPublicExposureAudit(actor, 'public_exposure.account.rechecked', { account: account.accountId, result: result.outcome });
      return this.getView();
    });
  }

  /** The previewed, self-cleaning TXT write that proves DNS Edit in one enabled zone. */
  async dnsCheck(zoneRef: string, actor: PublicExposureAuditContext): Promise<PublicExposureAccountView> {
    return this.exclusive(async (options) => {
      const account = this.requireAccount();
      const zone = store.getZone(account.id, zoneRef);
      if (!zone) throw new PublicExposureError('ZONE_NOT_FOUND', 404, 'That zone is not in the connected account.');
      if (!zone.enabled) throw new PublicExposureError('ZONE_NOT_ENABLED', 409, 'Enable the zone before checking DNS write.');
      const token = this.readToken(account);
      if (token === null) throw outcomeError('credential_unreadable', null);
      const controlIdentity = FleetSyncService.getControlIdentity();
      if (!controlIdentity) throw new PublicExposureError('UNEXPECTED_RESPONSE', 500, 'This control instance has no identity yet, so the check record cannot be named.');

      const result = await this.adapter.proveDnsWrite(token, zone, controlIdentity, this.journalFor(account.id, zone), options);
      const at = Date.now();
      if (result.kind === 'confirmed' || result.kind === 'missing') {
        store.setZoneDns(account.id, zone.zoneRef, result.kind === 'confirmed' ? 'confirmed' : 'missing', at);
      }
      recordPublicExposureAudit(actor, 'public_exposure.account.dns_checked', {
        account: account.accountId, zone: zone.name, result: result.kind === 'failed' ? result.outcome : result.kind,
      });
      if (result.kind === 'conflict') {
        throw new PublicExposureError('SCOPE_CHECK_CONFLICT', 409, `A ${result.recordType} record Sencho did not create already exists at ${result.recordName}. Sencho writes nothing there.`);
      }
      if (result.kind === 'failed') throw outcomeError(result.outcome === 'ok' ? 'unexpected_response' : result.outcome, result.detail, result.retryAfterSeconds);
      return this.getView();
    });
  }

  /**
   * Remove the account and its zone rows. Refused while any node endpoint
   * exists or a check record cannot be cleaned up. Deletes nothing else in
   * Cloudflare; the token stays valid there until it is revoked.
   */
  async disconnect(actor: PublicExposureAuditContext): Promise<void> {
    await this.exclusive(async (options) => {
      const account = this.requireAccount();
      if (store.countEndpoints() > 0) throw this.endpointsRefusal();
      const pendingZones = store.listZones(account.id).filter((z) => z.pending);
      if (pendingZones.length > 0) {
        const token = this.readToken(account);
        for (const zone of pendingZones) {
          const cleaned = token !== null && await this.adapter.resumeCleanup(token, zone.zoneRef, this.journalFor(account.id, zone), options);
          if (!cleaned) {
            throw new PublicExposureError('CLEANUP_PENDING', 409, `The permission-check record ${zone.pending?.name ?? ''} could not be deleted from Cloudflare. Delete it there, or fix the token and try again.`);
          }
        }
      }
      store.transaction(() => {
        if (store.countEndpoints() > 0) throw this.endpointsRefusal();
        store.deleteAccount(account.id);
      });
      recordPublicExposureAudit(actor, 'public_exposure.account.removed', { account: account.accountId });
    });
  }

  /** Enable or disable a zone for public hostnames, optionally narrowed to suffixes. */
  async setZone(zoneRef: string, enabled: boolean, allowedSuffixes: string[], actor: PublicExposureAuditContext): Promise<PublicExposureAccountView> {
    return this.exclusive(async () => {
      const account = this.requireAccount();
      const zone = store.getZone(account.id, zoneRef);
      if (!zone) throw new PublicExposureError('ZONE_NOT_FOUND', 404, 'That zone is not in the connected account.');
      const validation = validateAllowedSuffixes(allowedSuffixes, zone.name);
      if (!validation.ok) throw new PublicExposureError('INVALID_INPUT', 400, validation.message);
      store.setZoneEnablement(account.id, zone.zoneRef, enabled, validation.suffixes);
      recordPublicExposureAudit(actor, enabled ? 'public_exposure.zone.enabled' : 'public_exposure.zone.disabled', {
        account: account.accountId, zone: zone.name, suffixes: validation.suffixes.length > 0 ? validation.suffixes.join(',') : null,
      });
      return this.getView();
    });
  }

  private requireAccount(): AccountRecord {
    const account = store.getAccount(CLOUDFLARE_ADAPTER_ID);
    if (!account) throw new PublicExposureError('NOT_CONNECTED', 404, 'No Cloudflare account is connected.');
    return account;
  }

  private readToken(account: AccountRecord): string | null {
    const stored = store.getCredential(account.id);
    if (!stored) return null;
    const crypto = CryptoService.getInstance();
    if (!crypto.isEncrypted(stored)) return null;
    try {
      return crypto.decrypt(stored);
    } catch (error: unknown) {
      console.warn('[PublicExposure] The stored Cloudflare token cannot be decrypted:', errorMessageForLog(error));
      return null;
    }
  }

  private accountChangeRefusal(existing: AccountRecord): PublicExposureError {
    return new PublicExposureError(
      'ACCOUNT_CHANGE_NEEDS_DISCONNECT', 409,
      `This token is for a different Cloudflare account. Disconnect account ${existing.accountId} first.`,
    );
  }

  private endpointsRefusal(): PublicExposureError {
    return new PublicExposureError('ENDPOINTS_EXIST', 409, 'Nodes still use this Cloudflare account. Remove their Cloudflare Tunnel endpoints first.');
  }

  private journalFor(accountRowId: number, zone: ZoneRecord): ScopeCheckJournal {
    let current = zone.pending;
    return {
      current: () => current,
      write: (pending) => {
        current = pending;
        store.setZonePending(accountRowId, zone.zoneRef, pending);
      },
    };
  }

  /** Apply probe results to zone rows. Reconciles the zone list only after a complete listing. */
  private applyZoneFacts(accountRowId: number, result: AccountCheckResult, now: number): void {
    const facts = result.facts;
    if (!facts) return;
    if (facts.zones) {
      const listed = new Set(facts.zones.map((z) => z.zoneRef));
      for (const zone of facts.zones) store.upsertListedZone(accountRowId, zone.zoneRef, zone.name, now);
      for (const zone of store.listZones(accountRowId)) {
        if (!listed.has(zone.zoneRef) && !zone.enabled && !zone.pending) store.deleteZone(accountRowId, zone.zoneRef);
      }
    }
    for (const [zoneRef, dns] of Object.entries(facts.zoneDns)) {
      const zone = store.getZone(accountRowId, zoneRef);
      if (!zone) continue;
      const checkedAt = dns === 'confirmed' ? zone.dnsCheckedAt : now;
      store.setZoneDns(accountRowId, zoneRef, dns, checkedAt);
    }
  }

  private async exclusive<T>(run: (options: CloudflareCallOptions) => Promise<T>): Promise<T> {
    if (this.busy) throw new PublicExposureError('ACCOUNT_BUSY', 409, 'Another Cloudflare account action is running. Try again when it finishes.');
    this.busy = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OPERATION_TIMEOUT_MS);
    try {
      return await run({ signal: controller.signal, deadlineAt: Date.now() + OPERATION_TIMEOUT_MS });
    } finally {
      clearTimeout(timer);
      this.busy = false;
    }
  }
}
