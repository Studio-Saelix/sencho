import { useEffect, useState, type ReactNode } from 'react';
import { Cloud, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ConfirmModal } from '@/components/ui/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPath } from '@/components/ui/status-path';
import { useVisualBusy } from '@/hooks/useVisualBusy';
import type { PublicExposureAccount } from '@/hooks/usePublicExposureAccount';
import type { AccountVerb } from '@/lib/cloudflareAccountStatus';
import type { PublicExposureZone } from '@/lib/publicExposureApi';
import { AccountStatusPath } from './CloudflareAccountStatusPath';
import { CloudflareAccountSheet, type CloudflareSheetMode, type CloudflareSheetTab } from './CloudflareAccountSheet';

const KICKER = 'Public exposure · Control instance';

/** ConfirmModal's `description` is screen-reader-only, so the same sentence is also a visible body child. */
const DNS_CHECK_CONSEQUENCE = 'Sencho proves the token can edit DNS by creating one record and deleting it right away.';

/** Seconds until a rate-limited Recheck may run again, counting down once a second while it waits. */
function useRecheckWait(account: PublicExposureAccount): number {
  const view = account.view;
  const until = view?.connected && view.lastCheck.outcome === 'rate_limited' && view.lastCheck.retryAfterSeconds
    ? view.lastCheck.at + view.lastCheck.retryAfterSeconds * 1000
    : 0;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until <= 0) return;
    // Start from the current clock (a card mounted long ago holds a stale one), then tick each second.
    const tick = () => setNow(Date.now());
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(() => {
      tick();
      if (Date.now() >= until) window.clearInterval(id);
    }, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [until]);
  return until > now ? Math.ceil((until - now) / 1000) : 0;
}

/**
 * The hub's Cloudflare account on the Networking page: the body of the
 * Cloudflare tab, and the standalone block above the unavailable state when
 * the active node cannot load Networking. It belongs to the control instance
 * and serves every node, so it renders whichever node is active. The caller
 * owns the account state (the tab label reads it too) and mounts this only for
 * Admins signed into this instance with the experimental flag on.
 */
export function CloudflareAccountCard({ account, className }: { account: PublicExposureAccount; className?: string }) {
  const { showBusy } = useVisualBusy(account.loading);
  const recheckWait = useRecheckWait(account);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetMode, setSheetMode] = useState<CloudflareSheetMode>('view');
  const [sheetTab, setSheetTab] = useState<CloudflareSheetTab>('overview');
  const [dnsCheckZone, setDnsCheckZone] = useState<PublicExposureZone | null>(null);

  const openSheet = (mode: CloudflareSheetMode, tab: CloudflareSheetTab = 'overview') => {
    setSheetMode(mode);
    setSheetTab(tab);
    setSheetOpen(true);
  };

  const requestDnsCheck = (zoneRef: string) => {
    const view = account.view;
    if (!view?.connected) return;
    setDnsCheckZone(view.zones.find((z) => z.zoneRef === zoneRef) ?? null);
  };

  const runVerb = (verb: AccountVerb) => {
    switch (verb.kind) {
      case 'connect': openSheet('connect'); break;
      case 'replace': openSheet('replace'); break;
      case 'recheck': void account.recheck(); break;
      case 'choose_zones': openSheet('view', 'zones'); break;
      case 'dns_check': requestDnsCheck(verb.zoneRef); break;
    }
  };

  let body: ReactNode;
  if (account.loading) {
    body = showBusy ? <Skeleton data-testid="cloudflare-account-skeleton" className="h-[88px] w-full" /> : <div className="h-[88px]" />;
  } else if (!account.view) {
    body = (
      <StatusPath
        answer={{
          status: 'load_failed', tone: 'warning', title: 'Not loaded', line: 'Could not load the Cloudflare connection.',
          detail: account.loadError,
          action: <Button size="sm" variant="outline" onClick={() => void account.reload()}><RefreshCw className="h-3.5 w-3.5" strokeWidth={1.5} />Retry</Button>,
        }}
        stages={[]}
      />
    );
  } else {
    body = (
      <AccountStatusPath account={account} recheckWait={recheckWait} onVerb={runVerb} />
    );
  }

  const connected = account.view?.connected === true;
  return (
    <Card data-testid="cloudflare-account-card" className={className}>
      <CardContent className="flex flex-col gap-3 p-4 max-md:p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Cloud className="h-4 w-4 shrink-0 text-stat-subtitle" strokeWidth={1.5} aria-hidden />
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">{KICKER}</span>
          </div>
          {connected && (
            <Button size="sm" variant="ghost" className="h-7 px-2 font-mono text-[10px] uppercase tracking-[0.14em]" onClick={() => openSheet('view')}>
              Manage account
            </Button>
          )}
        </div>
        {body}
      </CardContent>
      <CloudflareAccountSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        mode={sheetMode}
        onModeChange={setSheetMode}
        tab={sheetTab}
        onTabChange={setSheetTab}
        account={account}
        recheckWait={recheckWait}
        onVerb={runVerb}
        onRequestDnsCheck={requestDnsCheck}
      />
      <ConfirmModal
        open={dnsCheckZone !== null}
        onOpenChange={(open) => { if (!open) setDnsCheckZone(null); }}
        kicker="Cloudflare · DNS write check"
        title={dnsCheckZone ? `Check DNS write in ${dnsCheckZone.name}` : 'Check DNS write'}
        description={DNS_CHECK_CONSEQUENCE}
        confirmLabel="Check DNS write"
        busyConfirmLabel="Checking…"
        confirmDisabled={!dnsCheckZone?.checkRecordName}
        confirming={account.pending === 'dns_check'}
        onConfirm={async () => {
          if (!dnsCheckZone) return;
          await account.dnsCheck(dnsCheckZone.zoneRef);
          setDnsCheckZone(null);
        }}
      >
        <p className="text-sm text-stat-subtitle" data-testid="dns-check-consequence">{DNS_CHECK_CONSEQUENCE}</p>
        {dnsCheckZone && (
          <dl data-testid="dns-check-preview" className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 font-mono text-[11px]">
            <dt className="text-stat-subtitle">Record</dt>
            <dd className="break-all text-stat-value">{dnsCheckZone.checkRecordName ?? 'not named yet: this control instance has no identity'}</dd>
            <dt className="text-stat-subtitle">Type</dt>
            <dd className="text-stat-value">TXT · TTL 60</dd>
            <dt className="text-stat-subtitle">Lifetime</dt>
            <dd className="text-stat-value">Deleted right away</dd>
            <dt className="text-stat-subtitle">Where</dt>
            <dd className="text-stat-value">At the zone {dnsCheckZone.name}, whatever its suffixes are</dd>
          </dl>
        )}
      </ConfirmModal>
    </Card>
  );
}
