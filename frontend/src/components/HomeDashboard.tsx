import { useNodes } from '@/context/NodeContext';
import type { NotificationItem } from './dashboard/types';
import type { SectionId } from './settings/types';
import type { StackUpdateInfo } from '@/types/imageUpdates';
import {
  HealthStatusBar,
  ResourceGauges,
  StackHealthTable,
  ConfigurationStatus,
  RecentAlerts,
  useDashboardData,
} from './dashboard';
import { DashboardActivityCard } from './dashboard/DashboardActivityCard';
import { useGitOpsSourceStates } from './dashboard/useGitOpsSourceStates';

interface HomeDashboardProps {
  onNavigateToStack?: (stackFile: string) => void;
  onOpenSettingsSection?: (section: SectionId) => void;
  notifications: NotificationItem[];
  onClearNotifications: () => void | Promise<void>;
  stackUpdates?: Record<string, StackUpdateInfo>;
}

const NOOP = () => {};

export default function HomeDashboard({ onNavigateToStack, onOpenSettingsSection, notifications, onClearNotifications, stackUpdates = {} }: HomeDashboardProps) {
  const { activeNode, nodes } = useNodes();
  const data = useDashboardData();
  const gitopsSourceStates = useGitOpsSourceStates();
  const activeNodeName = activeNode?.name || 'Local';

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
        stackStatuses={data.stackStatuses}
        stackStatusesLoadStatus={data.stackStatusesLoadStatus}
        stackStatusesLoadError={data.stackStatusesLoadError}
        onRetryStackStatuses={data.retryStackStatuses}
        metrics={data.metrics}
        stackCpuSeries={data.stackCpuSeries}
        onNavigateToStack={onNavigateToStack ?? NOOP}
        stackUpdates={stackUpdates}
        gitopsSourceStates={gitopsSourceStates}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ConfigurationStatus onOpenSection={onOpenSettingsSection} />
        <DashboardActivityCard />
      </div>

      <RecentAlerts
        notifications={notifications}
        nodes={nodes}
        onCleared={onClearNotifications}
      />
    </div>
  );
}
