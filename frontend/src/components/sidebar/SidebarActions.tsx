import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { FolderSearch, Loader2, LayoutList } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SidebarActionsProps {
  createStackSlot: ReactNode;
  onScan: () => void;
  isScanning: boolean;
  bulkMode: boolean;
  onToggleBulkMode: () => void;
}

export function SidebarActions({ createStackSlot, onScan, isScanning, bulkMode, onToggleBulkMode }: SidebarActionsProps) {
  return (
    <div className="p-4 flex gap-2">
      <div className="min-w-0 flex-1">{createStackSlot}</div>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className={cn('rounded-lg shrink-0 shadow-btn-glow', bulkMode && 'border-brand/40 text-brand bg-brand/10')}
              onClick={onToggleBulkMode}
              aria-pressed={bulkMode}
            >
              <LayoutList className="w-4 h-4" strokeWidth={1.5} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Bulk mode (B)</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="rounded-lg shrink-0 shadow-btn-glow"
              onClick={onScan}
              disabled={isScanning}
            >
              {isScanning
                ? <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.5} />
                : <FolderSearch className="w-4 h-4" strokeWidth={1.5} />}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p>Scan stacks folder</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}
