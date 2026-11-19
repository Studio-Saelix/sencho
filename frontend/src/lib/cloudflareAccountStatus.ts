import type { StatusPathStage } from '@/components/ui/status-path';
import type { StatusTone } from '@/lib/statusTone';
import type { ConnectedAccountView, PublicExposureAccountView, PublicExposureZone } from '@/lib/publicExposureApi';

/**
 * Maps the hub's Cloudflare account view to Answer, path, proof. Pure, so
 * every state and its precedence is unit-tested without rendering.
 *
 * The Answer names the first problem in table order and counts the rest; the
 * Proof lists all of them. No Answer says "ready" or "verified": Sencho claims
 * only what it proved with the current token.
 */

export type AccountVerb =
  | { kind: 'connect' }
  | { kind: 'replace' }
  | { kind: 'recheck'; waitSeconds?: number }
  | { kind: 'choose_zones' }
  | { kind: 'dns_check'; zoneRef: string; zoneName: string };

export interface AccountProblem {
  status: string;
  tone: StatusTone;
  title: string;
  line: string;
  detail?: string | null;
  verb: AccountVerb;
  /** The Path stage this problem belongs to, so the stage does not repeat the Answer. */
  stage: StageId;
}

export interface AccountStatus {
  answer: {
    status: string;
    tone: StatusTone;
    title: string;
    line: string;
    detail: string | null;
    marker?: string;
  };
  verb: AccountVerb | null;
  stages: StatusPathStage[];
  problems: AccountProblem[];
}

type StageId = 'token' | 'zones' | 'dns' | 'tunnel';

export function formatCheckDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function enabledZones(view: ConnectedAccountView): PublicExposureZone[] {
  return view.zones.filter((zone) => zone.enabled);
}

/** Every problem the view shows, in Answer precedence order. */
export function accountProblems(view: ConnectedAccountView): AccountProblem[] {
  const problems: AccountProblem[] = [];
  const { lastCheck } = view;
  const replace: AccountVerb = { kind: 'replace' };
  const recheck: AccountVerb = { kind: 'recheck' };

  switch (lastCheck.outcome) {
    case 'credential_unreadable':
      problems.push({ status: 'credential_unreadable', tone: 'destructive', title: 'Token unreadable', line: 'The stored token cannot be read on this control instance.', verb: replace, stage: 'token' });
      break;
    case 'token_invalid':
      problems.push({ status: 'token_invalid', tone: 'destructive', title: 'Token rejected', line: 'Cloudflare rejects the stored token.', verb: replace, stage: 'token' });
      break;
    case 'token_inactive':
      problems.push({ status: 'token_inactive', tone: 'destructive', title: 'Token inactive', line: 'The stored token is disabled or expired.', detail: lastCheck.detail, verb: replace, stage: 'token' });
      break;
    case 'token_location_refused':
      problems.push({ status: 'token_location_refused', tone: 'destructive', title: 'Address refused', line: "Cloudflare refuses this token from this control instance's address. Allow its address on the token in Cloudflare.", verb: recheck, stage: 'token' });
      break;
    case 'account_not_accessible':
      problems.push({ status: 'account_not_accessible', tone: 'destructive', title: 'Account not reachable', line: `This token cannot reach account ${view.accountId}.`, verb: replace, stage: 'token' });
      break;
    case 'cloudflare_unreachable':
      problems.push({ status: 'cloudflare_unreachable', tone: 'warning', title: 'Cloudflare unreachable', line: 'Could not reach api.cloudflare.com. Showing the last checked state.', detail: lastCheck.detail, verb: recheck, stage: 'token' });
      break;
    case 'rate_limited': {
      const wait = lastCheck.retryAfterSeconds;
      const own = lastCheck.detail?.includes("Sencho's own request limit") === true;
      const who = own ? "Sencho's own Cloudflare request limit was reached." : 'Cloudflare is limiting requests.';
      problems.push({
        status: 'rate_limited', tone: 'warning', title: 'Rate limited',
        line: wait ? `${who} Recheck after ${wait} s.` : `${who} Recheck in a moment.`,
        verb: { kind: 'recheck', waitSeconds: wait }, stage: 'token',
      });
      break;
    }
    case 'unexpected_response':
      problems.push({ status: 'unexpected_response', tone: 'warning', title: 'Unexpected response', line: 'Cloudflare sent a response Sencho could not read.', detail: lastCheck.detail, verb: recheck, stage: 'token' });
      break;
    case 'ok':
      break;
  }

  if (view.scopes.tunnel === 'missing') {
    problems.push({ status: 'tunnel_missing', tone: 'warning', title: 'Tunnel permission missing', line: 'The token has no Cloudflare Tunnel permission. Add Cloudflare Tunnel: Edit to it in Cloudflare.', verb: recheck, stage: 'tunnel' });
  }
  if (view.scopes.zoneRead === 'missing') {
    problems.push({ status: 'zone_read_missing', tone: 'warning', title: 'Zone read missing', line: 'The token cannot list zones. Add Zone: Read to it in Cloudflare.', verb: recheck, stage: 'zones' });
  }
  const enabled = enabledZones(view);
  for (const zone of enabled.filter((z) => z.dns === 'missing')) {
    problems.push({ status: 'dns_missing', tone: 'warning', title: 'DNS edit missing', line: `The token cannot edit DNS in ${zone.name}. Add DNS: Edit for this zone in Cloudflare.`, verb: recheck, stage: 'dns' });
  }
  for (const zone of enabled.filter((z) => z.cleanupPending)) {
    problems.push({ status: 'cleanup_pending', tone: 'warning', title: 'Cleanup pending', line: `A permission-check record is left in ${zone.name}.`, detail: zone.cleanupPending?.recordName ?? null, verb: recheck, stage: 'dns' });
  }
  for (const zone of enabled.filter((z) => !z.seenAtLastCheck)) {
    problems.push({ status: 'zone_not_visible', tone: 'warning', title: 'Zone not visible', line: `${zone.name} is not visible to this token.`, verb: { kind: 'choose_zones' }, stage: 'zones' });
  }
  if (view.scopes.zoneRead !== 'missing' && view.zonesVisible === 0) {
    problems.push({ status: 'no_zones_visible', tone: 'warning', title: 'No zones visible', line: `This token sees no zones in account ${view.accountId}. Give it access to a zone in Cloudflare.`, verb: recheck, stage: 'zones' });
  }
  if (enabled.length === 0 && view.zonesVisible > 0) {
    problems.push({ status: 'no_zone_enabled', tone: 'neutral', title: 'Choose zones', line: 'Choose the zones that may carry public hostnames.', verb: { kind: 'choose_zones' }, stage: 'zones' });
  }
  for (const zone of enabled.filter((z) => z.dns === 'unconfirmed' || z.dns === 'readable')) {
    problems.push({ status: 'dns_unconfirmed', tone: 'neutral', title: 'DNS write unconfirmed', line: `Confirm that the token can edit DNS in ${zone.name}.`, verb: { kind: 'dns_check', zoneRef: zone.zoneRef, zoneName: zone.name }, stage: 'dns' });
  }
  return problems;
}

const TOKEN_STAGE_WORD: Record<string, string> = {
  credential_unreadable: 'unreadable',
  token_invalid: 'rejected',
  token_inactive: 'inactive',
  token_location_refused: 'address refused',
  account_not_accessible: 'no account access',
};

function stagesFor(view: ConnectedAccountView, problems: AccountProblem[], answerStage: StageId): StatusPathStage[] {
  const blocking = (stage: StageId) => problems.find((p) => p.stage === stage && p.tone !== 'neutral');
  const lineFor = (stage: StageId) => (stage === answerStage ? undefined : blocking(stage)?.line);
  const outcome = view.lastCheck.outcome;
  const stages: StatusPathStage[] = [];

  const tokenWord = outcome === 'ok' ? 'valid' : TOKEN_STAGE_WORD[outcome] ?? 'not rechecked';
  const tokenTone: StatusTone = outcome === 'ok' ? 'success' : TOKEN_STAGE_WORD[outcome] ? 'destructive' : 'warning';
  stages.push({ id: 'token', label: 'Token', tone: tokenTone, word: tokenWord, status: outcome, line: lineFor('token') });

  const enabled = enabledZones(view);
  let zonesWord: string;
  let zonesTone: StatusTone;
  if (view.scopes.zoneRead === 'missing') { zonesWord = 'not readable'; zonesTone = 'warning'; }
  else if (view.zonesVisible === 0) { zonesWord = 'none visible'; zonesTone = 'warning'; }
  else if (enabled.some((z) => !z.seenAtLastCheck)) { zonesWord = 'not visible'; zonesTone = 'warning'; }
  else if (enabled.length === 0) { zonesWord = 'none enabled'; zonesTone = 'neutral'; }
  else { zonesWord = `${enabled.length} enabled`; zonesTone = 'success'; }
  stages.push({ id: 'zones', label: 'Zones', tone: zonesTone, word: zonesWord, line: lineFor('zones') });

  if (enabled.length > 0) {
    let dnsWord: string;
    let dnsTone: StatusTone;
    if (enabled.some((z) => z.dns === 'missing')) { dnsWord = 'missing'; dnsTone = 'warning'; }
    else if (enabled.some((z) => z.cleanupPending)) { dnsWord = 'cleanup pending'; dnsTone = 'warning'; }
    else if (enabled.every((z) => z.dns === 'confirmed')) {
      const oldest = Math.min(...enabled.map((z) => z.dnsCheckedAt ?? Date.now()));
      dnsWord = `confirmed ${formatCheckDate(oldest)}`;
      dnsTone = 'success';
    } else { dnsWord = 'unconfirmed'; dnsTone = 'neutral'; }
    stages.push({ id: 'dns', label: 'DNS', tone: dnsTone, word: dnsWord, line: lineFor('dns') });
  }

  const tunnelMissing = view.scopes.tunnel === 'missing';
  stages.push({
    id: 'tunnel', label: 'Cloudflare Tunnel', tone: tunnelMissing ? 'warning' : 'neutral', word: tunnelMissing ? 'missing' : 'readable',
    title: tunnelMissing ? undefined : 'Edit permission is checked when the first node joins Cloudflare Tunnel.',
    line: lineFor('tunnel'),
  });
  return stages;
}

export function cloudflareAccountStatus(view: PublicExposureAccountView): AccountStatus {
  if (!view.connected) {
    return {
      answer: { status: 'not_connected', tone: 'neutral', title: 'Not connected', line: 'Connect a Cloudflare account to publish services through Cloudflare Tunnel.', detail: null },
      verb: { kind: 'connect' },
      stages: [],
      problems: [],
    };
  }
  const problems = accountProblems(view);
  const stale = view.lastCheck.outcome !== 'ok' && view.verifiedAt !== null;
  const marker = stale ? `last checked ${formatCheckDate(view.verifiedAt ?? 0)}` : undefined;
  const first = problems[0];
  if (!first) {
    const confirmed = enabledZones(view).filter((z) => z.dns === 'confirmed').length;
    return {
      answer: {
        status: 'connected', tone: 'success', title: 'Connected',
        line: `Connected to ${view.accountName ?? view.accountId}. DNS confirmed in ${plural(confirmed, 'zone')}.`,
        detail: null, marker,
      },
      verb: null,
      stages: stagesFor(view, problems, 'token'),
      problems,
    };
  }
  const more = problems.length - 1;
  const detail = [first.detail ?? null, more > 0 ? `and ${more} more` : null].filter(Boolean).join(' · ') || null;
  return {
    answer: { status: first.status, tone: first.tone, title: first.title, line: first.line, detail, marker },
    verb: first.verb,
    stages: stagesFor(view, problems, first.stage),
    problems,
  };
}
