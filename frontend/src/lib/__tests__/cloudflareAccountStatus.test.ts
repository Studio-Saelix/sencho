import { describe, it, expect } from 'vitest';
import { cloudflareAccountStatus } from '../cloudflareAccountStatus';
import type { CheckOutcome, ConnectedAccountView, PublicExposureZone } from '../publicExposureApi';

const ACCOUNT = 'a1'.repeat(16);
const T = Date.UTC(2026, 10, 19);

function zone(overrides: Partial<PublicExposureZone> = {}): PublicExposureZone {
  return {
    zoneRef: 'c3'.repeat(16), name: 'example.com', enabled: true, allowedSuffixes: [], dns: 'confirmed',
    dnsCheckedAt: T, seenAtLastCheck: true, cleanupPending: null, checkRecordName: '_sencho-check-x.example.com',
    ...overrides,
  };
}

function view(overrides: Partial<ConnectedAccountView> = {}): ConnectedAccountView {
  return {
    connected: true, provider: 'cloudflare-tunnel', accountId: ACCOUNT, accountName: 'Example',
    scopes: { zoneRead: 'confirmed', tunnel: 'unconfirmed' },
    lastCheck: { outcome: 'ok', at: T, detail: null },
    verifiedAt: T, connectedBy: 'admin', connectedAt: T, zonesVisible: 1, zones: [zone()], nodeEndpointCount: 0,
    ...overrides,
  };
}

const failed = (outcome: CheckOutcome, extra: Partial<ConnectedAccountView['lastCheck']> = {}) =>
  view({ lastCheck: { outcome, at: T + 1, detail: null, ...extra } });

describe('cloudflareAccountStatus', () => {
  it('asks to connect when no account is connected, with no stages', () => {
    const status = cloudflareAccountStatus({ connected: false });
    expect(status.answer).toMatchObject({ tone: 'neutral', status: 'not_connected' });
    expect(status.verb).toEqual({ kind: 'connect' });
    expect(status.stages).toEqual([]);
  });

  it.each([
    ['credential_unreadable', 'destructive', 'replace', 'cannot be read'],
    ['token_invalid', 'destructive', 'replace', 'rejects the stored token'],
    ['token_inactive', 'destructive', 'replace', 'disabled or expired'],
    ['token_location_refused', 'destructive', 'recheck', "this control instance's address"],
    ['account_not_accessible', 'destructive', 'replace', `cannot reach account ${ACCOUNT}`],
    ['cloudflare_unreachable', 'warning', 'recheck', 'Could not reach api.cloudflare.com'],
    ['unexpected_response', 'warning', 'recheck', 'could not read'],
  ] as const)('maps %s to its own Answer and verb', (outcome, tone, verb, text) => {
    const status = cloudflareAccountStatus(failed(outcome));
    expect(status.answer.status).toBe(outcome);
    expect(status.answer.tone).toBe(tone);
    expect(status.answer.line).toContain(text);
    expect(status.verb?.kind).toBe(verb);
  });

  it('tells a Cloudflare rate limit from Sencho\'s own, and carries the wait', () => {
    const cf = cloudflareAccountStatus(failed('rate_limited', { retryAfterSeconds: 30 }));
    expect(cf.answer.line).toContain('Cloudflare is limiting requests. Recheck after 30 s.');
    expect(cf.verb).toEqual({ kind: 'recheck', waitSeconds: 30 });
    const own = cloudflareAccountStatus(failed('rate_limited', { limitedBy: 'sencho' }));
    expect(own.answer.line).toContain("Sencho's own Cloudflare request limit");
  });

  it.each([
    ['tunnel_missing', view({ scopes: { zoneRead: 'confirmed', tunnel: 'missing' } }), 'Cloudflare Tunnel: Edit', 'recheck'],
    ['zone_read_missing', view({ scopes: { zoneRead: 'missing', tunnel: 'unconfirmed' } }), 'Zone: Read', 'recheck'],
    ['dns_missing', view({ zones: [zone({ dns: 'missing' })] }), 'DNS: Edit for this zone', 'recheck'],
    ['cleanup_pending', view({ zones: [zone({ cleanupPending: { recordName: 'r', note: null } })] }), 'permission-check record may be left in example.com', 'recheck'],
    ['zone_not_visible', view({ zones: [zone({ seenAtLastCheck: false })] }), 'example.com is not visible', 'choose_zones'],
    ['no_zones_visible', view({ zonesVisible: 0, zones: [] }), 'sees no zones', 'recheck'],
    ['no_zone_enabled', view({ zones: [zone({ enabled: false })] }), 'Choose the zones', 'choose_zones'],
    ['dns_unconfirmed', view({ zones: [zone({ dns: 'readable', dnsCheckedAt: null })] }), 'Confirm that the token can edit DNS in example.com', 'dns_check'],
  ] as const)('maps %s to its Answer and verb', (status, v, text, verb) => {
    const result = cloudflareAccountStatus(v);
    expect(result.answer.status).toBe(status);
    expect(result.answer.line).toContain(text);
    expect(result.verb?.kind).toBe(verb);
  });

  it('says a zero-second wait instead of reading it as absent', () => {
    expect(cloudflareAccountStatus(failed('rate_limited', { retryAfterSeconds: 0 })).answer.line).toContain('Recheck after 0 s.');
  });

  it('never reads an outcome it does not know as healthy', () => {
    const status = cloudflareAccountStatus(failed('future_state' as CheckOutcome));
    expect(status.answer.status).toBe('unexpected_response');
    expect(status.answer.tone).toBe('warning');
  });

  it('shows a leftover check record on a disabled zone, with the DNS stage', () => {
    const status = cloudflareAccountStatus(view({
      zones: [zone({ dns: 'confirmed' }), zone({ zoneRef: 'd4'.repeat(16), name: 'example.net', enabled: false, cleanupPending: { recordName: 'r', note: null } })],
      zonesVisible: 2,
    }));
    expect(status.answer.status).toBe('cleanup_pending');
    expect(status.answer.line).toContain('example.net');
    expect(status.stages.find((s) => s.id === 'dns')?.word).toBe('cleanup pending');
  });

  it('carries the cause of the latest failed cleanup in the pending line, and nothing extra before one failed', () => {
    const note = 'Cloudflare refused the delete. Fix the token, or delete the record in Cloudflare, then try again.';
    const withNote = cloudflareAccountStatus(view({ zones: [zone({ cleanupPending: { recordName: 'r', note } })] }));
    expect(withNote.answer.line).toBe(`A permission-check record may be left in example.com. ${note}`);
    expect(withNote.problems[0].detail).toBe('r');
    const without = cloudflareAccountStatus(view({ zones: [zone({ cleanupPending: { recordName: 'r', note: null } })] }));
    expect(without.answer.line).toBe('A permission-check record may be left in example.com.');
  });

  it('reports an unseen zone as not visible rather than by its stale DNS state', () => {
    const status = cloudflareAccountStatus(view({ zones: [zone({ dns: 'missing', seenAtLastCheck: false })] }));
    expect(status.answer.status).toBe('zone_not_visible');
    expect(status.stages.find((s) => s.id === 'dns')?.word).not.toBe('missing');
  });

  it('reports success with the confirmed zone count and no verb', () => {
    const status = cloudflareAccountStatus(view());
    expect(status.answer).toMatchObject({ tone: 'success', status: 'connected', line: 'Connected to Example. DNS confirmed in 1 zone.' });
    expect(status.verb).toBeNull();
    expect(status.answer.line).not.toMatch(/ready|verified/i);
  });

  it('names the first problem and counts the rest', () => {
    const status = cloudflareAccountStatus(view({
      scopes: { zoneRead: 'confirmed', tunnel: 'missing' },
      zones: [zone({ dns: 'missing' }), zone({ zoneRef: 'd4'.repeat(16), name: 'example.net', dns: 'unconfirmed' })],
      zonesVisible: 2,
    }));
    expect(status.answer.status).toBe('tunnel_missing');
    expect(status.answer.detail).toBe('and 2 more');
    expect(status.problems.map((p) => p.status)).toEqual(['tunnel_missing', 'dns_missing', 'dns_unconfirmed']);
  });

  it('puts a token failure ahead of every scope problem', () => {
    const status = cloudflareAccountStatus(view({
      lastCheck: { outcome: 'token_invalid', at: T, detail: null },
      scopes: { zoneRead: 'missing', tunnel: 'missing' },
    }));
    expect(status.answer.status).toBe('token_invalid');
  });

  it('marks a failed recheck stale and keeps the last facts', () => {
    const status = cloudflareAccountStatus(failed('cloudflare_unreachable'));
    expect(status.answer.marker).toBe('last checked 2026-11-19');
    expect(cloudflareAccountStatus(view()).answer.marker).toBeUndefined();
  });

  it('omits the DNS stage when no zone is enabled, and shows the proof date when confirmed', () => {
    const none = cloudflareAccountStatus(view({ zones: [zone({ enabled: false })] }));
    expect(none.stages.map((s) => s.id)).toEqual(['token', 'zones', 'tunnel']);
    const confirmed = cloudflareAccountStatus(view());
    expect(confirmed.stages.find((s) => s.id === 'dns')?.word).toBe('confirmed 2026-11-19');
    expect(confirmed.stages.find((s) => s.id === 'tunnel')?.word).toBe('readable');
  });

  it('gives a blocking stage its line unless it is already the Answer', () => {
    const status = cloudflareAccountStatus(view({
      scopes: { zoneRead: 'confirmed', tunnel: 'missing' },
      zones: [zone({ dns: 'missing' })],
    }));
    expect(status.stages.find((s) => s.id === 'tunnel')?.line).toBeUndefined();
    expect(status.stages.find((s) => s.id === 'dns')?.line).toContain('DNS: Edit');
  });
});
