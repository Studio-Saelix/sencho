import { useEffect, useState } from 'react';
import { PageMasthead, type MastheadMetadataItem } from '@/components/ui/PageMasthead';
import { formatAgeShort } from '@/lib/relativeTime';
import { deriveFleetMastheadState } from './fleetMastheadState';

interface FleetMastheadProps {
  nodeCount: number;
  onlineCount: number;
  criticalCount: number;
  totalCpuPercent: number;
  totalMemUsed: number;
  activeContainers: number;
  totalContainers: number;
  lastSyncAt: number | null;
  loading: boolean;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 GiB';
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

/** Owns the one-second clock so only this text re-renders each tick. */
function SyncedAgo({ lastSyncAt, loading }: { lastSyncAt: number | null; loading: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (loading) return <>syncing…</>;
  if (lastSyncAt === null) return <>not synced</>;
  return <>synced {formatAgeShort(now - lastSyncAt)} ago</>;
}

export function FleetMasthead(props: FleetMastheadProps) {
  const { nodeCount, onlineCount, criticalCount, totalCpuPercent, totalMemUsed, activeContainers, totalContainers, lastSyncAt, loading } = props;
  const { state, tone } = deriveFleetMastheadState(props);
  const offlineCount = Math.max(0, nodeCount - onlineCount);

  // The state word carries the verdict; the subtitle names what is behind it.
  // No node count until there is a sync to count from: "0 nodes" would be a
  // fact the page does not have yet.
  const detail = [
    lastSyncAt !== null ? `${nodeCount} ${nodeCount === 1 ? 'node' : 'nodes'}` : null,
    offlineCount > 0 ? `${offlineCount} offline` : null,
    criticalCount > 0 ? `${criticalCount} critical` : null,
  ].filter((part): part is string => part !== null);

  const metadata: MastheadMetadataItem[] = [
    { label: 'CPU', value: `${totalCpuPercent.toFixed(0)}%`, tone: totalCpuPercent >= 80 ? 'warn' : 'value' },
    { label: 'MEM', value: formatBytes(totalMemUsed) },
    { label: 'CONTAINERS', value: `${activeContainers}/${totalContainers}` },
  ];

  return (
    <PageMasthead
      kicker="fleet"
      state={state}
      tone={tone}
      pulsing={tone === 'live'}
      subtitle={<>{detail.map(part => `${part} · `).join('')}<SyncedAgo lastSyncAt={lastSyncAt} loading={loading} /></>}
      metadata={metadata}
      size="hero"
      className="rounded-lg mb-4"
    />
  );
}
