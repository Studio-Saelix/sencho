import { FolderSearch, Plus, Layers } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface EmptyStackStateProps {
  // Open the create dialog on a given starting mode. Provided only when the
  // user has permission to create stacks; otherwise the buttons are hidden.
  onOpenCreate?: (mode: 'import' | 'empty') => void;
}

export function EmptyStackState({ onOpenCreate }: EmptyStackStateProps) {
  return (
    <div className="px-3 py-8 text-center">
      <Layers className="mx-auto h-6 w-6 text-stat-icon" strokeWidth={1.5} />
      <p className="mt-3 text-sm text-stat-title">No stacks yet</p>
      <p className="mx-auto mt-1 max-w-[200px] text-xs leading-relaxed text-stat-subtitle">
        Import compose files you already have, or create one from scratch.
      </p>
      {onOpenCreate && (
        <div className="mt-4 flex flex-col gap-2">
          <Button size="sm" className="w-full" onClick={() => onOpenCreate('import')}>
            <FolderSearch className="mr-1.5 h-4 w-4" strokeWidth={1.5} />
            Import existing
          </Button>
          <Button size="sm" variant="outline" className="w-full" onClick={() => onOpenCreate('empty')}>
            <Plus className="mr-1.5 h-4 w-4" strokeWidth={1.5} />
            New stack
          </Button>
        </div>
      )}
    </div>
  );
}
