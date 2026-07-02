import type { ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { sidebarPinnedGroupRail } from './sidebar-styles';

interface StackGroupProps {
  id: string;
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  variant?: 'default' | 'pinned';
  headerActions?: ReactNode;
  children: ReactNode;
}

export function StackGroup({ id, label, count, collapsed, onToggle, variant = 'default', headerActions, children }: StackGroupProps) {
  const isPinned = variant === 'pinned';
  const labelColor = isPinned ? 'text-brand/90' : 'text-stat-subtitle';
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'relative flex items-center justify-between w-full py-1 text-left hover:bg-glass-highlight/30 rounded-md',
          isPinned ? sidebarPinnedGroupRail : 'px-2',
        )}
        aria-expanded={!collapsed}
        aria-controls={`group-${id}-body`}
      >
        <span className={cn('font-mono text-[9px] tracking-[0.22em] uppercase', labelColor)}>
          {isPinned ? '★ ' : ''}{label}
        </span>
        <span className="flex items-center gap-1.5">
          {headerActions}
          <span className="font-mono text-[9px] tabular-nums text-stat-icon">{count}</span>
          {collapsed
            ? <ChevronRight className="w-3 h-3 text-stat-icon" strokeWidth={1.5} />
            : <ChevronDown className="w-3 h-3 text-stat-icon" strokeWidth={1.5} />}
        </span>
      </button>
      {!collapsed && (
        <div id={`group-${id}-body`} className="mt-0.5">
          {children}
        </div>
      )}
    </div>
  );
}
