import type { MastheadTone } from '@/components/ui/PageMasthead';

interface FleetMastheadInputs {
  nodeCount: number;
  onlineCount: number;
  criticalCount: number;
  loading: boolean;
  lastSyncAt: number | null;
}

interface FleetMastheadState {
  state: string;
  tone: MastheadTone;
}

/**
 * The page's one answer: is the fleet OK. "Checking" until the first overview
 * settles, so an empty node list never reads as healthy. If that first overview
 * failed (settled with no sync and no nodes) the state is "Unavailable", never
 * "No nodes", because the page does not know the fleet is empty.
 */
export function deriveFleetMastheadState({
  nodeCount, onlineCount, criticalCount, loading, lastSyncAt,
}: FleetMastheadInputs): FleetMastheadState {
  if (loading && lastSyncAt === null) return { state: 'Checking', tone: 'idle' };
  if (lastSyncAt === null) return { state: 'Unavailable', tone: 'warn' };
  if (nodeCount === 0) return { state: 'No nodes', tone: 'idle' };
  if (criticalCount > 0) return { state: 'Critical', tone: 'error' };
  if (onlineCount < nodeCount) return { state: 'Degraded', tone: 'warn' };
  return { state: 'Healthy', tone: 'live' };
}
