import { Square, Tags } from 'lucide-react';
import { useLicense } from '@/context/LicenseContext';
import type { FleetNode } from '@/components/FleetView/types';
import { LabelFleetStopCard } from './cards/LabelFleetStopCard';
import { BulkLabelAssignCard } from './cards/BulkLabelAssignCard';

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
    // Both actions are Skipper+. Community users see a calm empty state with
    // upgrade context rather than a stripped-down launcher.
    return (
      <EmptyState />
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <LabelFleetStopCard nodes={nodes} accentTone="rose" icon={Square} />
      <BulkLabelAssignCard nodes={nodes} accentTone="purple" icon={Tags} />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-card-border/60 bg-card p-8 text-center">
      <div className="mx-auto mb-3 inline-flex h-10 w-10 items-center justify-center rounded-md bg-glass-highlight">
        <Tags className="h-5 w-5 text-stat-subtitle" strokeWidth={1.5} />
      </div>
      <h3 className="text-sm font-medium text-stat-value mb-1">Fleet-wide bulk actions</h3>
      <p className="text-xs text-stat-subtitle max-w-md mx-auto">
        Stop stacks across every node by label name, and assign labels to many
        stacks in one shot. Available on Skipper and Admiral.
      </p>
    </div>
  );
}
