import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { BulkAction } from '@/hooks/useBulkStackActions';

interface SidebarBulkBarProps {
  selectedCount: number;
  onAction: (action: BulkAction) => void;
  onClear: () => void;
  /** False while status evidence is not authoritative; disables lifecycle
   *  buttons so bulk selection cannot mutate against unknown runtime state. */
  actionsReady?: boolean;
}

export function SidebarBulkBar({ selectedCount, onAction, onClear, actionsReady = false }: SidebarBulkBarProps) {
  return (
    <div className="px-3 py-2 border-b border-glass-border bg-glass-highlight/20">
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-mono text-[10px] text-brand tracking-[0.08em]">{selectedCount} selected</span>
        <button
          type="button"
          onClick={onClear}
          className="text-stat-icon hover:text-foreground transition-colors"
          aria-label="Clear selection"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="flex gap-1 flex-wrap">
        <Button variant="outline" size="sm" className="h-6 px-2 text-[10px] font-mono" disabled={!actionsReady} onClick={() => onAction('start')}>Start</Button>
        <Button variant="outline" size="sm" className="h-6 px-2 text-[10px] font-mono" disabled={!actionsReady} onClick={() => onAction('stop')}>Stop</Button>
        <Button variant="outline" size="sm" className="h-6 px-2 text-[10px] font-mono" disabled={!actionsReady} onClick={() => onAction('restart')}>Restart</Button>
        <Button variant="outline" size="sm" className="h-6 px-2 text-[10px] font-mono" disabled={!actionsReady} onClick={() => onAction('update')}>Update</Button>
      </div>
    </div>
  );
}
