import { GitBranch, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { openBlueprintIntent } from '@/lib/blueprintIntent';
import { SENCHO_OPEN_CREATE_STACK_EVENT, type SenchoOpenCreateStackDetail } from '@/lib/events';
import { cn } from '@/lib/utils';
import { useWorkplaceCapabilities } from './useWorkplaceCapabilities';

function openConnectStack(): void {
  window.dispatchEvent(new CustomEvent<SenchoOpenCreateStackDetail>(SENCHO_OPEN_CREATE_STACK_EVENT, {
    detail: { mode: 'git' },
  }));
}

/**
 * The two ways into GitOps, as actions: connect a stack to a Git repository
 * (the Create Stack dialog's From Git flow) or declare a Blueprint (the Fleet
 * Blueprints create dialog). Both reuse the owning surface's own flow, so the
 * workplace never grows a second create path. Renders nothing for a role that
 * can do neither.
 */
export function WorkplaceActions({ className, includeBlueprint = true }: {
  className?: string;
  /** False on the phone, whose Fleet screen has no Blueprints tab to land on. */
  includeBlueprint?: boolean;
}) {
  const capabilities = useWorkplaceCapabilities();
  const canConnectStack = capabilities.canConnectStack;
  const canCreateBlueprint = includeBlueprint && capabilities.canCreateBlueprint;
  if (!canConnectStack && !canCreateBlueprint) return null;
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {canConnectStack && (
        <Button variant="outline" size="sm" className="gap-1.5 max-md:min-h-11" onClick={openConnectStack}>
          <GitBranch className="h-3.5 w-3.5" strokeWidth={1.5} />
          Connect a stack to Git
        </Button>
      )}
      {canCreateBlueprint && (
        <Button variant="outline" size="sm" className="gap-1.5 max-md:min-h-11" onClick={() => openBlueprintIntent({ kind: 'create' })}>
          <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
          New Blueprint
        </Button>
      )}
    </div>
  );
}
