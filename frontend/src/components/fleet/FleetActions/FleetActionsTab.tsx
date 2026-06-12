import type { FleetNode } from '@/components/FleetView/types';
import { LabelFleetStopCard } from './cards/LabelFleetStopCard';
import { BulkLabelAssignCard } from './cards/BulkLabelAssignCard';
import { FleetPruneCard } from './cards/FleetPruneCard';

interface Props {
  nodes: FleetNode[];
}

export function FleetActionsTab({ nodes }: Props) {
  if (nodes.length === 0) {
    return (
      <div className="text-sm text-stat-subtitle">Add a node to the fleet to use bulk actions.</div>
    );
  }

  // Grid: 1 col under lg, 2 cols at lg and above. auto-rows-fr distributes
  // available height evenly across the auto-created rows, and each card uses
  // `flex flex-col h-full` (in <FleetActionCard>) with a `flex-1` body so it
  // fills its grid cell. Result: all three cards render at the same height,
  // with shorter cards growing their body whitespace before the footer pins.
  // Order: Prune top-left, Bulk top-right, Stop on row 2.
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-[18px] auto-rows-fr">
      <FleetPruneCard nodes={nodes} />
      <BulkLabelAssignCard nodes={nodes} />
      <LabelFleetStopCard />
    </div>
  );
}
