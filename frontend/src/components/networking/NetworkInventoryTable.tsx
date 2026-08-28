import { useEffect, useMemo, useRef, useState } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { SortableTableHead } from '@/components/ui/sortable-table';
import { useTableSort } from '@/hooks/useTableSort';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Eye, Search, Trash2, ExternalLink, GitBranch } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { filterNetworkRows, rowHasDriftFinding, type NetworkFilter } from '@/lib/networking';
import { type NetworkingFinding, type NetworkingFindingKind, type NetworkingNetworkRow, type NetworkingOwnership } from '@/types/networking';
export type { NetworkingNetworkRow } from '@/types/networking';

const OWNERSHIP_BADGE_CLASS: Record<NetworkingOwnership, string> = {
  'sencho-managed': 'border-success/40 text-success',
  'compose-managed': 'border-brand/40 text-brand',
  unmanaged: 'border-warning/40 text-warning',
  system: 'border-muted-foreground/30 text-muted-foreground',
};

const OWNERSHIP_LABEL: Record<NetworkingOwnership, string> = {
  'sencho-managed': 'Sencho-managed',
  'compose-managed': 'Compose-managed',
  unmanaged: 'Unmanaged',
  system: 'System',
};

function OwnershipBadge({ ownership }: { ownership: NetworkingOwnership }) {
  return (
    <Badge variant="outline" className={cn('h-5 text-[10px] font-mono', OWNERSHIP_BADGE_CLASS[ownership])}>
      {OWNERSHIP_LABEL[ownership]}
    </Badge>
  );
}

const COLUMN_COUNT = 9;

function NetworkTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <TableBody>
      {Array.from({ length: rows }).map((_, r) => (
        <TableRow key={r} className="animate-in fade-in-0" style={{ animationDelay: `${r * 40}ms` }}>
          {Array.from({ length: COLUMN_COUNT }).map((_, c) => (
            <TableCell key={c}>
              <Skeleton className={cn('h-4', c === 0 ? 'w-32' : c === 3 ? 'w-24' : 'w-10')} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </TableBody>
  );
}

/** A network is unsafe to delete without a pre-confirm explanation when it has
 *  connected containers or is declared by a stack's Compose file; the backend
 *  409-guards these, but the UI should explain BEFORE the confirm dialog rather
 *  than let a generic confirmation surprise the user with a rejection. When render
 *  verification is unavailable (a stack failed to render, or the Docker runtime is
 *  unreachable), declarations cannot be verified at all, so every non-system,
 *  non-Sencho network is held back the same way the backend does. */
function deleteBlockReason(row: NetworkingNetworkRow, renderVerificationUnavailable: boolean): string | null {
  if (row.connectedCount > 0) {
    return `Connected to ${row.connectedCount} container${row.connectedCount === 1 ? '' : 's'}; disconnect them first.`;
  }
  if (row.declaredByStacks.length > 0) {
    return `Declared by ${row.declaredByStacks.join(', ')}; remove the declaration first.`;
  }
  if (renderVerificationUnavailable) {
    return 'One or more stacks failed to render; stack declarations cannot be verified right now.';
  }
  return null;
}

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
          variant={value === key ? 'default' : 'outline'}
          size="sm"
          className="h-7 text-xs px-2.5 gap-1.5"
          onClick={() => onChange(key)}
        >
          {label}
          <span className="font-mono tabular-nums text-[10px] opacity-70">{counts[key]}</span>
        </Button>
      ))}
    </div>
  );
}

function countNetworkFilters(rows: NetworkingNetworkRow[], findingKindById: Map<string, NetworkingFindingKind>): Record<NetworkFilter, number> {
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
    if (rowHasDriftFinding(row, findingKindById)) counts.drift += 1;
  }
  return counts;
}

// Stable comparator map (module scope so useTableSort does not re-sort every
// render), mirroring the Resources image/volume table sort standard.
type NetworkSortKey = 'name' | 'driver' | 'scope' | 'ownership' | 'shared' | 'exposure' | 'findings' | 'connected';
const NETWORK_COMPARATORS: Record<NetworkSortKey, (a: NetworkingNetworkRow, b: NetworkingNetworkRow) => number> = {
  name: (a, b) => a.name.localeCompare(b.name),
  driver: (a, b) => a.driver.localeCompare(b.driver),
  scope: (a, b) => a.scope.localeCompare(b.scope),
  ownership: (a, b) => a.ownership.localeCompare(b.ownership),
  shared: (a, b) => a.sharedStackCount - b.sharedStackCount,
  exposure: (a, b) => (a.exposureSummary?.broadExposureCount ?? 0) - (b.exposureSummary?.broadExposureCount ?? 0),
  findings: (a, b) => a.findingIds.length - b.findingIds.length,
  connected: (a, b) => a.connectedCount - b.connectedCount,
};

export function NetworkInventoryTable({
  rows,
  findings,
  loading,
  isAdmin,
  onInspect,
  onDelete,
  onOpenStack,
  onFilterTopology,
  renderVerificationUnavailable,
}: {
  rows: NetworkingNetworkRow[];
  findings: NetworkingFinding[];
  loading: boolean;
  isAdmin: boolean;
  onInspect: (id: string) => void;
  onDelete: (id: string, name: string) => void;
  onOpenStack: (stack: string) => void;
  onFilterTopology: (name: string) => void;
  renderVerificationUnavailable: boolean;
}) {
  const [filter, setFilter] = useState<NetworkFilter>('all');
  const [search, setSearch] = useState('');
  const [searchExpanded, setSearchExpanded] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (searchExpanded) searchRef.current?.focus(); }, [searchExpanded]);

  const findingKindById = useMemo(
    () => new Map(findings.map((f) => [f.id, f.kind])),
    [findings],
  );
  const counts = useMemo(() => countNetworkFilters(rows, findingKindById), [rows, findingKindById]);
  const filtered = useMemo(
    () => filterNetworkRows(rows, filter, search, findingKindById),
    [rows, filter, search, findingKindById],
  );
  const { sorted, sortKey, sortDir, toggleSort } = useTableSort(filtered, NETWORK_COMPARATORS, 'name');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        {search !== '' || searchExpanded ? (
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <Input
              ref={searchRef}
              placeholder="Search network, stack, service, or driver..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onBlur={() => { if (search === '') setSearchExpanded(false); }}
              className="pl-9 h-9"
            />
          </div>
        ) : (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" className="h-9 w-9 p-0 shrink-0" onClick={() => setSearchExpanded(true)} aria-label="Search networks">
                  <Search className="w-4 h-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Search networks</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        <FilterToggle value={filter} onChange={setFilter} counts={counts} />
      </div>

      <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel overflow-hidden">
        <ScrollArea className="h-[62vh] max-md:h-auto">
          <TooltipProvider>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <SortableTableHead label="Name" columnKey="name" activeKey={sortKey} dir={sortDir} onSort={toggleSort} className="text-[11px]" />
                  <SortableTableHead label="Driver" columnKey="driver" activeKey={sortKey} dir={sortDir} onSort={toggleSort} className="text-[11px]" />
                  <SortableTableHead label="Scope" columnKey="scope" activeKey={sortKey} dir={sortDir} onSort={toggleSort} className="text-[11px]" />
                  <SortableTableHead label="Ownership" columnKey="ownership" activeKey={sortKey} dir={sortDir} onSort={toggleSort} className="text-[11px]" />
                  <SortableTableHead label="Shared" columnKey="shared" activeKey={sortKey} dir={sortDir} onSort={toggleSort} className="text-[11px]" />
                  <SortableTableHead label="Exposure" columnKey="exposure" activeKey={sortKey} dir={sortDir} onSort={toggleSort} className="text-[11px]" />
                  <SortableTableHead label="Findings" columnKey="findings" activeKey={sortKey} dir={sortDir} onSort={toggleSort} className="text-[11px]" />
                  <SortableTableHead label="Connected" columnKey="connected" activeKey={sortKey} dir={sortDir} onSort={toggleSort} className="text-right text-[11px]" />
                  <TableHead className="w-40 text-right text-[11px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              {loading ? <NetworkTableSkeleton /> : (
                <TableBody>
                  {sorted.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={COLUMN_COUNT} className="text-center py-8 text-muted-foreground text-sm">
                        No networks match this filter.
                      </TableCell>
                    </TableRow>
                  ) : sorted.map((row, i) => (
                    <TableRow
                      key={row.id}
                      className="animate-in fade-in-0 duration-200 hover:bg-muted/30 transition-colors"
                      style={{ animationDelay: `${Math.min(i * 20, 200)}ms` }}
                    >
                      <TableCell className="font-mono text-xs">{row.name}</TableCell>
                      <TableCell className="text-xs text-stat-subtitle">{row.driver}</TableCell>
                      <TableCell className="text-xs text-stat-subtitle">{row.scope}</TableCell>
                      <TableCell><OwnershipBadge ownership={row.ownership} /></TableCell>
                      <TableCell className="text-xs tabular-nums">{row.sharedStackCount || '—'}</TableCell>
                      <TableCell className="text-xs tabular-nums">
                        {row.exposureSummary?.broadExposureCount ?? '—'}
                      </TableCell>
                      <TableCell className="text-xs tabular-nums">{row.findingIds.length || '—'}</TableCell>
                      <TableCell className="text-right tabular-nums text-xs">{row.connectedCount}</TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          {row.stack && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  onClick={() => onOpenStack(row.stack!)}
                                  aria-label={`Open ${row.stack}`}
                                >
                                  <ExternalLink className="w-3.5 h-3.5" strokeWidth={1.5} />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Open stack</TooltipContent>
                            </Tooltip>
                          )}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => onInspect(row.id)}
                                aria-label={`Inspect ${row.name}`}
                              >
                                <Eye className="w-3.5 h-3.5" strokeWidth={1.5} />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>View details</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => onFilterTopology(row.name)}
                                aria-label={`Show ${row.name} in topology`}
                              >
                                <GitBranch className="w-3.5 h-3.5" strokeWidth={1.5} />
                              </Button>
                            </TooltipTrigger>
                            <TooltipContent>Show in topology</TooltipContent>
                          </Tooltip>
                          {isAdmin && (() => {
                            const blockReason = deleteBlockReason(row, renderVerificationUnavailable);
                            const protectedReason = row.isSencho
                              ? 'Protected · running Sencho instance'
                              : row.isSystem
                                ? 'System network'
                                : blockReason;
                            const disabled = row.isSystem || row.isSencho || blockReason !== null;
                            return (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className={disabled ? 'cursor-not-allowed' : undefined}>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7 text-destructive/60 hover:bg-destructive hover:text-destructive-foreground transition-colors disabled:opacity-30"
                                      disabled={disabled}
                                      onClick={() => onDelete(row.id, row.name)}
                                      aria-label={`Delete ${row.name}`}
                                    >
                                      <Trash2 className="w-3.5 h-3.5" strokeWidth={1.5} />
                                    </Button>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent>{protectedReason ?? 'Delete network'}</TooltipContent>
                              </Tooltip>
                            );
                          })()}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              )}
            </Table>
          </TooltipProvider>
        </ScrollArea>
      </div>
    </div>
  );
}
