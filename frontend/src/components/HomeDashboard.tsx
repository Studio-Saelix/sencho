import { useAuth } from '@/context/AuthContext';
import { useNodes } from '@/context/NodeContext';
import type { NotificationItem } from './dashboard/types';
import type { StackUpdateInfo } from '@/types/imageUpdates';
import {
  HealthStatusBar,
  ResourceGauges,
  StackHealthTable,
  FleetHeartbeat,
  ConfigurationSummary,
  RecentAlerts,
  useDashboardData,
} from './dashboard';
import type { AlertNavigation } from './dashboard/RecentAlerts';
import type { ConfigNavigation } from './dashboard/ConfigurationSummary';
import { useGitOpsSourceStates } from './dashboard/useGitOpsSourceStates';
import { useStackHealthScope, type StackHealthNavTarget } from './dashboard/useStackHealthScope';
import { useStackHealthScopePreference } from './dashboard/useStackHealthScopePreference';

/** Every way Home hands off to another surface. Built by the shell, which owns node switching. */
export interface HomeNavigation {
  toStack: (target: StackHealthNavTarget) => void;
  /** Opens one node's details in Fleet. */
  toFleetNode: (nodeId: number) => void;
  alerts: AlertNavigation;
  config: ConfigNavigation;
}

interface HomeDashboardProps {
  notifications: NotificationItem[];
  /** Nodes whose latest notification fetch did not land; null before the first fetch settles. */
  unreportedNodeIds: ReadonlySet<number> | null;
  navigation: HomeNavigation;
  stackUpdates?: Record<string, StackUpdateInfo>;
}

export default function HomeDashboard({ notifications, unreportedNodeIds, navigation, stackUpdates = {} }: HomeDashboardProps) {
  const { activeNode, nodes } = useNodes();
  const { can } = useAuth();
  const data = useDashboardData();
  const gitopsSourceStates = useGitOpsSourceStates();
  const [scope, setScope] = useStackHealthScopePreference();
  const health = useStackHealthScope({
    scope,
    stackStatuses: data.stackStatuses,
    stackStatusesFreshness: data.stackStatusesFreshness,
    stackStatusesLoadStatus: data.stackStatusesLoadStatus,
    stackStatusesLoadError: data.stackStatusesLoadError,
    retryStackStatuses: data.retryStackStatuses,
    metrics: data.metrics,
    stackCpuSeries: data.stackCpuSeries,
    gitopsSourceStates,
    stackUpdates,
  });
  const activeNodeName = activeNode?.name || 'Local';

  // The heartbeat needs at least one remote node and node:read (it reads
  // /fleet/overview). Otherwise, on a single-node install or for a role such as
  // deployer, Recent alerts takes the full width.
  const showFleetHeartbeat = nodes.some(n => n.type === 'remote') && can('node:read');

  const recentAlerts = (className?: string) => (
    <RecentAlerts
      notifications={notifications}
      nodes={nodes}
      activeNodeId={activeNode?.id ?? null}
      unreportedNodeIds={unreportedNodeIds}
      navigation={navigation.alerts}
      className={className}
    />
  );

  return (
    <div className="flex-1 p-6 space-y-4">
      <HealthStatusBar
        stats={data.stats}
        systemStats={data.systemStats}
        notifications={notifications}
        activeNodeName={activeNodeName}
        nodeCount={data.nodeCount}
        lastSyncAt={data.lastSyncAt}
        metricsStale={data.metricsStale}
      />

      <ResourceGauges
        systemStats={data.systemStats}
        cpuHistory={data.cpuHistory}
        netHistory={data.netHistory}
        historyEndAt={data.historyEndAt}
      />

      <StackHealthTable
        scope={scope}
        onScopeChange={setScope}
        showScopeControl={health.showScopeControl}
        view={health.view}
        viewError={health.viewError}
        rows={health.rows}
        coverage={health.coverage}
        incomplete={health.incomplete}
        onRetry={health.retry}
        onRetryFailedOrStale={health.incomplete ? health.retryFailedOrStale : undefined}
        onNavigateToStack={navigation.toStack}
      />

      {/* Source order is the reading order: alerts, then connectivity, then
          configuration. Side by side on xl, Recent alerts alone sets the row
          height: the heartbeat is taken out of flow inside its cell and fills
          it, scrolling when the fleet has more nodes than fit. Below xl the
          cards stack in the same order at their natural heights. */}
      {showFleetHeartbeat ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
          {recentAlerts('xl:col-span-3')}
          <div className="xl:relative xl:col-span-2">
            <FleetHeartbeat onOpenNode={navigation.toFleetNode} className="xl:absolute xl:inset-0" />
          </div>
        </div>
      ) : recentAlerts()}

      <ConfigurationSummary navigation={navigation.config} nodeName={activeNodeName} />
    </div>
  );
}
