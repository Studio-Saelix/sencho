import { ArrowUp, ArrowDown } from 'lucide-react';
import { TableHead } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { SortDir } from '@/hooks/useTableSort';

/** Clickable, sort-aware `<TableHead>`. Pairs with the `useTableSort` hook. */
export function SortableTableHead<K extends string>({
  label, columnKey, activeKey, dir, onSort, className,
}: {
  label: string;
  columnKey: K;
  activeKey: K;
  dir: SortDir;
  onSort: (k: K) => void;
  className?: string;
}) {
  const active = activeKey === columnKey;
  return (
    <TableHead className={cn('text-[11px] cursor-pointer select-none', className)}>
      <button
        type="button"
        onClick={() => onSort(columnKey)}
        className="inline-flex items-center gap-1 hover:text-foreground"
      >
        {label}
        {active && (dir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
      </button>
    </TableHead>
  );
}
