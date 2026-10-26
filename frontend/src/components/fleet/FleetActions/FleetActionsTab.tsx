import { useState } from 'react';
import { Card } from '@/components/ui/card';
import type { FleetNode } from '@/components/FleetView/types';
import { useAuth } from '@/context/AuthContext';
import { FleetActionRow } from './FleetActionRow';
import { LabelStacksSheet } from './sheets/LabelStacksSheet';
import { ReclaimSheet } from './sheets/ReclaimSheet';
import { StopByLabelSheet } from './sheets/StopByLabelSheet';
import { useFleetActionHints } from './useFleetActionHints';

interface Props {
  nodes: FleetNode[];
}

type Task = 'reclaim' | 'label' | 'stop';

export function FleetActionsTab({ nodes }: Props) {
  const { isAdmin } = useAuth();
  const [openTask, setOpenTask] = useState<Task | null>(null);
  // Each open remounts its sheet, so a task always starts from a clean slate
  // while the previous one still plays its close animation.
  const [sessions, setSessions] = useState<Record<Task, number>>({ reclaim: 0, label: 0, stop: 0 });
  const hints = useFleetActionHints(isAdmin);

  if (nodes.length === 0) {
    return (
      <div className="text-sm text-stat-subtitle">Add a node to the fleet to use bulk actions.</div>
    );
  }

  const open = (task: Task) => () => {
    setSessions((current) => ({ ...current, [task]: current[task] + 1 }));
    setOpenTask(task);
  };
  const onOpenChange = (task: Task) => (next: boolean) => {
    setOpenTask((current) => (next ? task : current === task ? null : current));
  };

  return (
    <>
      <Card className="overflow-hidden p-0">
        <ul className="divide-y divide-card-border/40">
          {isAdmin && (
            <FleetActionRow
              name="Reclaim disk space"
              description="Unused images, volumes and networks on every node"
              hint={hints.reclaim}
              verb="Prune…"
              onOpen={open('reclaim')}
            />
          )}
          <FleetActionRow
            name="Label stacks"
            description="Add one label to stacks on many nodes"
            hint={hints.labels}
            verb="Assign…"
            onOpen={open('label')}
          />
          <FleetActionRow
            name="Stop stacks by label"
            description="Every stack with a label, on every node"
            verb="Stop…"
            onOpen={open('stop')}
          />
        </ul>
      </Card>

      {isAdmin && (
        <ReclaimSheet
          key={`reclaim-${sessions.reclaim}`}
          open={openTask === 'reclaim'}
          onOpenChange={onOpenChange('reclaim')}
          nodes={nodes}
          onPruned={hints.refreshReclaim}
        />
      )}
      <LabelStacksSheet key={`label-${sessions.label}`} open={openTask === 'label'} onOpenChange={onOpenChange('label')} nodes={nodes} />
      <StopByLabelSheet key={`stop-${sessions.stop}`} open={openTask === 'stop'} onOpenChange={onOpenChange('stop')} />
    </>
  );
}
