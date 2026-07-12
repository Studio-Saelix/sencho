import { useMemo, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Eye, Search, Trash2, ExternalLink, GitBranch } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { filterNetworkRows, type NetworkFilter } from '@/lib/networking';
import type { NetworkingNetworkRow } from '@/types/networking';
export type { NetworkingNetworkRow } from '@/types/networking';

const FILTER_OPTIONS: { key: NetworkFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'managed', label: 'Managed' },
  { key: 'external', label: 'External dep.' },
  { key: 'system', label: 'System' },
  { key: 'shared', label: 'Shared' },
  { key: 'exposed', label: 'Exposed' },
  { key: 'drift', label: 'Drift' },
];

function FilterToggle({
  value,
  onChange,
  counts,
}: {
  value: NetworkFilter;
  onChange: (v: NetworkFilter) => void;
  counts: Record<NetworkFilter, number>;
}) {
  return (
    <div className="flex items-center gap-1">
      {FILTER_OPTIONS.map(({ key, label }) => (
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
          <span className="ml-1 tabular-nums opacity-70">{counts[key]}</span>
        </Button>
      ))}
    </div>
  );
}

function countNetworkFilters(rows: NetworkingNetworkRow[]): Record<NetworkFilter, number> {
  const counts: Record<NetworkFilter, number> = {
    all: rows.length,
    managed: 0,
    external: 0,
    system: 0,
    shared: 0,
    exposed: 0,
    drift: 0,
  };
  for (const row of rows) {
    if (row.ownership === 'sencho-managed') counts.managed += 1;
    if (row.isExternalDependency) counts.external += 1;
    if (row.ownership === 'system') counts.system += 1;
    if (row.sharedStackCount > 1) counts.shared += 1;
    if (row.exposureSummary?.broadExposureCount) counts.exposed += 1;
    if (row.findingIds.length > 0) counts.drift += 1;
  }
  return counts;
}

export function NetworkInventoryTable({
  rows,
  loading,
  isAdmin,
  onInspect,
  onDelete,
  onOpenStack,
  onFilterTopology,
}: {
  rows: NetworkingNetworkRow[];
  loading: boolean;
  isAdmin: boolean;
  onInspect: (id: string) => void;
  onDelete: (id: string, name: string) => void;
  onOpenStack: (stack: string) => void;
  onFilterTopology: (name: string) => void;
}) {
  const [filter, setFilter] = useState<NetworkFilter>('all');
  const [search, setSearch] = useState('');

  const counts = useMemo(() => countNetworkFilters(rows), [rows]);
  const filtered = useMemo(() => filterNetworkRows(rows, filter, search), [rows, filter, search]);

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
          <TooltipProvider>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Driver</TableHead>
                  <TableHead>Scope</TableHead>
                  <TableHead>Ownership</TableHead>
                  <TableHead>Shared</TableHead>
                  <TableHead>Exposure</TableHead>
                  <TableHead>Findings</TableHead>
                  <TableHead className="text-right">Connected</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs">{row.name}</TableCell>
                    <TableCell className="text-xs text-stat-subtitle">{row.driver}</TableCell>
                    <TableCell className="text-xs text-stat-subtitle">{row.scope}</TableCell>
                    <TableCell className="text-xs text-stat-subtitle">{row.ownership}</TableCell>
                    <TableCell className="text-xs tabular-nums">{row.sharedStackCount || '—'}</TableCell>
                    <TableCell className="text-xs tabular-nums">
                      {row.exposureSummary?.broadExposureCount ?? '—'}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">{row.findingIds.length || '—'}</TableCell>
                    <TableCell className="text-right tabular-nums text-xs">{row.connectedCount}</TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => onInspect(row.id)}
                          aria-label={`Inspect ${row.name}`}
                        >
                          <Eye className="w-3.5 h-3.5" strokeWidth={1.5} />
                        </Button>
                        {row.stack && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => onOpenStack(row.stack!)}
                            aria-label={`Open ${row.stack}`}
                          >
                            <ExternalLink className="w-3.5 h-3.5" strokeWidth={1.5} />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => onFilterTopology(row.name)}
                          aria-label={`Show ${row.name} in topology`}
                        >
                          <GitBranch className="w-3.5 h-3.5" strokeWidth={1.5} />
                        </Button>
                        {isAdmin && (
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
                            {row.isSencho && (
                              <TooltipContent>Protected · running Sencho instance</TooltipContent>
                            )}
                          </Tooltip>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TooltipProvider>
        </div>
      )}
    </div>
  );
}
