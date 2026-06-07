import { Minus, Plus } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FilterChip } from './sidebar-types';

export interface FilterCounts {
  all: number;
  up: number;
  down: number;
  updates: number;
}

interface SidebarFilterChipsProps {
  active: FilterChip;
  counts: FilterCounts;
  onChange: (chip: FilterChip) => void;
  visible: boolean;
  onToggle: () => void;
}

const chips: { id: FilterChip; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'up', label: 'Up' },
  { id: 'down', label: 'Down' },
  { id: 'updates', label: 'Updates' },
];

export function SidebarFilterChips({ active, counts, onChange, visible, onToggle }: SidebarFilterChipsProps) {
  return (
    <div className="flex items-center pb-1.5 pt-0.5 pl-2">
      {visible ? (
        <div className="flex items-center gap-0.5 flex-1 min-w-0 overflow-hidden">
          {chips.map(({ id, label }) => {
            const count = counts[id];
            const displayCount = count > 99 ? '99+' : count;
            const isActive = active === id;
            const isUpdates = id === 'updates';
            const hasUpdates = isUpdates && count > 0;

            return (
              <button
                key={id}
                type="button"
                onClick={() => onChange(id)}
                className={cn(
                  'flex items-center justify-center gap-1 min-w-0 overflow-hidden rounded px-1.5 py-0.5 whitespace-nowrap',
                  // 44px tap target on touch viewports; desktop density unchanged.
                  'max-md:min-h-11 max-md:py-2',
                  'font-mono text-[10px] tracking-[0.08em] uppercase leading-none',
                  'border transition-colors duration-150',
                  isActive
                    ? 'bg-brand/10 border-brand/30 text-brand'
                    : hasUpdates
                      ? 'bg-update/5 border-update/20 text-update hover:bg-update/10'
                      : 'bg-transparent border-glass-border text-stat-subtitle hover:text-stat-title hover:border-glass-border',
                )}
                aria-pressed={isActive}
              >
                {label}
                <span className={cn(
                  'tabular-nums',
                  isActive ? 'text-brand/70' : hasUpdates ? 'text-update/70' : 'text-stat-icon',
                )}>
                  {displayCount}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="flex-1" />
      )}
      <button
        type="button"
        onClick={onToggle}
        className="px-2 max-md:min-h-11 max-md:px-3 shrink-0 text-stat-icon hover:text-stat-title transition-colors duration-150"
        aria-label={visible ? 'Hide filters' : 'Show filters'}
      >
        {visible
          ? <Minus className="w-3 h-3" strokeWidth={1.5} />
          : <Plus className="w-3 h-3" strokeWidth={1.5} />}
      </button>
    </div>
  );
}
