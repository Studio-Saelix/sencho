import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ChevronLeft, ChevronRight, GitCompare, RefreshCw, Search, ArrowUp, ArrowDown } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';
import { useNodes } from '@/context/NodeContext';
import { FleetTabHeading } from '@/components/fleet/FleetEmptyState';
import { SeverityChip } from '../VulnerabilityScanSheet';
import { ScanComparisonSheet } from '../ScanComparisonSheet';
import type { VulnerabilityScan, ScanDetailTab, VulnSeverity } from '@/types/security';

const PAGE_SIZE = 100;
const SEVERITY_RANK: Record<VulnSeverity, number> = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1, UNKNOWN: 0 };

type SortKey = 'scanned_at' | 'image_ref' | 'severity' | 'total';

/** Sortable column header. Module-scoped so it is a stable component. */
function SortHead({ label, k, sortKey, sortDir, onSort, align }: {
  label: string;
  k: SortKey;
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  onSort: (k: SortKey) => void;
  align?: 'right';
}) {
  return (
    <TableHead className={cn('text-[11px] cursor-pointer select-none', align === 'right' && 'text-right')}>
      <button type="button" onClick={() => onSort(k)} className={cn('inline-flex items-center gap-1 hover:text-stat-value', align === 'right' && 'flex-row-reverse')}>
        {label}
        {sortKey === k && (sortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />)}
      </button>
    </TableHead>
  );
}

interface HistoryTabProps {
  onInspect: (scanId: number, initialTab?: ScanDetailTab) => void;
}

/** Inline scan-history table: search, sortable columns, two-scan compare, and
 *  server-paginated completed scans. Replaces the former history sheet. */
export function HistoryTab({ onInspect }: HistoryTabProps) {
  const { activeNode } = useNodes();
  const nodeId = activeNode?.id;

  const [scans, setScans] = useState<VulnerabilityScan[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [page, setPage] = useState(0);
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [compareIds, setCompareIds] = useState<[number, number] | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('scanned_at');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);

  const load = useCallback(async (pageToLoad: number, term: string) => {
    setLoading(true);
    setError(false);
    try {
      const params = new URLSearchParams({
        status: 'completed',
        limit: String(PAGE_SIZE),
        offset: String(pageToLoad * PAGE_SIZE),
      });
      if (term.trim()) params.set('imageRefLike', term.trim());
      const res = await apiFetch(`/security/scans?${params.toString()}`);
      if (!res.ok) {
        setError(true);
        return;
      }
      const data = await res.json();
      if (!data || !Array.isArray(data.items)) {
        // A 200 with an unexpected shape must surface as an error, not as an
        // empty "no completed scans yet" state.
        setError(true);
        return;
      }
      setScans(data.items);
      setTotal(typeof data.total === 'number' ? data.total : data.items.length);
    } catch (err) {
      console.error('[Security] Failed to load scan history:', err);
      toast.error('Failed to load scan history');
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(safePage, search); }, [load, safePage, search, nodeId]);

  const toggleSelect = (scanId: number) => {
    setSelected((prev) => {
      if (prev.includes(scanId)) return prev.filter((x) => x !== scanId);
      if (prev.length >= 2) return [prev[1], scanId];
      return [...prev, scanId];
    });
  };

  const compareSelected = () => {
    if (selected.length !== 2) return;
    const [aId, bId] = selected;
    const a = scans.find((s) => s.id === aId);
    const b = scans.find((s) => s.id === bId);
    if (!a || !b) return;
    const [older, newer] = a.scanned_at <= b.scanned_at ? [a, b] : [b, a];
    setCompareIds([older.id, newer.id]);
  };

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortKey(key); setSortDir(key === 'image_ref' ? 'asc' : 'desc'); }
  };

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...scans].sort((a, b) => {
      switch (sortKey) {
        case 'image_ref': return a.image_ref.localeCompare(b.image_ref) * dir;
        case 'severity': return (SEVERITY_RANK[a.highest_severity ?? 'UNKNOWN'] - SEVERITY_RANK[b.highest_severity ?? 'UNKNOWN']) * dir;
        case 'total': return (a.total_vulnerabilities - b.total_vulnerabilities) * dir;
        default: return (a.scanned_at - b.scanned_at) * dir;
      }
    });
  }, [scans, sortKey, sortDir]);

  return (
    <div className="space-y-4">
      <FleetTabHeading
        title="Scan history"
        subtitle="Completed scans across this node. Select two to compare."
        action={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={compareSelected} disabled={selected.length !== 2}>
              <GitCompare className="w-4 h-4 mr-1.5" strokeWidth={1.5} />
              Compare ({selected.length}/2)
            </Button>
            <Button variant="outline" size="sm" onClick={() => load(safePage, search)} disabled={loading}>
              <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} strokeWidth={1.5} />
            </Button>
          </div>
        }
      />

      <div className="relative max-w-sm">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" strokeWidth={1.5} />
        <Input
          placeholder="Search by image..."
          value={searchDraft}
          onChange={(e) => setSearchDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { setPage(0); setSearch(searchDraft); } }}
          className="pl-8"
        />
      </div>

      <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel overflow-hidden">
        <ScrollArea className="max-h-[60vh] bg-background">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[40px]" />
                <SortHead label="Image" k="image_ref" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortHead label="Last scanned" k="scanned_at" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <TableHead className="text-[11px]">Trigger</TableHead>
                <SortHead label="Severity" k="severity" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} />
                <SortHead label="Findings" k="total" sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} align="right" />
                <TableHead className="text-right text-[11px]">Fixable</TableHead>
                <TableHead className="text-right text-[11px]">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {!loading && !error && sorted.map((scan) => {
                const isSelected = selected.includes(scan.id);
                return (
                  <TableRow key={scan.id} className={cn('hover:bg-muted/30 transition-colors', isSelected && 'bg-accent/30')}>
                    <TableCell>
                      <Checkbox checked={isSelected} onCheckedChange={() => toggleSelect(scan.id)} aria-label="Select scan to compare" />
                    </TableCell>
                    <TableCell className="font-mono text-xs truncate max-w-[280px]">{scan.image_ref}</TableCell>
                    <TableCell className="font-mono text-xs text-stat-subtitle whitespace-nowrap">{new Date(scan.scanned_at).toLocaleString()}</TableCell>
                    <TableCell className="font-mono text-xs capitalize text-stat-subtitle">{scan.triggered_by}</TableCell>
                    <TableCell>
                      {scan.highest_severity ? <SeverityChip severity={scan.highest_severity} /> : <span className="text-xs text-success font-mono">none</span>}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums">{scan.total_vulnerabilities}</TableCell>
                    <TableCell className="text-right font-mono text-xs tabular-nums text-success">{scan.fixable_count}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => onInspect(scan.id, 'vulns')}>Open</Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {loading && <div className="py-12 text-center text-sm text-muted-foreground">Loading scan history...</div>}
          {!loading && error && <div className="py-12 text-center text-sm text-muted-foreground">Couldn't load scan history. Try again.</div>}
          {!loading && !error && sorted.length === 0 && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              {search ? 'No scans match your search.' : 'No completed scans yet. Scan an image from the Images tab.'}
            </div>
          )}
        </ScrollArea>
      </div>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPage(Math.max(0, safePage - 1))} disabled={safePage === 0}>
            <ChevronLeft className="w-4 h-4" strokeWidth={1.5} />
          </Button>
          <span className="text-xs text-stat-subtitle tabular-nums px-1">{safePage + 1} / {totalPages}</span>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))} disabled={safePage >= totalPages - 1}>
            <ChevronRight className="w-4 h-4" strokeWidth={1.5} />
          </Button>
        </div>
      )}

      <ScanComparisonSheet
        baselineScanId={compareIds?.[0] ?? null}
        currentScanId={compareIds?.[1] ?? null}
        onClose={() => setCompareIds(null)}
      />
    </div>
  );
}
