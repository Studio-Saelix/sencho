import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Info, AlertTriangle, AlertOctagon, CheckCircle2, ChevronRight, CloudOff } from 'lucide-react';
import { cn, formatRelativeTime } from '@/lib/utils';
import { isActionableAlert } from '@/lib/notificationVisibility';
import type { AlertDestination } from '@/lib/alertDestination';
import { useRecentAlertsScopePreference } from './useRecentAlertsScopePreference';
import { DashboardPanel, PanelMeta, PanelNotice, PanelSkeleton, RowAction } from './DashboardPanel';
import {
  PANEL_TABLE_HEAD,
  PANEL_TABLE_HEADER_ROW,
  PANEL_TABLE_ROW,
  PANEL_TABLE_ROW_ACTIONABLE,
} from './panelTable';
import type { StackHealthScopeMode } from './stackHealthTypes';
import type { NotificationItem } from './types';
import type { Node } from '@/context/NodeContext';

/** How alert rows leave Home. Owned by the shell so every hop reuses its node-switch path. */
export interface AlertNavigation {
  /** The row's destination once reachability and permissions are applied, or null for an inert row. */
  destinationFor: (n: NotificationItem) => AlertDestination | null;
  open: (destination: AlertDestination) => void;
  /** Opens the full notification feed. */
  viewAll: () => void;
}

interface RecentAlertsProps {
  notifications: NotificationItem[];
  nodes: Node[];
  /** Active node's registry id. `This node` follows it. */
  activeNodeId: number | null;
  /**
   * Nodes whose latest feed leg did not land; their silence is not an all-clear.
   * Null until the first fetch settles, when the card cannot say anything yet.
   */
  unreportedNodeIds: ReadonlySet<number> | null;
  navigation: AlertNavigation;
  className?: string;
  /** Hold the eight-row body height even when empty, so a side-by-side neighbour can match it. */
  reserveHeight?: boolean;
}

export const RECENT_ALERTS_PREVIEW_SIZE = 8;

/**
 * The card is always as tall as a full preview, so it never grows or shrinks
 * as alerts arrive, resolve, or fail to load, and the Fleet heartbeat beside it
 * can match it exactly. Each row is fixed at two text lines (leading-4 plus
 * leading-5, 2.25rem) and its cell padding. The body is the header (the table's
 * 1.25rem line plus padding) and eight rows, so 19.25rem and eighteen cell-y
 * paddings, plus 9px of borders: the header's top and bottom and seven row top
 * borders (the base TableBody strips the last one). Collapsed borders leave a
 * few pixels of margin under the eighth row, never a clipped row, and the
 * density tokens keep that true in compact mode.
 */
const ROW_HEIGHT = 'h-[calc(2.25rem+2*var(--density-cell-y))]';
const BODY_HEIGHT = 'h-[calc(19.25rem+18*var(--density-cell-y)+9px)]';

const LEVEL: Record<NotificationItem['level'], { icon: typeof Info; className: string; label: string }> = {
  info: { icon: Info, className: 'text-brand', label: 'Info' },
  warning: { icon: AlertTriangle, className: 'text-warning', label: 'Warning' },
  error: { icon: AlertOctagon, className: 'text-destructive', label: 'Error' },
};

const ROW_TINT: Record<NotificationItem['level'], string> = {
  info: '',
  warning: 'bg-warning/[0.04]',
  error: 'bg-destructive/[0.04]',
};

function formatNodeList(names: string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

export function RecentAlerts({ notifications, nodes, activeNodeId, unreportedNodeIds, navigation, className, reserveHeight = false }: RecentAlertsProps) {
  const [scope, setScope] = useRecentAlertsScopePreference();

  // Without a remote node there is no cross-node scope to choose, so the stored
  // preference is kept but not applied.
  const showScopeControl = nodes.some(n => n.type === 'remote');
  const effectiveScope: StackHealthScopeMode = showScopeControl ? scope : 'this-node';
  // Scoping against an unknown active node would drop every stamped row and read
  // as an all-clear, so the node filter applies only once the active node is known.
  const nodeScoped = effectiveScope === 'this-node' && activeNodeId != null;

  const inScope = (nodeId: number | undefined) => !nodeScoped || nodeId == null || nodeId === activeNodeId;

  const alerts = notifications
    .filter(n => isActionableAlert(n) && inScope(n.nodeId))
    .sort((a, b) => b.timestamp - a.timestamp);
  const preview = alerts.slice(0, RECENT_ALERTS_PREVIEW_SIZE);

  const scopeNodes = nodes.filter(n => inScope(n.id));
  const silentNodes = scopeNodes.filter(n => unreportedNodeIds?.has(n.id) ?? false);
  const nodeName = (id: number | undefined) => nodes.find(n => n.id === id)?.name;

  const alertWord = alerts.length === 1 ? 'alert' : 'alerts';
  let coverage: string;
  if (nodeScoped) {
    coverage = nodeName(activeNodeId ?? undefined) ?? 'this node';
  } else if (silentNodes.length === 0) {
    coverage = `${scopeNodes.length} ${scopeNodes.length === 1 ? 'node' : 'nodes'}`;
  } else {
    coverage = `${scopeNodes.length - silentNodes.length}/${scopeNodes.length} nodes reporting`;
  }

  const gapNotice = silentNodes.length > 0
    ? `No current feed from ${formatNodeList(silentNodes.map(n => n.name))}.`
    : null;
  const staleNotice = gapNotice && preview.length > 0
    ? `${gapNotice} Showing what was last received.`
    : null;

  let body;
  if (unreportedNodeIds === null && preview.length === 0) {
    body = <PanelSkeleton rows={3} />;
  } else if (preview.length === 0) {
    body = gapNotice ? (
      <PanelNotice className="flex-1" icon={<CloudOff className="h-4 w-4 text-warning" strokeWidth={1.5} />}>
        {gapNotice} Alerts from {silentNodes.length === 1 ? 'it' : 'them'} may be missing.
      </PanelNotice>
    ) : (
      <PanelNotice className="flex-1" icon={<CheckCircle2 className="h-4 w-4 text-success" strokeWidth={1.5} />}>
        No recent alerts.
      </PanelNotice>
    );
  } else {
    body = (
      <>
        <Table>
          <TableHeader>
            <TableRow className={cn(PANEL_TABLE_HEADER_ROW, 'leading-5')}>
              <TableHead className={cn(PANEL_TABLE_HEAD, 'w-px whitespace-nowrap')}><span className="sr-only">Severity</span></TableHead>
              <TableHead className={cn(PANEL_TABLE_HEAD, 'w-full')}>Alert</TableHead>
              {nodeScoped ? null : <TableHead className={cn(PANEL_TABLE_HEAD, 'w-px whitespace-nowrap')}>Node</TableHead>}
              <TableHead className={cn(PANEL_TABLE_HEAD, 'w-px whitespace-nowrap text-right')}>When</TableHead>
              <TableHead className={cn(PANEL_TABLE_HEAD, 'w-px whitespace-nowrap')}><span className="sr-only">Open</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {preview.map(n => {
              const level = LEVEL[n.level] ?? LEVEL.info;
              const Icon = level.icon;
              const destination = navigation.destinationFor(n);
              const subject = [n.stack_name, n.container_name].filter(Boolean).join(' / ');
              const summary = (
                <>
                  <span
                    className={cn('block truncate text-xs leading-4', n.is_read ? 'text-stat-subtitle' : 'text-stat-value')}
                    title={n.message}
                  >
                    {n.message}
                  </span>
                  {subject ? <span className="block truncate font-mono text-[10px] leading-5 text-stat-icon">{subject}</span> : null}
                </>
              );
              return (
                <TableRow
                  // Notification ids are per-node database ids, so two nodes can
                  // both hold id 7; the key is node-qualified.
                  key={`${n.nodeId ?? 'local'}:${n.id}`}
                  data-testid="recent-alert-row"
                  className={cn(PANEL_TABLE_ROW, ROW_HEIGHT, ROW_TINT[n.level], destination && PANEL_TABLE_ROW_ACTIONABLE)}
                  onClick={destination ? () => navigation.open(destination) : undefined}
                >
                  <TableCell className="w-px whitespace-nowrap">
                    <Icon className={cn('h-3.5 w-3.5', level.className)} strokeWidth={1.5} aria-hidden />
                    <span className="sr-only">{level.label}</span>
                  </TableCell>
                  <TableCell className="w-full max-w-0">
                    {destination ? <RowAction>{summary}</RowAction> : summary}
                  </TableCell>
                  {nodeScoped ? null : (
                    <TableCell className="w-px whitespace-nowrap max-w-32 truncate font-mono text-[11px] text-stat-subtitle">
                      {n.nodeName ?? nodeName(n.nodeId) ?? '--'}
                    </TableCell>
                  )}
                  <TableCell className="w-px whitespace-nowrap text-right font-mono text-xs tabular-nums text-stat-icon">
                    {formatRelativeTime(Math.floor(n.timestamp / 1000))}
                  </TableCell>
                  <TableCell className="w-px whitespace-nowrap">
                    {destination ? <ChevronRight className="h-3.5 w-3.5 text-stat-icon" strokeWidth={1.5} aria-hidden /> : null}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </>
    );
  }

  return (
    <DashboardPanel
      title="Recent alerts"
      className={className}
      meta={<PanelMeta>{`${alerts.length} ${alertWord} · ${coverage}`}</PanelMeta>}
      actions={showScopeControl ? (
        <SegmentedControl
          ariaLabel="Recent alerts node scope"
          value={effectiveScope}
          onChange={setScope}
          options={[
            { value: 'this-node', label: 'This node' },
            { value: 'all-nodes', label: 'All nodes' },
          ]}
        />
      ) : undefined}
      footer={(
        <div className="flex items-center justify-between gap-3">
          {staleNotice ? (
            // In the footer rather than above the rows, so a silent node never
            // changes the card's height.
            <span className="flex min-w-0 items-center gap-2 text-xs text-stat-subtitle">
              <CloudOff className="h-3.5 w-3.5 shrink-0 text-warning" strokeWidth={1.5} aria-hidden />
              <span className="truncate" title={staleNotice}>{staleNotice}</span>
            </span>
          ) : (
            <span className="text-xs text-stat-subtitle">
              {alerts.length > preview.length ? `Latest ${preview.length} of ${alerts.length}` : 'Warnings, errors, and available updates'}
            </span>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={navigation.viewAll}>
            View all alerts
            <ChevronRight className="ml-1 h-3.5 w-3.5" strokeWidth={1.5} />
          </Button>
        </div>
      )}
    >
      <div className={cn('flex flex-col overflow-hidden', (reserveHeight || preview.length > 0) && BODY_HEIGHT)}>{body}</div>
    </DashboardPanel>
  );
}
