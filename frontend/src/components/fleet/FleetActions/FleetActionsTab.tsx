import { Tags } from 'lucide-react';
import { useLicense } from '@/context/LicenseContext';
import type { FleetNode } from '@/components/FleetView/types';
import { LabelFleetStopCard } from './cards/LabelFleetStopCard';
import { BulkLabelAssignCard } from './cards/BulkLabelAssignCard';
import { FleetPruneCard } from './cards/FleetPruneCard';

interface Props {
  nodes: FleetNode[];
}

export function FleetActionsTab({ nodes }: Props) {
  const { isPaid } = useLicense();

  if (nodes.length === 0) {
    return (
      <div className="text-sm text-stat-subtitle">Add a node to the fleet to use bulk actions.</div>
    );
  }

  if (!isPaid) {
    return <EmptyState />;
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
      <LabelFleetStopCard nodes={nodes} />
    </div>
  );
}

// Note: the §18.8 Community-tier "single full-width card with cyan rail + locked
// footer (shell only, no upsell)" redesign is deferred to a follow-up PR.
// Tracked in docs/internal/refactor/fleet-action-card-migration.md.
function EmptyState() {
  return (
    <div className="rounded-lg border border-card-border/60 bg-card p-8 text-center">
      <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-md bg-glass-highlight">
        <Tags className="h-5 w-5 text-stat-subtitle" strokeWidth={1.5} />
      </div>
      <h3 className="text-sm font-medium text-stat-value mb-1">Fleet-wide bulk actions</h3>
      <p className="text-xs text-stat-subtitle max-w-md mx-auto">
        Stop stacks across every node by label name, assign labels to many stacks at once, and reclaim Docker disk space fleet-wide. Available on Skipper and Admiral.
      </p>
    </div>
  );
}
