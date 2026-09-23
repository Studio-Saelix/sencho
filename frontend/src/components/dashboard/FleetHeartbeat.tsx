import { AlertCircle, ChevronRight } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn, formatRelativeTime } from '@/lib/utils';
import { useFleetHeartbeat } from './useFleetHeartbeat';
import { useMeshDataPlane } from './useMeshDataPlane';
import { MeshDataPlaneBanner } from '@/components/fleet/MeshDataPlaneBanner';
import { DashboardPanel, PanelMeta, PanelNotice, PanelSkeleton, PanelWarning, RowAction } from './DashboardPanel';
import {
  PANEL_TABLE_HEAD,
  PANEL_TABLE_HEADER_ROW,
  PANEL_TABLE_ROW,
  PANEL_TABLE_ROW_ACTIONABLE,
} from './panelTable';
import type { FleetNodeOverview } from './useFleetHeartbeat';

type NodeStatus = FleetNodeOverview['status'];

const DOT_CLASS: Record<NodeStatus, string> = {
  online: 'bg-success',
  unknown: 'bg-warning',
  offline: 'bg-destructive',
};

const STATE_TEXT_CLASS: Record<NodeStatus, string> = {
  online: 'text-stat-subtitle',
  unknown: 'text-warning',
  offline: 'text-destructive',
};

const ROW_TINT: Record<NodeStatus, string> = {
  online: '',
  unknown: 'bg-warning/[0.04]',
  offline: 'bg-destructive/[0.04]',
};

/**
 * Operational order: a node we failed to reach, then one whose state we could
 * not determine, then healthy remotes, then the local node, which is the one
 * the operator is already looking at. Name breaks ties so polls do not reshuffle.
 */
function rank(node: FleetNodeOverview): number {
  if (node.status === 'offline') return 0;
  if (node.status === 'unknown') return 1;
  return node.type === 'remote' ? 2 : 3;
}

function sortHeartbeatNodes(nodes: FleetNodeOverview[]): FleetNodeOverview[] {
  return nodes.slice().sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** Latency while the node answers; how long it has been silent once it stops. */
function contactLabel(node: FleetNodeOverview): string {
  if (node.status === 'online') {
    if (node.type === 'local') return '--';
    if (node.mode === 'pilot_agent') return 'tunnel';
    return node.latency_ms !== undefined ? `${node.latency_ms} ms` : '--';
  }
  const seen = node.mode === 'pilot_agent' ? node.pilot_last_seen : node.last_successful_contact;
  return seen ? formatRelativeTime(seen) : 'never reached';
}

interface FleetHeartbeatProps {
  onOpenNode: (nodeId: number) => void;
  className?: string;
}

export function FleetHeartbeat({ onOpenNode, className }: FleetHeartbeatProps) {
  const { nodes, loading, error } = useFleetHeartbeat();
  const { status: meshDataPlane } = useMeshDataPlane();
  const meshDown = meshDataPlane?.ok === false
    && meshDataPlane.reason !== 'not_in_docker'
    && meshDataPlane.reason !== 'not_started';

  // Offline and unknown are different states and get different words: a node we
  // failed to reach is not the same as one whose status we could not determine.
  const offlineCount = nodes.filter(n => n.status === 'offline').length;
  const unknownCount = nodes.filter(n => n.status === 'unknown').length;

  const meta = loading ? null : (
    <PanelMeta>
      {nodes.length} {nodes.length === 1 ? 'node' : 'nodes'}
      {offlineCount > 0 && <span className="text-destructive"> · {offlineCount} offline</span>}
      {unknownCount > 0 && <span className="text-warning"> · {unknownCount} unknown</span>}
      {meshDown && <span className="text-destructive"> · mesh down</span>}
      {error && nodes.length > 0 && <span className="text-warning"> · stale</span>}
    </PanelMeta>
  );

  let body;
  if (loading) {
    body = <PanelSkeleton rows={3} />;
  } else if (nodes.length === 0) {
    // With no previous answer to fall back on, a failed poll has nothing to show.
    body = error ? (
      <PanelNotice icon={<AlertCircle className="h-4 w-4 text-stat-icon" strokeWidth={1.5} />}>
        Unable to load fleet status.
      </PanelNotice>
    ) : (
      <PanelNotice>No nodes registered.</PanelNotice>
    );
  } else {
    body = (
      <>
        {error ? (
          // The rows below are the last answer, not a live one: say so rather
          // than let green dots imply the fleet was just checked.
          <PanelWarning>Fleet status could not be refreshed ({error}). Showing the last known state.</PanelWarning>
        ) : null}
        <Table>
          <TableHeader>
            <TableRow className={PANEL_TABLE_HEADER_ROW}>
              <TableHead className={cn(PANEL_TABLE_HEAD, 'w-px whitespace-nowrap')}><span className="sr-only">Status</span></TableHead>
              <TableHead className={cn(PANEL_TABLE_HEAD, 'w-full')}>Node</TableHead>
              <TableHead className={cn(PANEL_TABLE_HEAD, 'w-px whitespace-nowrap')}>State</TableHead>
              <TableHead className={cn(PANEL_TABLE_HEAD, 'w-px whitespace-nowrap text-right')}>Active</TableHead>
              <TableHead className={cn(PANEL_TABLE_HEAD, 'w-px whitespace-nowrap text-right')}>Contact</TableHead>
              <TableHead className={cn(PANEL_TABLE_HEAD, 'w-px whitespace-nowrap')}><span className="sr-only">Open</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortHeartbeatNodes(nodes).map(node => (
              <TableRow
                key={node.id}
                className={cn(PANEL_TABLE_ROW, PANEL_TABLE_ROW_ACTIONABLE, ROW_TINT[node.status])}
                onClick={() => onOpenNode(node.id)}
              >
                <TableCell className="w-px whitespace-nowrap">
                  <span className={cn('inline-block h-2 w-2 rounded-full', DOT_CLASS[node.status])} aria-hidden />
                </TableCell>
                <TableCell className="w-full max-w-0">
                  {/* The status dot is decorative, so the button's label carries
                      the state for a screen reader as well as the destination. */}
                  <RowAction label={`Open ${node.name} (${node.status}) in Fleet`}>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-mono text-xs text-stat-value">{node.name}</span>
                      {node.type === 'local' && (
                        <span className="shrink-0 rounded-sm border border-brand/30 bg-brand/10 px-1.5 py-px font-mono text-[10px] uppercase tracking-wide text-brand">
                          local
                        </span>
                      )}
                    </span>
                  </RowAction>
                </TableCell>
                <TableCell className={cn('w-px whitespace-nowrap font-mono text-[11px] uppercase tracking-wide', STATE_TEXT_CLASS[node.status])}>
                  {node.status}
                </TableCell>
                <TableCell className="w-px whitespace-nowrap text-right font-mono text-xs tabular-nums text-stat-subtitle">
                  {node.stats ? node.stats.active : '--'}
                </TableCell>
                <TableCell className="w-px whitespace-nowrap text-right font-mono text-xs tabular-nums text-stat-icon">
                  {contactLabel(node)}
                </TableCell>
                <TableCell className="w-px whitespace-nowrap">
                  <ChevronRight className="h-3.5 w-3.5 text-stat-icon" strokeWidth={1.5} aria-hidden />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </>
    );
  }

  return (
    // A column so the body can take whatever height the panel is given (Home
    // sizes it to the Recent alerts card) and scroll inside it.
    <DashboardPanel title="Fleet heartbeat" meta={meta} className={cn('flex flex-col', className)}>
      <ScrollArea block className="min-h-0 flex-1">
        {meshDown && meshDataPlane ? (
          <div className="px-5 pb-3">
            <MeshDataPlaneBanner status={meshDataPlane} variant="card" />
          </div>
        ) : null}
        {body}
      </ScrollArea>
    </DashboardPanel>
  );
}
