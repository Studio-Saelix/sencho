import { useMemo, useState } from 'react';
import { Boxes, AlertTriangle, Search, ArrowUp, ArrowDown, ChevronLeft, ChevronRight, ShieldCheck, Loader2 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SeverityBadge } from '@/components/ui/SeverityBadge';
import { getSeverityKey, type SeverityKey } from '@/lib/severityStyles';
import { formatTimeAgo } from '@/lib/relativeTime';
import { cn } from '@/lib/utils';
import type { ScanSummary, ScanDetailTab, ScannerKind } from '@/types/security';

const PAGE_SIZE = 12;

type SortKey = 'image_ref' | 'scanned_at' | 'severity' | 'findings';

const SEVERITY_RANK: Record<SeverityKey, number> = {
  CRITICAL: 6, HIGH: 5, MEDIUM: 4, LOW: 3, UNKNOWN: 2, FINDINGS: 1, CLEAN: 0,
};

/** Sortable column header. Module-scoped so it is a stable component. */
function SortHead({ label, k, sortKey, sortDir, onSort, className }: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  onSort: (k: SortKey) => void;
  className?: string;
}) {
  return (
    <TableHead className={cn('text-[10px] uppercase tracking-[0.18em] cursor-pointer select-none', className)}>
      <button type="button" onClick={() => onSort(k)} className="inline-flex items-center gap-1 hover:text-stat-value">
        {label}
        {sortKey === k && (sortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
      </button>
    </TableHead>
  );
}

const FILTER_OPTIONS: Array<{ value: 'all' | SeverityKey; label: string }> = [
  { value: 'all', label: 'All severities' },
  { value: 'CRITICAL', label: 'Critical' },
  { value: 'HIGH', label: 'High' },
  { value: 'MEDIUM', label: 'Medium' },
  { value: 'LOW', label: 'Low' },
  { value: 'FINDINGS', label: 'Secrets / misconfigs' },
  { value: 'CLEAN', label: 'Clean' },
];

const findingsCount = (s: ScanSummary) => s.total + (s.secret_count ?? 0) + (s.misconfig_count ?? 0);

interface ImagesTabProps {
  summaries: Record<string, ScanSummary>;
  loading: boolean;
  /** True when the summaries fetch failed; render an error state, never a false "clean". */
  error?: boolean;
  onInspect: (scanId: number, initialTab?: ScanDetailTab) => void;
  /** Admin on a node with a ready scanner; gates the scan Actions column. */
  canScan: boolean;
  /** image_ref of the scan currently in flight, for the per-row spinner. */
  scanningRef: string | null;
  onScan: (imageRef: string, scanners: ScannerKind[]) => void;
}

/** Latest-scan index for real images (stack/config scans live in Compose risks). */
export function ImagesTab({ summaries, loading, error, onInspect, canScan, scanningRef, onScan }: ImagesTabProps) {
  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState('all');
  const [sortKey, setSortKey] = useState<SortKey>('scanned_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return Object.values(summaries)
      .filter((s) => !s.image_ref.startsWith('stack:'))
      .filter((s) => (term ? s.image_ref.toLowerCase().includes(term) : true))
      .filter((s) => (severity === 'all' ? true : getSeverityKey(s) === severity));
  }, [summaries, search, severity]);

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sortKey) {
        case 'image_ref': return a.image_ref.localeCompare(b.image_ref) * dir;
        case 'severity': return (SEVERITY_RANK[getSeverityKey(a)] - SEVERITY_RANK[getSeverityKey(b)]) * dir;
        case 'findings': return (findingsCount(a) - findingsCount(b)) * dir;
        default: return (a.scanned_at - b.scanned_at) * dir;
      }
    });
  }, [filtered, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = sorted.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'image_ref' ? 'asc' : 'desc'); }
    setPage(0);
  };

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertTriangle className="w-12 h-12 text-warning/60 mb-4" strokeWidth={1.5} />
        <h3 className="text-lg font-medium mb-1">Couldn't load scan results</h3>
        <p className="text-sm text-muted-foreground">Scan results failed to load for this node. Try again shortly.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-12 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-lg" />
      </div>
    );
  }

  const noImagesAtAll = Object.values(summaries).every((s) => s.image_ref.startsWith('stack:'));
  if (noImagesAtAll) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Boxes className="w-12 h-12 text-muted-foreground/50 mb-4" strokeWidth={1.5} />
        <h3 className="text-lg font-medium mb-1">No scanned images</h3>
        <p className="text-sm text-muted-foreground">Scan an image from Resources to see its findings here.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
          <Input
            placeholder="Search images..."
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(0); }}
            className="pl-8"
          />
        </div>
        <Combobox
          options={FILTER_OPTIONS}
          value={severity}
          onValueChange={(v) => { setSeverity(v || 'all'); setPage(0); }}
          className="w-[180px]"
        />
      </div>

      <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel overflow-hidden">
        <ScrollArea className="max-h-[62vh] bg-background">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <SortHead label="Image" k="image_ref" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortHead label="Findings" k="findings" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="max-md:hidden" />
                <SortHead label="Last scan" k="scanned_at" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} className="max-md:hidden" />
                <SortHead label="Severity" k="severity" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                {canScan && <TableHead className="text-right text-[10px] uppercase tracking-[0.18em]">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageItems.map((s) => (
                <TableRow key={s.image_ref} className="hover:bg-muted/30 transition-colors">
                  <TableCell className="font-mono text-xs truncate max-w-[280px]">
                    <button type="button" className="hover:text-brand truncate block w-full text-left" onClick={() => onInspect(s.scan_id, 'vulns')}>
                      {s.image_ref}
                    </button>
                  </TableCell>
                  <TableCell className="max-md:hidden">
                    <button
                      type="button"
                      onClick={() => onInspect(s.scan_id, 'vulns')}
                      className="font-mono tabular-nums text-xs text-stat-subtitle text-left hover:text-stat-value transition-colors"
                    >
                      {s.critical > 0 && <span className="text-destructive mr-2">{s.critical}C</span>}
                      {s.high > 0 && <span className="text-warning mr-2">{s.high}H</span>}
                      {s.secret_count > 0 && <span className="text-warning mr-2">{s.secret_count} secret</span>}
                      {s.misconfig_count > 0 && <span className="text-warning mr-2">{s.misconfig_count} misconfig</span>}
                      {s.fixable > 0 && <span className="text-stat-subtitle">{s.fixable} fixable</span>}
                      {findingsCount(s) === 0 && <span className="text-success">clean</span>}
                    </button>
                  </TableCell>
                  <TableCell className="font-mono text-xs text-stat-subtitle whitespace-nowrap max-md:hidden">
                    {formatTimeAgo(s.scanned_at)}
                  </TableCell>
                  <TableCell>
                    <SeverityBadge summary={s} tooltip={false} onClick={() => onInspect(s.scan_id, 'vulns')} />
                  </TableCell>
                  {canScan && (
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground transition-colors"
                            disabled={scanningRef === s.image_ref}
                            title="Scan image"
                            aria-label={`Scan ${s.image_ref}`}
                          >
                            {scanningRef === s.image_ref
                              ? <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.5} />
                              : <ShieldCheck className="w-3.5 h-3.5" strokeWidth={1.5} />}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => onScan(s.image_ref, ['vuln'])}>
                            Scan (vulnerabilities)
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => onScan(s.image_ref, ['vuln', 'secret'])}>
                            Full scan (vulnerabilities + secrets)
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {pageItems.length === 0 && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No images match your search or filter.
            </div>
          )}
        </ScrollArea>
      </div>

      {sorted.length > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPage(Math.max(0, safePage - 1))} disabled={safePage === 0} aria-label="Previous page">
            <ChevronLeft className="w-4 h-4" strokeWidth={1.5} />
          </Button>
          <span className="text-xs text-stat-subtitle tabular-nums px-1">{safePage + 1} / {totalPages}</span>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))} disabled={safePage >= totalPages - 1} aria-label="Next page">
            <ChevronRight className="w-4 h-4" strokeWidth={1.5} />
          </Button>
        </div>
      )}
    </div>
  );
}
