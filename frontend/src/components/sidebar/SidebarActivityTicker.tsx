import { Rocket, RefreshCw, CircleStop, AlertTriangle, Clock, Activity } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatTimeAgo, formatAgeShort } from '@/lib/relativeTime';
import { VERB_LABELS, type ActionVerb } from '@/context/DeployFeedbackContext';
import type { SidebarActivitySummary } from './useSidebarActivitySummary';

export type SidebarActivityAction =
  | { kind: 'open-stack-notification'; summary: Extract<SidebarActivitySummary, { kind: 'failure' | 'recent-event' }> }
  | { kind: 'open-auto-updates' }
  | { kind: 'open-activity' }
  | { kind: 'noop' };

interface SidebarActivityTickerProps {
  summary: SidebarActivitySummary;
  onAction: (action: SidebarActivityAction) => void;
}

interface RenderConfig {
  dotClass: string;
  pulse: boolean;
  Icon: LucideIcon | null;
  iconClass: string;
  primary: React.ReactNode;
  kicker: string;
  action: SidebarActivityAction;
}

const VERB_ICON: Record<ActionVerb, LucideIcon> = {
  deploy: Rocket,
  install: Rocket,
  update: RefreshCw,
  restart: RefreshCw,
  down: CircleStop,
  stop: CircleStop,
};

function formatClockHHMM(unixSecs: number): string {
  const d = new Date(unixSecs * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function buildConfig(summary: SidebarActivitySummary): RenderConfig {
  switch (summary.kind) {
    case 'active-op': {
      const elapsed = formatAgeShort(Date.now() - summary.startedAt);
      return {
        dotClass: 'bg-brand shadow-[0_0_6px_var(--brand)]',
        pulse: true,
        Icon: VERB_ICON[summary.action],
        iconClass: 'text-brand',
        primary: (
          <span className="font-mono text-[11px] truncate">
            <span className="text-foreground">{VERB_LABELS[summary.action].present} </span>
            <span className="text-brand">{summary.stackName}</span>
            <span className="text-muted-foreground"> · {elapsed}</span>
          </span>
        ),
        kicker: 'LIVE · STREAMING',
        action: { kind: 'noop' },
      };
    }
    case 'failure': {
      const stack = summary.notif.stack_name ?? 'unknown';
      return {
        dotClass: 'bg-destructive shadow-[0_0_6px_var(--destructive)]',
        pulse: false,
        Icon: AlertTriangle,
        iconClass: 'text-destructive',
        primary: (
          <span className="font-mono text-[11px] truncate">
            <span className="text-destructive">Failed</span>
            <span className="text-muted-foreground"> · </span>
            <span className="text-foreground">{stack}</span>
            <span className="text-muted-foreground"> · {formatTimeAgo(summary.notif.timestamp * 1000)}</span>
          </span>
        ),
        kicker: 'ALERT · VIEW LOGS →',
        action: { kind: 'open-stack-notification', summary },
      };
    }
    case 'automation': {
      const nextLabel = formatClockHHMM(summary.nextRunAt);
      return {
        dotClass: 'bg-warning shadow-[0_0_6px_var(--warning)]',
        pulse: false,
        Icon: Clock,
        iconClass: 'text-warning',
        primary: (
          <span className="font-mono text-[11px] truncate">
            <span className="text-foreground">Auto-update </span>
            <span className="text-brand">{summary.enabledCount}/{summary.totalCount}</span>
            <span className="text-muted-foreground"> · next run {nextLabel}</span>
          </span>
        ),
        kicker: 'AUTOMATION · OPEN SCHEDULE →',
        action: { kind: 'open-auto-updates' },
      };
    }
    case 'recent-event': {
      return {
        dotClass: 'bg-brand shadow-[0_0_6px_var(--brand)]',
        pulse: false,
        Icon: Activity,
        iconClass: 'text-brand',
        primary: (
          <span className="font-mono text-[11px] truncate">
            <span className="text-brand">{summary.notif.stack_name}</span>
            <span className="text-muted-foreground"> · {summary.notif.message} · {formatTimeAgo(summary.notif.timestamp * 1000)}</span>
          </span>
        ),
        kicker: 'LIVE · VIEW STACK →',
        action: { kind: 'open-stack-notification', summary },
      };
    }
    case 'disconnected': {
      return {
        dotClass: 'bg-warning',
        pulse: false,
        Icon: null,
        iconClass: '',
        primary: <span className="font-mono text-[11px] text-muted-foreground">Notifications reconnecting</span>,
        kicker: 'LIVE · NOTIFICATIONS PAUSED',
        action: { kind: 'noop' },
      };
    }
    case 'quiet-live':
    default: {
      return {
        dotClass: 'bg-success shadow-[0_0_6px_var(--success)]',
        pulse: false,
        Icon: null,
        iconClass: '',
        primary: <span className="font-mono text-[11px] text-muted-foreground">Live · no stack changes in 1h</span>,
        kicker: 'LIVE · OPEN ACTIVITY →',
        action: { kind: 'open-activity' },
      };
    }
  }
}

export function SidebarActivityTicker({ summary, onAction }: SidebarActivityTickerProps) {
  const config = buildConfig(summary);
  const { Icon } = config;
  const isClickable = config.action.kind !== 'noop';

  return (
    <button
      type="button"
      onClick={() => onAction(config.action)}
      disabled={!isClickable}
      data-state={summary.kind}
      className={cn(
        'w-full flex flex-col gap-0.5 px-4 py-2 border-t border-glass-border text-left',
        'bg-sidebar/80',
        isClickable && 'hover:bg-glass-highlight cursor-pointer',
        !isClickable && 'cursor-default',
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span
          data-testid="ticker-dot"
          className={cn('w-1.5 h-1.5 rounded-full shrink-0', config.dotClass, config.pulse && 'animate-pulse')}
        />
        {Icon !== null && (
          <Icon className={cn('w-3 h-3 shrink-0', config.iconClass)} aria-hidden />
        )}
        <span className="flex-1 min-w-0 truncate">{config.primary}</span>
      </div>
      <span className="font-mono text-[9px] tracking-[0.22em] uppercase text-stat-subtitle pl-3.5">
        {config.kicker}
      </span>
    </button>
  );
}
