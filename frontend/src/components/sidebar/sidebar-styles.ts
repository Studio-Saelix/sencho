import { cn } from '@/lib/utils';

export const sidebarRowBase = cn(
  'relative flex items-center gap-2 w-full px-2 py-1.5 rounded-md mb-0.5',
  // 44px tap target on touch viewports without changing desktop density.
  'max-md:min-h-11 max-md:py-2.5',
  'font-mono text-[13px] text-muted-foreground',
  'hover:bg-glass-highlight hover:text-foreground',
  'transition-colors group cursor-pointer',
);

export const sidebarRowActive = cn(
  'bg-accent/[0.07] text-stat-value',
  'after:content-[""] after:absolute after:left-[-12px] after:top-1 after:bottom-1',
  'after:w-[3px] after:rounded-sm after:bg-brand',
  'after:shadow-[0_0_6px_var(--brand)]',
);

export const sidebarGroupHeader = cn(
  'flex items-center justify-between w-full px-2 pt-3 pb-1',
  'text-[9px] leading-3 tracking-[0.22em] uppercase text-stat-subtitle',
  'cursor-pointer select-none',
);

export const sidebarRowCheckboxSlot = 'shrink-0 w-4 h-4 opacity-0 pointer-events-none flex-shrink-0';

export const sidebarPinnedGroupRail = cn(
  'relative before:absolute before:left-0 before:top-0 before:bottom-0',
  'before:w-[3px] before:rounded-sm before:bg-brand',
  'before:shadow-[0_0_6px_var(--brand)]',
  'pl-[13px]',
);
