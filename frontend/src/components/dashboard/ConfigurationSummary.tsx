import { useState } from 'react';
import { AlertCircle, Check, ChevronDown, ChevronRight, Minus } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { normalizeConfigurationAgents } from '@/lib/configurationStatus';
import type { SecurityTab } from '@/lib/events';
import type { SectionId } from '@/components/settings/types';
import { useConfigurationStatus } from './useConfigurationStatus';
import type { ConfigurationStatus as ConfigurationStatusPayload } from './useConfigurationStatus';
import { DashboardPanel, PanelMeta, PanelNotice, PanelSkeleton, RowAction } from './DashboardPanel';
import {
  PANEL_TABLE_HEAD,
  PANEL_TABLE_HEADER_ROW,
  PANEL_TABLE_ROW,
  PANEL_TABLE_ROW_ACTIONABLE,
} from './panelTable';

/** Where a configuration row is managed. */
export type ConfigTarget =
  | { kind: 'settings'; section: SectionId }
  | { kind: 'security'; tab: SecurityTab }
  | { kind: 'view'; view: 'auto-updates' | 'scheduled-ops' };

/** Owned by the shell: it knows which destinations this role can actually reach. */
export interface ConfigNavigation {
  open: (target: ConfigTarget) => void;
  canOpen: (target: ConfigTarget) => boolean;
}

/**
 * Where a setting applies. `node` follows the active node, `account` is the
 * signed-in user, and `instance` is the Sencho instance serving the active node
 * (the hub, or a remote when one is active, since the payload is proxied).
 * Settings-backed rows follow their section's registry scope (registry `global`
 * shows as Instance), except MFA: the Account section is registry-global, but
 * the MFA value is per user.
 */
type ConfigScope = 'node' | 'account' | 'instance';

const SCOPE_LABEL: Record<ConfigScope, string> = {
  node: 'Node',
  account: 'Account',
  instance: 'Instance',
};
const SCOPE_ORDER: ConfigScope[] = ['node', 'account', 'instance'];

type DomainId = 'notifications' | 'automation' | 'security' | 'recovery';

const DOMAIN_LABEL: Record<DomainId, string> = {
  notifications: 'Notifications',
  automation: 'Automation',
  security: 'Security',
  recovery: 'Recovery & alerts',
};

interface ConfigItem {
  label: string;
  /** Full value for the item row. */
  value: string;
  /** Fragment for the domain's one-line summary. */
  summary: string;
  /** In effect right now; feeds the `N of M set up` counts. */
  setUp: boolean;
  scope: ConfigScope;
  /** Server-marked unavailable: never rendered, and excluded from every count. */
  locked?: boolean;
  target: ConfigTarget;
}

const settings = (section: SectionId): ConfigTarget => ({ kind: 'settings', section });
const security = (tab: SecurityTab): ConfigTarget => ({ kind: 'security', tab });

/** Labels of the channels that are switched on, in display order. */
function enabledChannels(agents: ConfigurationStatusPayload['notifications']['agents']): string[] {
  const { discord, slack, webhook, apprise, ntfy } = normalizeConfigurationAgents(agents);
  return [
    discord.enabled ? 'Discord' : null,
    slack.enabled ? 'Slack' : null,
    webhook.enabled ? 'Webhook' : null,
    apprise.enabled ? 'Apprise' : null,
    ntfy.enabled ? 'ntfy' : null,
  ].filter((name): name is string => name !== null);
}

const SSO_NAMES: Record<string, string> = {
  oidc_custom: 'OIDC', oidc_google: 'Google', oidc_github: 'GitHub', oidc_okta: 'Okta', ldap: 'LDAP',
};

function mfaLabel(mfaEnabled: boolean | null): string {
  if (mfaEnabled === null) return 'Not set up';
  return mfaEnabled ? 'On' : 'Off';
}

function ssoLabel(sec: ConfigurationStatusPayload['security']): string {
  if (!sec.ssoEnabled) return 'Off';
  return (sec.ssoProvider && SSO_NAMES[sec.ssoProvider]) ?? 'On';
}

function vaultLabel(backup: ConfigurationStatusPayload['backup']): string {
  if (backup.provider === 'disabled') return 'Off';
  if (backup.provider === 'sencho') return 'Recovery Vault';
  return `Custom S3${backup.autoUpload ? ' (auto)' : ''}`;
}

/** `3 rules`, `1 rule`, or the `none` wording for zero. */
function count(n: number, one: string, many: string, none = 'None'): string {
  if (n === 0) return none;
  return `${n} ${n === 1 ? one : many}`;
}

function ratio(enabled: number, total: number): string {
  return total === 0 ? 'None' : `${enabled} / ${total} active`;
}

function buildDomains(s: ConfigurationStatusPayload): { id: DomainId; items: ConfigItem[] }[] {
  const { notifications: n, automation: a, security: sec, thresholds: t, backup } = s;
  const channels = enabledChannels(n.agents);
  const mfa = mfaLabel(sec.mfaEnabled);
  const thresholdsOn = t.hostAlertsEnabled !== false;

  return [
    {
      id: 'notifications',
      items: [
        {
          label: 'Channels',
          value: channels.length === 0 ? 'None' : channels.join(', '),
          summary: channels.length === 0 ? 'no channels' : channels.join(', '),
          setUp: channels.length > 0,
          scope: 'node',
          target: settings('notifications'),
        },
        {
          label: 'Alert rules',
          value: count(n.alertRules, 'rule', 'rules'),
          summary: count(n.alertRules, 'alert rule', 'alert rules', 'no alert rules'),
          setUp: n.alertRules > 0,
          scope: 'node',
          target: settings('notifications'),
        },
        {
          label: 'Routing',
          value: count(n.routingRules.enabledCount, 'route', 'routes'),
          summary: count(n.routingRules.enabledCount, 'route', 'routes', 'no routes'),
          setUp: n.routingRules.enabledCount > 0,
          scope: 'instance',
          locked: n.routingRules.locked,
          target: settings('notification-routing'),
        },
        {
          label: 'Mute rules',
          value: count(n.suppressionRules.enabledCount, 'rule', 'rules'),
          summary: count(n.suppressionRules.enabledCount, 'mute rule', 'mute rules', 'no mute rules'),
          setUp: n.suppressionRules.enabledCount > 0,
          scope: 'instance',
          target: settings('notification-suppression'),
        },
      ],
    },
    {
      id: 'automation',
      items: [
        {
          label: 'Auto-heal policies',
          value: ratio(a.autoHeal.enabled, a.autoHeal.total),
          summary: count(a.autoHeal.enabled, 'auto-heal policy', 'auto-heal policies', 'no auto-heal'),
          setUp: a.autoHeal.enabled > 0,
          scope: 'node',
          target: settings('container-alerts'),
        },
        {
          label: 'Auto-update schedules',
          value: ratio(a.autoUpdate.enabled, a.autoUpdate.total),
          summary: count(a.autoUpdate.enabled, 'auto-update', 'auto-updates', 'no auto-updates'),
          setUp: a.autoUpdate.enabled > 0,
          scope: 'node',
          target: { kind: 'view', view: 'auto-updates' },
        },
        {
          label: 'Scheduled tasks',
          value: count(a.scheduledTasks.enabled, 'active', 'active'),
          summary: count(a.scheduledTasks.enabled, 'scheduled task', 'scheduled tasks', 'no scheduled tasks'),
          setUp: a.scheduledTasks.enabled > 0,
          scope: 'instance',
          locked: a.scheduledTasks.locked,
          target: { kind: 'view', view: 'scheduled-ops' },
        },
        {
          label: 'Webhooks',
          value: count(a.webhooks.enabled, 'active', 'active'),
          summary: count(a.webhooks.enabled, 'webhook', 'webhooks', 'no webhooks'),
          setUp: a.webhooks.enabled > 0,
          scope: 'instance',
          locked: a.webhooks.locked,
          target: settings('webhooks'),
        },
      ],
    },
    {
      id: 'security',
      items: [
        {
          label: 'MFA',
          value: mfa,
          summary: `MFA ${mfa.toLowerCase()}`,
          setUp: sec.mfaEnabled === true,
          scope: 'account',
          target: settings('account'),
        },
        {
          label: 'SSO',
          value: ssoLabel(sec),
          summary: sec.ssoEnabled ? `SSO ${ssoLabel(sec)}` : 'SSO off',
          setUp: sec.ssoEnabled,
          scope: 'instance',
          target: settings('sso'),
        },
        {
          label: 'Trivy',
          value: sec.trivyInstalled ? 'Installed' : 'Not installed',
          summary: sec.trivyInstalled ? 'Trivy installed' : 'no Trivy',
          setUp: sec.trivyInstalled,
          scope: 'node',
          target: security('scanner'),
        },
        {
          label: 'Scan policies',
          value: count(sec.scanPolicies.enabled, 'policy', 'policies'),
          summary: count(sec.scanPolicies.enabled, 'scan policy', 'scan policies', 'no scan policies'),
          setUp: sec.scanPolicies.enabled > 0,
          scope: 'instance',
          locked: sec.scanPolicies.locked,
          target: security('policies'),
        },
      ],
    },
    {
      id: 'recovery',
      items: [
        {
          label: 'Backups',
          value: vaultLabel(backup),
          summary: backup.provider === 'disabled' ? 'no backups' : vaultLabel(backup),
          setUp: backup.provider !== 'disabled',
          scope: 'instance',
          locked: backup.locked,
          target: settings('cloud-backup'),
        },
        {
          label: 'Host thresholds',
          value: thresholdsOn ? `CPU ${t.cpuLimit}% · RAM ${t.ramLimit}% · Disk ${t.diskLimit}%` : 'Off',
          summary: thresholdsOn ? 'thresholds on' : 'thresholds off',
          setUp: thresholdsOn,
          scope: 'node',
          target: settings('host-alerts'),
        },
        {
          label: 'Crash detection',
          value: t.globalCrash ? 'On' : 'Off',
          summary: `crash detection ${t.globalCrash ? 'on' : 'off'}`,
          setUp: t.globalCrash,
          scope: 'node',
          target: settings('container-alerts'),
        },
      ],
    },
  ];
}

function SetUpMark({ setUp }: { setUp: boolean }) {
  return setUp
    ? <Check className="ml-auto h-3.5 w-3.5 text-success" strokeWidth={1.5} aria-label="Set up" />
    : <Minus className="ml-auto h-3.5 w-3.5 text-stat-icon" strokeWidth={1.5} aria-label="Not set up" />;
}

interface ConfigurationSummaryProps {
  navigation: ConfigNavigation;
  /** Active node's name, so the node-scoped rows say which node they describe. */
  nodeName: string;
}

export function ConfigurationSummary({ navigation, nodeName }: ConfigurationSummaryProps) {
  const { status, loading, stale } = useConfigurationStatus();
  const [expanded, setExpanded] = useState<ReadonlySet<DomainId>>(() => new Set());

  const toggle = (id: DomainId) => setExpanded(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // A locked row never renders and is excluded from every count: a total must
  // never include a row the operator cannot act on.
  const domains = status
    ? buildDomains(status)
      .map(d => ({ ...d, items: d.items.filter(item => !item.locked) }))
      .filter(d => d.items.length > 0)
    : [];
  const allItems = domains.flatMap(d => d.items);
  const setUpTotal = allItems.filter(i => i.setUp).length;

  let body;
  if (loading) {
    body = <PanelSkeleton rows={4} />;
  } else if (!status) {
    body = (
      <PanelNotice icon={<AlertCircle className="h-4 w-4 text-stat-icon" strokeWidth={1.5} />}>
        Unable to load configuration.
      </PanelNotice>
    );
  } else {
    body = (
      <Table>
        <TableHeader>
          <TableRow className={PANEL_TABLE_HEADER_ROW}>
            <TableHead className={cn(PANEL_TABLE_HEAD, 'w-48')}>Setting</TableHead>
            <TableHead className={PANEL_TABLE_HEAD}>Status</TableHead>
            <TableHead className={cn(PANEL_TABLE_HEAD, 'w-56')}>Scope</TableHead>
            <TableHead className={cn(PANEL_TABLE_HEAD, 'w-20 text-right')}>Set up</TableHead>
            <TableHead className={cn(PANEL_TABLE_HEAD, 'w-8')}><span className="sr-only">Open</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {domains.map(domain => {
            const open = expanded.has(domain.id);
            const scopes = SCOPE_ORDER.filter(sc => domain.items.some(i => i.scope === sc));
            const Chevron = open ? ChevronDown : ChevronRight;
            return [
              <TableRow
                key={domain.id}
                data-testid={`config-domain-${domain.id}`}
                className={cn(PANEL_TABLE_ROW, PANEL_TABLE_ROW_ACTIONABLE)}
                onClick={() => toggle(domain.id)}
              >
                <TableCell className="w-48">
                  <RowAction expanded={open}>
                    <span className="flex items-center gap-1.5 text-sm text-stat-value">
                      <Chevron className="h-3.5 w-3.5 shrink-0 text-stat-icon" strokeWidth={1.5} aria-hidden />
                      {DOMAIN_LABEL[domain.id]}
                    </span>
                  </RowAction>
                </TableCell>
                <TableCell className="max-w-0">
                  <span className="block truncate text-xs text-stat-subtitle">
                    {domain.items.map(i => i.summary).join(' · ')}
                  </span>
                </TableCell>
                <TableCell className="w-56 whitespace-nowrap font-mono text-[11px] uppercase tracking-wide text-stat-icon">
                  {scopes.map(sc => SCOPE_LABEL[sc]).join(' · ')}
                </TableCell>
                <TableCell className="w-20 text-right font-mono text-xs tabular-nums text-stat-subtitle">
                  {domain.items.filter(i => i.setUp).length}/{domain.items.length}
                </TableCell>
                <TableCell className="w-8" />
              </TableRow>,
              ...(open ? domain.items.map(item => {
                const reachable = navigation.canOpen(item.target);
                const label = <span className="pl-5">{item.label}</span>;
                return (
                  <TableRow
                    key={`${domain.id}:${item.label}`}
                    className={cn(PANEL_TABLE_ROW, 'bg-accent/[0.02]', reachable && PANEL_TABLE_ROW_ACTIONABLE)}
                    onClick={reachable ? () => navigation.open(item.target) : undefined}
                  >
                    <TableCell className="w-48 text-xs text-stat-subtitle">
                      {reachable ? <RowAction label={`${item.label}: ${item.value}`}>{label}</RowAction> : label}
                    </TableCell>
                    <TableCell className="max-w-0 truncate font-mono text-xs text-stat-value">{item.value}</TableCell>
                    <TableCell className="w-56 whitespace-nowrap font-mono text-[11px] uppercase tracking-wide text-stat-icon">
                      {SCOPE_LABEL[item.scope]}
                    </TableCell>
                    <TableCell className="w-20"><SetUpMark setUp={item.setUp} /></TableCell>
                    <TableCell className="w-8">
                      {reachable ? <ChevronRight className="h-3.5 w-3.5 text-stat-icon" strokeWidth={1.5} aria-hidden /> : null}
                    </TableCell>
                  </TableRow>
                );
              }) : []),
            ];
          })}
        </TableBody>
      </Table>
    );
  }

  return (
    <DashboardPanel
      title="Configuration summary"
      meta={status ? (
        <PanelMeta>
          {`${setUpTotal} of ${allItems.length} set up · ${nodeName}`}
          {stale && <span className="text-warning"> · stale</span>}
        </PanelMeta>
      ) : null}
      footer={status ? (
        <p className="text-xs text-stat-subtitle">
          Node settings follow the active node. Account settings are yours. Instance settings belong to the Sencho instance serving this node.
        </p>
      ) : undefined}
    >
      {body}
    </DashboardPanel>
  );
}
