import { useMemo, useState } from 'react';

export type SortDir = 'asc' | 'desc';

/**
 * Shared client-side table sort. Pass a stable `comparators` map (define it at
 * module scope so the memo does not re-sort every render). This is the standard
 * sort behavior for data tables, mirroring the Security Images tab.
 */
export function useTableSort<T, K extends string>(
  items: T[],
  comparators: Record<K, (a: T, b: T) => number>,
  // NoInfer so K is inferred from `comparators` only; otherwise `initialKey`
  // collapses K to a single literal and the column keys fail to type-check.
  initialKey: NoInfer<K>,
  initialDir: SortDir = 'asc',
) {
  const [sortKey, setSortKey] = useState<K>(initialKey);
  const [sortDir, setSortDir] = useState<SortDir>(initialDir);

  const sorted = useMemo(() => {
    const cmp = comparators[sortKey];
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...items].sort((a, b) => cmp(a, b) * dir);
  }, [items, comparators, sortKey, sortDir]);

  const toggleSort = (key: K) => {
    if (key === sortKey) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir('asc'); }
  };

  return { sorted, sortKey, sortDir, toggleSort };
}
