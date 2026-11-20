import { Button } from '@/components/ui/button';
import { BusyButton } from '@/components/ui/busy-button';
import { StatusPath } from '@/components/ui/status-path';
import type { PublicExposureAccount } from '@/hooks/usePublicExposureAccount';
import { cloudflareAccountStatus, formatCheckDate, type AccountStatus, type AccountVerb } from '@/lib/cloudflareAccountStatus';
import type { ConnectedAccountView } from '@/lib/publicExposureApi';

const VERB_LABEL: Record<AccountVerb['kind'], string> = {
  connect: 'Connect account',
  replace: 'Replace token',
  recheck: 'Recheck',
  choose_zones: 'Choose zones',
  dns_check: 'Check DNS write',
};

export interface AccountStatusPathProps {
  account: PublicExposureAccount;
  recheckWait: number;
  onVerb: (verb: AccountVerb) => void;
}

/** Answer, path, proof for the account. Shared by the card and the sheet's Overview. */
export function AccountStatusPath({ account, recheckWait, onVerb }: AccountStatusPathProps) {
  if (!account.view) return null;
  const status = cloudflareAccountStatus(account.view);
  const view = account.view.connected ? account.view : null;
  const verb = status.verb;
  const action = verb ? (
    verb.kind === 'recheck' ? (
      <BusyButton
        size="sm"
        variant="outline"
        pending={account.pending === 'recheck'}
        disabled={recheckWait > 0 || (account.pending !== null && account.pending !== 'recheck')}
        onClick={() => onVerb(verb)}
      >
        {recheckWait > 0 ? `Recheck in ${recheckWait} s` : VERB_LABEL.recheck}
      </BusyButton>
    ) : (
      <Button size="sm" variant={verb.kind === 'connect' ? 'default' : 'outline'} disabled={account.pending !== null} onClick={() => onVerb(verb)}>
        {VERB_LABEL[verb.kind]}
      </Button>
    )
  ) : undefined;

  return (
    <StatusPath
      data-testid="cloudflare-account-status"
      answer={{ ...status.answer, action, 'data-testid': 'cloudflare-account-answer' }}
      stages={status.stages}
      proof={view ? { label: 'Connection evidence', children: <AccountProof view={view} status={status} /> } : undefined}
    />
  );
}

function AccountProof({ view, status }: { view: ConnectedAccountView; status: AccountStatus }) {
  const rows: Array<[string, string]> = [
    ['Account', view.accountId],
    ['Connected', `${view.connectedBy} · ${formatCheckDate(view.connectedAt)}`],
    ['Verified', view.verifiedAt ? formatCheckDate(view.verifiedAt) : 'not yet'],
    ['Last check', `${view.lastCheck.outcome.replace(/_/g, ' ')} · ${formatCheckDate(view.lastCheck.at)}${view.lastCheck.detail ? ` · ${view.lastCheck.detail}` : ''}`],
    ['Cloudflare Tunnel', view.scopes.tunnel === 'missing' ? 'missing' : 'readable; Edit permission is checked when the first node joins Cloudflare Tunnel'],
  ];
  return (
    <div className="flex flex-col gap-3 font-mono text-[11px]">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-stat-subtitle">{label}</dt>
            <dd className="break-all text-stat-value">{value}</dd>
          </div>
        ))}
      </dl>
      {view.zones.some((z) => z.enabled) && (
        <div className="flex flex-col gap-1">
          <span className="uppercase tracking-[0.14em] text-stat-subtitle">DNS per enabled zone</span>
          {view.zones.filter((z) => z.enabled).map((zone) => (
            <div key={zone.zoneRef} className="flex justify-between gap-3 border-t border-card-border/40 pt-1">
              <span className="text-stat-value">{zone.name}</span>
              <span className="text-stat-subtitle">
                {zone.dns}{zone.dnsCheckedAt ? ` · ${formatCheckDate(zone.dnsCheckedAt)}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
      {status.problems.length > 1 && (
        <div className="flex flex-col gap-1">
          <span className="uppercase tracking-[0.14em] text-stat-subtitle">Every open item</span>
          <ul className="flex flex-col gap-0.5">
            {status.problems.map((problem, index) => (
              <li key={`${problem.status}-${index}`} className="text-stat-value">{problem.line}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
