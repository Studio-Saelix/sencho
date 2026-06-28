import { useNodes } from '@/context/NodeContext';
import { useAuth } from '@/context/AuthContext';
import { FleetHeartbeat } from './FleetHeartbeat';
import { StackRestartMap } from './StackRestartMap';

export function DashboardActivityCard() {
  const { nodes } = useNodes();
  const { can } = useAuth();
  const hasRemoteNodes = nodes.some(n => n.type === 'remote');

  // The fleet heartbeat reads /fleet/overview, which is gated on node:read; a
  // role without it (deployer) gets the single-node restart map instead so the
  // card never shows a fleet view it cannot load.
  if (hasRemoteNodes && can('node:read')) {
    return <FleetHeartbeat />;
  }

  return <StackRestartMap />;
}
