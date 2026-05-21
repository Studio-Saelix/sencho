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

  // Grid breakpoints per audit §18.7: 1 / 2 / 3 columns at 760 / 1280. The
  // 4-column breakpoint is reserved for when a 4th card lands; v1 has three
  // so it is intentionally omitted to avoid a hanging gap on wide displays.
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-[18px] items-start auto-rows-min">
      <LabelFleetStopCard nodes={nodes} />
      <BulkLabelAssignCard nodes={nodes} />
      <FleetPruneCard nodes={nodes} />
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
