import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Bell, Zap, Shield, HardDrive, ChevronRight } from 'lucide-react';
import { formatCount } from '@/lib/utils';
import { useConfigurationStatus } from './useConfigurationStatus';
import type { SectionId } from '@/components/settings/types';

interface ConfigurationStatusProps {
  onOpenSection?: (section: SectionId) => void;
}

function StatusBadge({ value }: { value: string }) {
  const lower = value.toLowerCase();
  if (lower === 'on' || lower === 'enabled') {
    return (
      <span className="inline-flex items-center rounded-sm border border-success/30 bg-success/10 px-1.5 py-0.5 text-[10px] font-mono tracking-wide uppercase text-success">
        ON
      </span>
    );
  }
  if (lower === 'off' || lower === 'disabled') {
    return (
      <span className="inline-flex items-center rounded-sm border border-card-border bg-card px-1.5 py-0.5 text-[10px] font-mono tracking-wide uppercase text-stat-subtitle">
        OFF
      </span>
    );
  }
  return (
    <span className="text-xs font-mono tabular-nums text-stat-value">{value}</span>
  );
}

function Row({ label, value, onClick }: {
  label: string;
  value: string;
  onClick?: () => void;
}) {
  const labelClass = 'text-xs text-stat-subtitle';

  if (onClick) {
    return (
      <button
        type="button"
        className="w-full text-left hover:bg-accent/5 rounded-sm transition-colors cursor-pointer group"
        onClick={onClick}
      >
        <div className="flex items-center justify-between py-1 px-1">
          <span className={`${labelClass} group-hover:text-stat-value transition-colors`}>{label}</span>
          <div className="flex items-center gap-1.5">
            <StatusBadge value={value} />
            <ChevronRight className="h-3 w-3 text-stat-icon opacity-0 group-hover:opacity-60 transition-opacity shrink-0" strokeWidth={1.5} />
          </div>
        </div>
      </button>
    );
  }

  return (
    <div className="flex items-center justify-between py-1 px-1 rounded-sm">
      <span className={labelClass}>{label}</span>
      <StatusBadge value={value} />
    </div>
  );
}

function SectionHeader({ icon: Icon, label }: { icon: typeof Bell; label: string }) {
  return (
    <div className="flex items-center gap-1.5 pt-2 pb-0.5 first:pt-0">
      <Icon className="h-3 w-3 text-stat-icon shrink-0" strokeWidth={1.5} />
      <span className="text-[10px] leading-3 font-mono tracking-[0.18em] uppercase text-stat-icon">{label}</span>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="flex items-center justify-between py-1 px-1">
      <div className="h-3 w-24 rounded-sm bg-accent/10 animate-pulse" />
      <div className="h-4 w-12 rounded-sm bg-accent/10 animate-pulse" />
    </div>
  );
}

export function ConfigurationStatus({ onOpenSection }: ConfigurationStatusProps = {}) {
  const { status, loading } = useConfigurationStatus();

  const open = (section: SectionId) => () => onOpenSection?.(section);

  if (loading) {
    return (
      <Card className="bg-card shadow-card-bevel">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-stat-title">Configuration Status</CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-0.5">
          {Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)}
        </CardContent>
      </Card>
    );
  }

  if (!status) {
    return (
      <Card className="bg-card shadow-card-bevel">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-stat-title">Configuration Status</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-xs text-stat-subtitle py-4 text-center">Unable to load configuration.</p>
        </CardContent>
      </Card>
    );
  }

  const { notifications, automation, security, thresholds, backup } = status;

  const agentSummary = (() => {
    const { discord, slack, webhook } = notifications.agents;
    const active = [
      discord.enabled ? 'Discord' : null,
      slack.enabled ? 'Slack' : null,
      webhook.enabled ? 'Webhook' : null,
    ].filter(Boolean);
    return active.length === 0 ? 'None' : active.join(', ');
  })();

  const ssoLabel = (() => {
    if (!security.ssoEnabled) return 'Off';
    const names: Record<string, string> = {
      oidc_custom: 'OIDC', oidc_google: 'Google', oidc_github: 'GitHub',
      oidc_okta: 'Okta', ldap: 'LDAP',
    };
    return (security.ssoProvider && names[security.ssoProvider]) ?? 'Enabled';
  })();

  return (
    <Card className="bg-card shadow-card-bevel">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-stat-title">Configuration Status</CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-0">
          <SectionHeader icon={Bell} label="Notifications" />
          <Row label="Notification agents" value={agentSummary} onClick={open('notifications')} />
          <Row
            label="Alert rules"
            value={formatCount(notifications.alertRules, 'rule')}
            onClick={open('notifications')}
          />
          {!notifications.routingRules.locked && (
            <Row
              label="Notification routing"
              value={formatCount(notifications.routingRules.enabledCount, 'route')}
              onClick={open('notification-routing')}
            />
          )}

          <SectionHeader icon={Zap} label="Automation" />
          <Row
            label="Auto-heal policies"
            value={automation.autoHeal.total === 0 ? 'None' : `${automation.autoHeal.enabled} / ${automation.autoHeal.total} active`}
            onClick={open('system')}
          />
          <Row
            label="Auto-update schedules"
            value={automation.autoUpdate.total === 0 ? 'None' : `${automation.autoUpdate.enabled} / ${automation.autoUpdate.total} active`}
            onClick={open('system')}
          />
          {!automation.webhooks.locked && (
            <Row
              label="Webhooks"
              value={formatCount(automation.webhooks.enabled, 'active')}
              onClick={open('webhooks')}
            />
          )}
          {!automation.scheduledTasks.locked && (
            <Row
              label="Scheduled tasks"
              value={formatCount(automation.scheduledTasks.enabled, 'active')}
              onClick={open('system')}
            />
          )}

          <SectionHeader icon={Shield} label="Security" />
          <Row
            label="MFA"
            value={security.mfaEnabled === null ? 'Not set up' : security.mfaEnabled ? 'On' : 'Off'}
            onClick={open('account')}
          />
          <Row label="SSO" value={ssoLabel} onClick={open('sso')} />
          {!security.scanPolicies.locked && (
            <Row
              label="Vulnerability scanning"
              value={formatCount(security.scanPolicies.enabled, 'policy')}
              onClick={open('security')}
            />
          )}

          <SectionHeader icon={HardDrive} label="Backups & Thresholds" />
          {!backup.locked && (
            <Row
              label="Cloud Backup"
              value={backup.provider === 'disabled' ? 'Disabled' : backup.provider === 'sencho' ? 'Sencho Cloud' : `Custom S3${backup.autoUpload ? ' (auto)' : ''}`}
              onClick={open('cloud-backup')}
            />
          )}
          <Row
            label="Alert thresholds"
            value={`CPU ${thresholds.cpuLimit}% · RAM ${thresholds.ramLimit}% · Disk ${thresholds.diskLimit}%`}
            onClick={open('system')}
          />
          <Row
            label="Crash detection"
            value={thresholds.globalCrash ? 'On' : 'Off'}
            onClick={open('system')}
          />
        </div>
      </CardContent>
    </Card>
  );
}
