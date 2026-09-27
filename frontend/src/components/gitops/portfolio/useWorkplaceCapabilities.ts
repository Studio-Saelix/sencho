import { useAuth } from '@/context/AuthContext';
import { useNodes } from '@/context/NodeContext';

/** Who may start each way into GitOps; the same grants the Create dialog and the Fleet view check. */
export function useWorkplaceCapabilities(): { canConnectStack: boolean; canCreateBlueprint: boolean; canOpenFleet: boolean } {
  const { can } = useAuth();
  const { hasCapability } = useNodes();
  const canOpenFleet = can('node:read') && hasCapability('fleet');
  return {
    canConnectStack: can('stack:create'),
    canCreateBlueprint: can('stack:create') && canOpenFleet,
    canOpenFleet,
  };
}
