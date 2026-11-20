import { useEffect, useState, type FormEvent } from 'react';
import { Plus, RefreshCw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { BusyButton } from '@/components/ui/busy-button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmModal } from '@/components/ui/modal';
import { SheetSection, SystemSheet } from '@/components/ui/system-sheet';
import { TogglePill } from '@/components/ui/toggle-pill';
import type { PublicExposureAccount } from '@/hooks/usePublicExposureAccount';
import type { AccountVerb } from '@/lib/cloudflareAccountStatus';
import { cloudflareAccountStatus, formatCheckDate } from '@/lib/cloudflareAccountStatus';
import type { PublicExposureZone } from '@/lib/publicExposureApi';
import { formatTimeAgo } from '@/lib/relativeTime';
import { suffixProblem } from '@/lib/exposureHostnames';
import { AccountStatusPath } from './CloudflareAccountStatusPath';

export type CloudflareSheetMode = 'view' | 'connect' | 'replace';
export type CloudflareSheetTab = 'overview' | 'zones';

export interface CloudflareAccountSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: CloudflareSheetMode;
  onModeChange: (mode: CloudflareSheetMode) => void;
  tab: CloudflareSheetTab;
  onTabChange: (tab: CloudflareSheetTab) => void;
  account: PublicExposureAccount;
  recheckWait: number;
  onVerb: (verb: AccountVerb) => void;
  onRequestDnsCheck: (zoneRef: string) => void;
}

/**
 * Connect, replace and zones for the hub's Cloudflare account, in one sheet.
 * Every verb goes through the shared account state the card passes in.
 */
export function CloudflareAccountSheet({
  open, onOpenChange, mode, onModeChange, tab, onTabChange, account, recheckWait, onVerb, onRequestDnsCheck,
}: CloudflareAccountSheetProps) {
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const view = account.view?.connected ? account.view : null;
  // The Answer on the Overview carries its own resolving verb; the toolbar does not repeat it there.
  const answerVerb = account.view && tab === 'overview' ? cloudflareAccountStatus(account.view).verb?.kind : undefined;

  return (
    <>
      <SystemSheet
        open={open}
        onOpenChange={onOpenChange}
        crumb={['Networking', 'Public exposure', 'Cloudflare']}
        name={view ? view.accountName ?? `Account ${view.accountId.slice(0, 8)}` : 'Connect an account'}
        meta={view ? `account ${view.accountId.slice(0, 8)} · Cloudflare Tunnel` : 'not connected'}
        secondaryActions={view ? [
          ...(answerVerb === 'recheck' ? [] : [{ label: recheckWait > 0 ? `Recheck in ${recheckWait} s` : 'Recheck', icon: RefreshCw, onClick: () => onVerb({ kind: 'recheck' }), pending: account.pending === 'recheck', disabled: recheckWait > 0 || account.pending !== null }]),
          ...(answerVerb === 'replace' ? [] : [{ label: 'Replace token', onClick: () => { onModeChange('replace'); onTabChange('overview'); }, disabled: account.pending !== null }]),
        ] : undefined}
        destructiveAction={view ? { label: 'Disconnect', onClick: () => setConfirmDisconnect(true), disabled: account.pending !== null } : undefined}
        tabs={view ? [{ id: 'overview', label: 'Overview' }, { id: 'zones', label: 'Zones', count: view.zones.length }] : undefined}
        activeTab={view ? tab : undefined}
        onTabChange={(id) => onTabChange(id as CloudflareSheetTab)}
        footerContext={view ? `Checked ${formatTimeAgo(view.lastCheck.at)}` : undefined}
        size="md"
      >
        {!view && (
          <TokenForm
            key="connect"
            title="Connect · Cloudflare"
            submitLabel="Connect account"
            initialAccountId=""
            account={account}
            onDone={() => onOpenChange(false)}
          />
        )}
        {view && tab === 'overview' && (
          <>
            <SheetSection title="Status">
              <AccountStatusPath account={account} recheckWait={recheckWait} onVerb={onVerb} />
            </SheetSection>
            {mode === 'replace' && (
              <TokenForm
                key="replace"
                title="Replace token"
                submitLabel="Replace token"
                initialAccountId={view.accountId}
                account={account}
                onDone={() => onModeChange('view')}
                onCancel={() => onModeChange('view')}
              />
            )}
          </>
        )}
        {view && tab === 'zones' && (
          <ZonesSection zones={view.zones} account={account} onRequestDnsCheck={onRequestDnsCheck} />
        )}
      </SystemSheet>
      <ConfirmModal
        open={confirmDisconnect}
        onOpenChange={setConfirmDisconnect}
        variant="destructive"
        kicker="Cloudflare · Disconnect"
        title="Disconnect the Cloudflare account"
        description="Sencho removes the token and the zone choices from this control instance. In Cloudflare it deletes only a leftover permission-check record, if one is pending (when its zone can no longer be reached, the disconnect still goes through and names the record that stays); nothing else is deleted there, and the token stays valid until you revoke it."
        confirmLabel="Disconnect"
        busyConfirmLabel="Disconnecting…"
        confirming={account.pending === 'disconnect'}
        onConfirm={async () => {
          const done = await account.disconnect();
          setConfirmDisconnect(false);
          if (done) onOpenChange(false);
        }}
      />
    </>
  );
}

interface TokenFormProps {
  title: string;
  submitLabel: string;
  initialAccountId: string;
  account: PublicExposureAccount;
  onDone: () => void;
  onCancel?: () => void;
}

/** The write-only token form. The token lives only in this form's state and is cleared on submit and unmount. */
function TokenForm({ title, submitLabel, initialAccountId, account, onDone, onCancel }: TokenFormProps) {
  const [accountId, setAccountId] = useState(initialAccountId);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => setToken(''), []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const sent = token;
    setToken('');
    setError(null);
    const message = await account.connect(sent, accountId.trim());
    if (message) setError(message);
    else onDone();
  };

  return (
    <SheetSection title={title}>
      <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)} data-testid="cloudflare-token-form">
        <p className="text-sm text-stat-subtitle">
          Sencho sends the token only to api.cloudflare.com and stores it encrypted on this control instance. It is never shown again.
        </p>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cf-account-id">Account ID</Label>
          <Input
            id="cf-account-id"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            placeholder="32 hexadecimal characters"
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cf-api-token">API token</Label>
          <Input
            id="cf-api-token"
            type="password"
            autoComplete="new-password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="Cloudflare API token"
            spellCheck={false}
          />
          <p className="text-xs text-stat-subtitle">
            Give it Account › Cloudflare Tunnel › Edit, and Zone › DNS › Edit plus Zone › Zone › Read on the zones Sencho may use.
          </p>
        </div>
        {error && <p role="alert" data-testid="cloudflare-token-error" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          {onCancel && <Button type="button" size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
          <BusyButton
            type="submit"
            size="sm"
            pending={account.pending === 'connect'}
            busyLabel="Checking with Cloudflare…"
            disabled={token.trim().length === 0 || accountId.trim().length === 0 || (account.pending !== null && account.pending !== 'connect')}
          >
            {submitLabel}
          </BusyButton>
        </div>
      </form>
    </SheetSection>
  );
}

interface ZonesSectionProps {
  zones: PublicExposureZone[];
  account: PublicExposureAccount;
  onRequestDnsCheck: (zoneRef: string) => void;
}

function ZonesSection({ zones, account, onRequestDnsCheck }: ZonesSectionProps) {
  const [editing, setEditing] = useState<PublicExposureZone | null>(null);

  if (zones.length === 0) {
    return (
      <SheetSection title="Zones">
        <p className="text-sm text-stat-subtitle">This token sees no zones. Give it access to a zone in Cloudflare, then recheck.</p>
      </SheetSection>
    );
  }

  return (
    <SheetSection title="Zones" meta={`${zones.filter((z) => z.enabled).length} enabled`}>
      <p className="mb-3 text-sm text-stat-subtitle">
        An enabled zone may carry public hostnames for services on any node.
      </p>
      <ul className="flex flex-col">
        {zones.map((zone) => (
          <li key={zone.zoneRef} data-testid={`zone-row-${zone.name}`} className="flex flex-wrap items-center gap-3 border-t border-card-border/40 py-2.5 first:border-t-0">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-sm text-stat-value">{zone.name}</div>
              <div className="font-mono text-[11px] text-stat-subtitle">
                {zoneSummary(zone)}
              </div>
            </div>
            {zone.enabled && (
              <>
                {(zone.dns === 'unconfirmed' || zone.dns === 'readable') && !zone.cleanupPending && (
                  <Button size="sm" variant="outline" disabled={account.pending !== null} onClick={() => onRequestDnsCheck(zone.zoneRef)}>
                    Check DNS write
                  </Button>
                )}
                <Button size="sm" variant="ghost" disabled={account.pending !== null} onClick={() => setEditing(zone)}>
                  Edit suffixes
                </Button>
              </>
            )}
            <TogglePill
              checked={zone.enabled}
              aria-label={`${zone.enabled ? 'Disable' : 'Enable'} ${zone.name}`}
              disabled={account.pending !== null}
              onChange={(next) => {
                if (next) setEditing(zone);
                else void account.setZone(zone.zoneRef, false, zone.allowedSuffixes);
              }}
            />
          </li>
        ))}
      </ul>
      {editing && (
        <ZoneEnableModal
          key={editing.zoneRef}
          zone={editing}
          account={account}
          onClose={() => setEditing(null)}
        />
      )}
    </SheetSection>
  );
}

function zoneSummary(zone: PublicExposureZone): string {
  const parts: string[] = [];
  if (zone.enabled) {
    parts.push(zone.allowedSuffixes.length > 0 ? `under ${zone.allowedSuffixes.join(', ')}` : 'any name');
    parts.push(zone.dns === 'confirmed' && zone.dnsCheckedAt ? `DNS confirmed ${formatCheckDate(zone.dnsCheckedAt)}` : `DNS ${zone.dns}`);
    if (zone.cleanupPending) parts.push('check record left');
    if (!zone.seenAtLastCheck) parts.push('not visible to this token');
  } else {
    parts.push('not enabled');
    if (zone.cleanupPending) parts.push('check record left');
  }
  return parts.join(' · ');
}

interface ZoneEnableModalProps {
  zone: PublicExposureZone;
  account: PublicExposureAccount;
  onClose: () => void;
}

/** The preview for enabling a zone or changing its suffixes: it names what stack editors may then claim. */
function ZoneEnableModal({ zone, account, onClose }: ZoneEnableModalProps) {
  const [suffixes, setSuffixes] = useState<string[]>(zone.allowedSuffixes);
  const cleaned = suffixes.map((s) => s.trim().toLowerCase().replace(/\.$/, '')).filter(Boolean);
  const problems = suffixes.map((s) => (s.trim() ? suffixProblem(s, zone.name) : null));
  const invalid = problems.some(Boolean);
  const claimable = cleaned.length > 0 ? `names under: ${[...new Set(cleaned)].join(', ')}` : `any unclaimed name in ${zone.name}, including ${zone.name} itself`;

  return (
    <ConfirmModal
      open
      onOpenChange={(open) => { if (!open) onClose(); }}
      size="md"
      kicker="Cloudflare · Zone"
      title={zone.enabled ? `Suffixes for ${zone.name}` : `Enable ${zone.name}`}
      description={`Stack editors can then claim ${claimable}.`}
      confirmLabel={zone.enabled ? 'Save suffixes' : 'Enable zone'}
      busyConfirmLabel="Saving…"
      confirming={account.pending === 'zone'}
      confirmDisabled={invalid}
      onConfirm={async () => {
        const failed = await account.setZone(zone.zoneRef, true, [...new Set(cleaned)]);
        if (!failed) onClose();
      }}
    >
      <div className="flex flex-col gap-2" data-testid="zone-suffix-editor">
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-stat-subtitle">Hostname suffixes (optional)</span>
        {suffixes.map((suffix, index) => (
          <div key={index} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Input
                aria-label={`Suffix ${index + 1}`}
                value={suffix}
                placeholder={`apps.${zone.name}`}
                className="font-mono"
                spellCheck={false}
                onChange={(event) => setSuffixes((list) => list.map((s, i) => (i === index ? event.target.value : s)))}
              />
              <Button type="button" size="sm" variant="ghost" aria-label={`Remove suffix ${index + 1}`} onClick={() => setSuffixes((list) => list.filter((_, i) => i !== index))}>
                <X className="h-3.5 w-3.5" strokeWidth={1.5} />
              </Button>
            </div>
            {problems[index] && <p className="text-xs text-destructive">{problems[index]}</p>}
          </div>
        ))}
        {suffixes.length < 20 && (
          <Button type="button" size="sm" variant="outline" className="w-fit" onClick={() => setSuffixes((list) => [...list, ''])}>
            <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />Add suffix
          </Button>
        )}
      </div>
    </ConfirmModal>
  );
}
