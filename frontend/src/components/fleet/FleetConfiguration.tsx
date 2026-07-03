import { useState, useEffect, useCallback, useMemo } from 'react';
import { apiFetch } from '@/lib/api';
import { formatCount } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Bell, Zap, Shield, HardDrive, WifiOff, CheckCircle2, RefreshCw,
} from 'lucide-react';
import { useFleetSyncStatus } from '@/hooks/useFleetSyncStatus';
import { STICKY_CONTROL_IDENTITY_MISMATCH, type FleetSyncStatus } from '@/lib/fleetSyncApi';
import type { ConfigurationStatusPayload } from '@/components/dashboard';

interface FleetNodeConfiguration {
  id: number;
  name: string;
  type: 'local' | 'remote';
  status: 'online' | 'offline';
  configuration: ConfigurationStatusPayload | null;
}

function SummaryRow({ icon: Icon, label, value }: {
  icon: typeof Bell;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <Icon className="h-3 w-3 shrink-0 text-stat-icon" strokeWidth={1.5} />
      <span className="text-xs flex-1 text-stat-subtitle">{label}</span>
      <span className="text-xs font-mono tabular-nums text-stat-value">{value}</span>
    </div>
  );
}

type PolicySyncState =
  | { kind: 'in_sync' }
  | { kind: 'degraded'; lastError: string | null }
  | { kind: 'paused' };

function derivePolicySyncState(rows: FleetSyncStatus[]): PolicySyncState | null {
  if (rows.length === 0) return null;
  for (const row of rows) {
    if (row.sticky_error_code === STICKY_CONTROL_IDENTITY_MISMATCH) {
      return { kind: 'paused' };
    }
  }
  let degradedError: string | null = null;
  let hasSuccess = false;
  for (const row of rows) {
    if (row.last_success_at !== null) hasSuccess = true;
    if (
      row.last_failure_at !== null
      && (row.last_success_at === null || row.last_failure_at > row.last_success_at)
    ) {
      degradedError = row.last_error;
    }
  }
  if (degradedError !== null) return { kind: 'degraded', lastError: degradedError };
  if (hasSuccess) return { kind: 'in_sync' };
  return null;
}

function PolicySyncRow({ state }: { state: PolicySyncState }) {
  if (state.kind === 'in_sync') {
    return <SummaryRow icon={RefreshCw} label="Policy sync" value="In sync" />;
  }
  const tooltip = state.kind === 'paused'
    ? 'Anchored to another central. Open Settings → Nodes to reset the anchor or remove the node.'
    : (state.lastError ?? 'Last push to this node failed.');
  return (
    <div className="flex items-center gap-2 py-0.5">
      <RefreshCw className="h-3 w-3 shrink-0 text-stat-icon" strokeWidth={1.5} />
      <span className="text-xs flex-1 text-stat-subtitle">Policy sync</span>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>
            <span
              className={
                'inline-flex items-center rounded border px-1.5 py-0 text-[10px] leading-3 font-mono uppercase '
                + 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
              }
            >
              {state.kind === 'paused' ? 'paused' : 'degraded'}
            </span>
          </TooltipTrigger>
          <TooltipContent>{tooltip}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

function NodeCard({ node, policySyncState }: {
  node: FleetNodeConfiguration;
  policySyncState: PolicySyncState | null;
}) {
  const isRemote = node.type === 'remote';
  if (!node.configuration) {
    return (
      <Card className="bg-card shadow-card-bevel">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="font-medium text-sm text-stat-value">{node.name}</span>
            <Badge variant="outline" className="text-[10px] font-normal py-0 px-1.5 text-stat-subtitle">
              {isRemote ? 'Remote' : 'Local'}
            </Badge>
            <WifiOff className="h-3.5 w-3.5 text-stat-subtitle ml-auto" strokeWidth={1.5} />
            <span className="text-xs text-stat-subtitle">Offline</span>
          </div>
          <p className="text-xs text-stat-subtitle/60">Node is unreachable. Configuration unavailable.</p>
        </CardContent>
      </Card>
    );
  }

  const { notifications, automation, security, backup, thresholds } = node.configuration;

  const agentCount = [
    notifications.agents.discord.enabled,
    notifications.agents.slack.enabled,
    notifications.agents.webhook.enabled,
  ].filter(Boolean).length;

  return (
    <Card className="bg-card shadow-card-bevel">
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <span className="font-medium text-sm text-stat-value">{node.name}</span>
          <Badge variant="outline" className="text-[10px] font-normal py-0 px-1.5 text-stat-subtitle">
            {isRemote ? 'Remote' : 'Local'}
          </Badge>
          <div className="ml-auto flex items-center gap-1">
            <CheckCircle2 className="h-3.5 w-3.5 text-success" strokeWidth={1.5} />
            <span className="text-xs text-success">Online</span>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
          <SummaryRow icon={Bell} label="Agents"
            value={agentCount === 0 ? 'None' : `${agentCount} active`} />
          <SummaryRow icon={Bell} label="Alert rules"
            value={formatCount(notifications.alertRules, 'rule')} />
          <SummaryRow icon={Zap} label="Auto-heal"
            value={automation.autoHeal.total === 0
              ? 'None'
              : `${automation.autoHeal.enabled}/${automation.autoHeal.total}`} />
          {!automation.webhooks.locked && (
            <SummaryRow icon={Zap} label="Webhooks"
              value={formatCount(automation.webhooks.enabled, 'active')} />
          )}
          {!isRemote && (
            <SummaryRow icon={Shield} label="MFA"
              value={security.mfaEnabled === null ? 'Not set' : security.mfaEnabled ? 'On' : 'Off'} />
          )}
          {!security.scanPolicies.locked && (
            <SummaryRow icon={Shield} label="Scanning"
              value={formatCount(security.scanPolicies.enabled, 'policy')} />
          )}
          {!isRemote && !backup.locked && (
            <SummaryRow icon={HardDrive} label="Backup"
              value={backup.provider === 'disabled' ? 'Disabled' : 'Enabled'} />
          )}
          <SummaryRow icon={HardDrive} label="Crash detect"
            value={thresholds.globalCrash ? 'On' : 'Off'} />
          {policySyncState && <PolicySyncRow state={policySyncState} />}
        </div>
      </CardContent>
    </Card>
  );
}

export function FleetConfiguration() {
  const { statuses: syncStatuses } = useFleetSyncStatus();
  const [nodes, setNodes] = useState<FleetNodeConfiguration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const syncStateByNode = useMemo(() => {
    const byNode = new Map<number, FleetSyncStatus[]>();
    for (const row of syncStatuses) {
      const list = byNode.get(row.node_id);
      if (list) list.push(row);
      else byNode.set(row.node_id, [row]);
    }
    const out = new Map<number, PolicySyncState>();
    for (const [nodeId, rows] of byNode) {
      const state = derivePolicySyncState(rows);
      if (state) out.set(nodeId, state);
    }
    return out;
  }, [syncStatuses]);

  const fetchData = useCallback(async () => {
    try {
      const res = await apiFetch('/fleet/configuration', { localOnly: true });
      if (!res.ok) {
        setError('Failed to fetch fleet configuration.');
        return;
      }
      const data = await res.json() as FleetNodeConfiguration[];
      setNodes(data);
      setError(null);
    } catch {
      setError('Unable to reach the server.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 p-1">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i} className="bg-card shadow-card-bevel">
            <CardContent className="p-4 space-y-2">
              <div className="h-4 w-32 rounded-sm bg-accent/10 animate-pulse" />
              {Array.from({ length: 4 }).map((_, j) => (
                <div key={j} className="h-3 rounded-sm bg-accent/10 animate-pulse" />
              ))}
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-16 text-stat-subtitle">
        <p className="text-sm">{error}</p>
      </div>
    );
  }

  if (nodes.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-stat-subtitle">
        <p className="text-sm">No nodes configured.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 p-1">
      {nodes.map(node => (
        <NodeCard
          key={node.id}
          node={node}
          policySyncState={syncStateByNode.get(node.id) ?? null}
        />
      ))}
    </div>
  );
}
