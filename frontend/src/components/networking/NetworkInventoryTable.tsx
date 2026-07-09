import { useMemo, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Eye, Search, Trash2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface NetworkingNetworkRow {
  id: string;
  name: string;
  driver: string;
  scope: string;
  isSystem: boolean;
  composeProject: string | null;
  stack: string | null;
  connectedCount: number;
  isSencho: boolean;
  sharedStackCount: number;
  findingIds: string[];
}

type NetworkFilter = 'all' | 'managed' | 'external';

function isManagedRow(row: NetworkingNetworkRow): boolean {
  return row.stack !== null || row.composeProject !== null;
}

function FilterToggle({
  value,
  onChange,
  counts,
}: {
  value: NetworkFilter;
  onChange: (v: NetworkFilter) => void;
  counts: { all: number; managed: number; external: number };
}) {
  const options: { key: NetworkFilter; label: string; count: number }[] = [
    { key: 'all', label: 'All', count: counts.all },
    { key: 'managed', label: 'Managed', count: counts.managed },
    { key: 'external', label: 'External', count: counts.external },
  ];

  return (
    <div className="flex items-center gap-1">
      {options.map(({ key, label, count }) => (
        <Button
          key={key}
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            'h-7 px-2.5 text-xs font-medium rounded-md',
            value === key ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
          )}
          onClick={() => onChange(key)}
        >
          {label}
          <span className="ml-1 tabular-nums opacity-70">{count}</span>
        </Button>
      ))}
    </div>
  );
}

export function NetworkInventoryTable({
  rows,
  loading,
  isAdmin,
  onInspect,
  onDelete,
}: {
  rows: NetworkingNetworkRow[];
  loading: boolean;
  isAdmin: boolean;
  onInspect: (id: string) => void;
  onDelete: (id: string, name: string) => void;
}) {
  const [filter, setFilter] = useState<NetworkFilter>('all');
  const [search, setSearch] = useState('');

  const counts = useMemo(() => ({
    all: rows.length,
    managed: rows.filter(isManagedRow).length,
    external: rows.filter(r => !isManagedRow(r)).length,
  }), [rows]);

  const filtered = useMemo(() => rows.filter(row => {
    if (filter === 'managed' && !isManagedRow(row)) return false;
    if (filter === 'external' && isManagedRow(row)) return false;
    if (search && !row.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [rows, filter, search]);

  if (loading) return <p className="text-sm text-muted-foreground">Loading networks…</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search networks..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 h-9"
          />
        </div>
        <FilterToggle value={filter} onChange={setFilter} counts={counts} />
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No networks match this filter.</p>
      ) : (
        <div className="rounded-lg border border-card-border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Driver</TableHead>
                <TableHead>Stack</TableHead>
                <TableHead className="text-right">Connected</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map(row => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">{row.name}</TableCell>
                  <TableCell className="text-xs text-stat-subtitle">{row.driver}</TableCell>
                  <TableCell className="text-xs text-stat-subtitle">{row.stack ?? row.composeProject ?? 'none'}</TableCell>
                  <TableCell className="text-right tabular-nums text-xs">{row.connectedCount}</TableCell>
                  <TableCell>
                    <div className="flex items-center justify-end gap-1">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => onInspect(row.id)} aria-label={`Inspect ${row.name}`}>
                        <Eye className="w-3.5 h-3.5" strokeWidth={1.5} />
                      </Button>
                      {isAdmin && (
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <span className={row.isSencho ? 'cursor-not-allowed' : undefined}>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 text-destructive/60 hover:bg-destructive hover:text-destructive-foreground transition-colors disabled:opacity-30"
                                  disabled={row.isSystem || row.isSencho}
                                  onClick={() => onDelete(row.id, row.name)}
                                  aria-label={`Delete ${row.name}`}
                                >
                                  <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                                </Button>
                              </span>
                            </TooltipTrigger>
                            {row.isSencho && <TooltipContent>Protected · running Sencho instance</TooltipContent>}
                          </Tooltip>
                        </TooltipProvider>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
