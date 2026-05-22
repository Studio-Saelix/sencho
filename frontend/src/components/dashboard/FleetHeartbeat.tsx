import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Radio, CheckCircle2 } from 'lucide-react';
import { formatRelativeTime } from '@/lib/utils';
import { useFleetHeartbeat } from './useFleetHeartbeat';
import { useMeshDataPlane } from './useMeshDataPlane';
import { useNodes } from '@/context/NodeContext';
import { MeshDataPlaneBanner } from '@/components/fleet/MeshDataPlaneBanner';
import type { FleetNodeOverview } from './useFleetHeartbeat';
import type { Node } from '@/context/NodeContext';

function StatusDot({ status }: { status: 'online' | 'offline' | 'unknown' }) {
  const colorClass =
    status === 'online'
      ? 'bg-success'
      : status === 'unknown'
        ? 'bg-warning'
        : 'bg-destructive';
  return (
    <span
      className={`inline-block h-2 w-2 rounded-full shrink-0 ${colorClass}`}
      aria-hidden="true"
    />
  );
}

function getLatencyLabel(node: FleetNodeOverview, isPilot: boolean): string | null {
  if (node.type === 'local') return null;
  if (isPilot) return 'n/a';
  if (node.status === 'online' && node.latency_ms !== undefined) return `${node.latency_ms} ms`;
  return null;
}

function getLastSeenLabel(node: FleetNodeOverview): string | null {
  if (node.status === 'online') return null;
  // Pilot-agent nodes use the tunnel heartbeat timestamp
  if (node.mode === 'pilot_agent') {
    if (node.pilot_last_seen) return formatRelativeTime(node.pilot_last_seen);
    return 'never reached';
  }
  // Proxy nodes use the contact timestamp updated by the fleet overview handler
  const contact = node.last_successful_contact;
  if (!contact) return 'never reached';
  return formatRelativeTime(contact);
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-2.5 py-1.5 px-1">
      <div className="h-2 w-2 rounded-full bg-accent/10 animate-pulse shrink-0" />
      <div className="h-3 w-24 rounded-sm bg-accent/10 animate-pulse" />
      <div className="h-3 flex-1 rounded-sm bg-accent/10 animate-pulse" />
      <div className="h-3 w-12 rounded-sm bg-accent/10 animate-pulse shrink-0" />
    </div>
  );
}

export function FleetHeartbeat() {
  const { nodes: overviewNodes, loading, error } = useFleetHeartbeat();
  const { status: meshDataPlane } = useMeshDataPlane();
  const { nodes: contextNodes } = useNodes();
  const meshDown = meshDataPlane?.ok === false
    && meshDataPlane.reason !== 'not_in_docker'
    && meshDataPlane.reason !== 'not_started';

  if (loading) {
    return (
      <Card className="bg-card shadow-card-bevel">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-stat-title">Fleet Heartbeat</CardTitle>
        </CardHeader>
        <CardContent className="pt-0 space-y-0.5">
          {Array.from({ length: 3 }).map((_, i) => <SkeletonRow key={i} />)}
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="bg-card shadow-card-bevel">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-stat-title">Fleet Heartbeat</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-xs text-stat-subtitle py-4 text-center">Unable to load fleet status.</p>
        </CardContent>
      </Card>
    );
  }

  const unreachableCount = overviewNodes.filter(n => n.status !== 'online').length;

  const sorted = overviewNodes.slice().sort((a, b) => {
    if (a.type === 'local' && b.type !== 'local') return -1;
    if (b.type === 'local' && a.type !== 'local') return 1;
    return 0;
  });

  return (
    <Card className="bg-card shadow-card-bevel">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-stat-title">Fleet Heartbeat</CardTitle>
          <div className="flex items-center gap-1.5">
            <Radio className="h-3.5 w-3.5 text-stat-icon" strokeWidth={1.5} />
            <span className="text-[10px] font-mono tracking-[0.18em] uppercase text-stat-subtitle">
              {overviewNodes.length} node{overviewNodes.length !== 1 ? 's' : ''}
              {unreachableCount > 0 && (
                <span className="text-destructive"> · {unreachableCount} unreachable</span>
              )}
              {meshDown && (
                <span className="text-destructive"> · mesh down</span>
              )}
            </span>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {meshDown && <MeshDataPlaneBanner status={meshDataPlane} variant="card" />}
        {sorted.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-stat-subtitle">
            <CheckCircle2 className="h-4 w-4 text-success" strokeWidth={1.5} />
            <span className="text-sm">No nodes registered.</span>
          </div>
        ) : (
          <div className="space-y-0.5">
            {sorted.map(node => {
              const ctxNode = contextNodes.find((n: Node) => n.id === node.id);
              const isPilot = ctxNode?.mode === 'pilot_agent';
              const containerText = node.stats
                ? `${node.stats.active} container${node.stats.active !== 1 ? 's' : ''}`
                : null;
              const latencyCell = getLatencyLabel(node, isPilot ?? false);
              const lastSeenCell = getLastSeenLabel(node);

              return (
                <div
                  key={node.id}
                  className="flex items-center gap-2.5 py-1.5 px-1 rounded-sm hover:bg-accent/5"
                >
                  <StatusDot status={node.status} />

                  <span className="text-xs font-mono text-stat-value truncate">
                    {node.name}
                  </span>

                  {node.type === 'local' && (
                    <span className="inline-flex items-center rounded-sm border border-brand/30 bg-brand/10 px-1.5 py-0.5 text-[10px] font-mono tracking-wide uppercase text-brand shrink-0">
                      local
                    </span>
                  )}

                  <span className="flex-1" />

                  {containerText && (
                    <span className="text-xs font-mono tabular-nums text-stat-subtitle shrink-0">
                      {containerText}
                    </span>
                  )}

                  {latencyCell !== null && (
                    <span className="text-xs font-mono tabular-nums text-stat-icon shrink-0 min-w-[3rem] text-right">
                      {latencyCell}
                    </span>
                  )}

                  {lastSeenCell !== null && (
                    <span className="text-xs font-mono tabular-nums text-stat-icon shrink-0">
                      {lastSeenCell}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
