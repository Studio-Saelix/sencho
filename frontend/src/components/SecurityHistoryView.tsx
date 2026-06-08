import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SystemSheet, SheetSection } from '@/components/ui/system-sheet';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  ChevronLeft,
  ChevronRight,
  GitCompare,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';
import { ScanComparisonSheet } from './ScanComparisonSheet';
import { SeverityChip } from './VulnerabilityScanSheet';
import { VulnerabilityScanSheet } from './VulnerabilityScanSheet';
import { CapabilityGate } from './CapabilityGate';
import { useLicense } from '@/context/LicenseContext';
import { useAuth } from '@/context/AuthContext';
import { useNodes } from '@/context/NodeContext';
import type { VulnerabilityScan } from '@/types/security';

const PAGE_SIZE = 100;

interface GroupedScans {
  image_ref: string;
  scans: VulnerabilityScan[];
}

function groupByImage(scans: VulnerabilityScan[]): GroupedScans[] {
  const map = new Map<string, VulnerabilityScan[]>();
  for (const s of scans) {
    const list = map.get(s.image_ref) ?? [];
    list.push(s);
    map.set(s.image_ref, list);
  }
  const groups: GroupedScans[] = [];
  for (const [image_ref, list] of map.entries()) {
    list.sort((a, b) => b.scanned_at - a.scanned_at);
    groups.push({ image_ref, scans: list });
  }
  groups.sort((a, b) => (b.scans[0]?.scanned_at ?? 0) - (a.scans[0]?.scanned_at ?? 0));
  return groups;
}

interface SecurityHistoryViewProps {
  open: boolean;
  onClose: () => void;
}

export function SecurityHistoryView({ open, onClose }: SecurityHistoryViewProps) {
  const { isPaid } = useLicense();
  const { isAdmin } = useAuth();
  const { activeNode, hasCapability } = useNodes();
  const scanningAvailable = hasCapability('vulnerability-scanning');
  const [scans, setScans] = useState<VulnerabilityScan[]>([]);
  const [total, setTotal] = useState(0);
  const [capInfo, setCapInfo] = useState<{ perImageLimit: number; refs: Set<string> } | null>(null);
  const [loading, setLoading] = useState(false);
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [compareIds, setCompareIds] = useState<[number, number] | null>(null);
  const [inspectScanId, setInspectScanId] = useState<number | null>(null);
  const [page, setPage] = useState(0);

  const load = useCallback(async (pageToLoad: number, searchTerm: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        status: 'completed',
        limit: String(PAGE_SIZE),
        offset: String(pageToLoad * PAGE_SIZE),
      });
      if (searchTerm.trim()) params.set('imageRefLike', searchTerm.trim());
      const res = await apiFetch(`/security/scans?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to load scans');
      const body = await res.json();
      const items: VulnerabilityScan[] = Array.isArray(body?.items) ? body.items : [];
      setScans(items);
      setTotal(typeof body?.total === 'number' ? body.total : items.length);
      const limit = typeof body?.perImageLimit === 'number' ? body.perImageLimit : 0;
      const refs: string[] = Array.isArray(body?.cappedImageRefs) ? body.cappedImageRefs : [];
      setCapInfo(limit > 0 ? { perImageLimit: limit, refs: new Set(refs) } : null);
    } catch (err) {
      toast.error((err as Error)?.message || 'Could not load scan history');
    } finally {
      setLoading(false);
    }
  }, []);

  const lastNodeIdRef = useRef<number | null>(activeNode?.id ?? null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const id = activeNode?.id ?? null;
    if (lastNodeIdRef.current === id) return;
    lastNodeIdRef.current = id;
    setSelected([]);
    setPage(0);
    setReloadToken((t) => t + 1);
  }, [activeNode?.id]);

  useEffect(() => {
    if (!open || !scanningAvailable) return;
    load(page, search);
    // reloadToken bumps when the active node changes even if page/search
    // happen to match the previous values, so the fetch re-runs exactly once.
  }, [open, scanningAvailable, load, page, search, reloadToken]);

  // Skip the initial mount: the effect fires once with the original
  // searchDraft, and unconditionally resetting page to 0 after 300ms races
  // with any pagination the user may have done in that window.
  const prevSearchDraftRef = useRef(searchDraft);
  useEffect(() => {
    if (prevSearchDraftRef.current === searchDraft) return;
    prevSearchDraftRef.current = searchDraft;
    const t = setTimeout(() => {
      setSearch(searchDraft);
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchDraft]);

  const groups = useMemo(() => groupByImage(scans), [scans]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const needsPagination = total > PAGE_SIZE;

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

  const compareDisabled = selected.length !== 2;
  const meta = `${total} scan${total === 1 ? '' : 's'} · ${groups.length} image${groups.length === 1 ? '' : 's'}`;
  const footerContext = `Node ${activeNode?.name ?? '—'}`;

  return (
    <SystemSheet
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      crumb={['Security', 'Scan history']}
      name="Scan history"
      meta={meta}
      primaryAction={scanningAvailable ? {
        label: `Compare (${selected.length}/2)`,
        icon: GitCompare,
        onClick: compareSelected,
        disabled: compareDisabled,
      } : undefined}
      secondaryActions={scanningAvailable ? [{
        label: 'Refresh',
        icon: RefreshCw,
        onClick: () => load(safePage, search),
        disabled: loading,
      }] : []}
      footerContext={footerContext}
      size="xl"
    >
      <CapabilityGate capability="vulnerability-scanning" featureName="Vulnerability scanning">
      <SheetSection title="Scans" hideHeader>
        <div className="flex items-center gap-3 mb-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" strokeWidth={1.5} />
            <Input
              placeholder="Search by image..."
              value={searchDraft}
              onChange={(e) => setSearchDraft(e.target.value)}
              className="pl-8"
            />
          </div>
          {needsPagination && (
            <div className="flex items-center gap-1 ml-auto" aria-live="polite">
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setPage(Math.max(0, safePage - 1))}
                disabled={safePage === 0}
                aria-label="Previous page"
              >
                <ChevronLeft className="w-4 h-4" strokeWidth={1.5} />
              </Button>
              <span
                className="text-xs font-mono tabular-nums text-stat-subtitle min-w-[3rem] text-center"
                aria-label={`Page ${safePage + 1} of ${totalPages}`}
              >
                {safePage + 1} / {totalPages}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setPage(Math.min(totalPages - 1, safePage + 1))}
                disabled={safePage >= totalPages - 1}
                aria-label="Next page"
              >
                <ChevronRight className="w-4 h-4" strokeWidth={1.5} />
              </Button>
            </div>
          )}
        </div>

        {groups.length === 0 && !loading ? (
          <div className="flex flex-col items-center justify-center text-center py-16 gap-2">
            <ShieldCheck className="w-8 h-8 text-muted-foreground" strokeWidth={1.5} />
            <div className="text-sm text-muted-foreground">
              {search
                ? 'No completed scans match your search.'
                : 'No scans have completed on this node yet.'}
            </div>
          </div>
        ) : (
          <ScrollArea block className="max-h-[60vh]">
            <div className="space-y-5">
              {groups.map((group) => {
                const isCapped = capInfo?.refs.has(group.image_ref) ?? false;
                return (
                  <div key={group.image_ref}>
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className="font-mono text-sm truncate" title={group.image_ref}>
                        {group.image_ref}
                      </span>
                      <span className="text-xs text-stat-subtitle">
                        {group.scans.length} scan{group.scans.length === 1 ? '' : 's'}
                      </span>
                      {isCapped && capInfo && (
                        <span className="text-xs text-stat-subtitle italic">
                          Capped at {capInfo.perImageLimit} · older scans pruned
                        </span>
                      )}
                    </div>
                    <ScrollArea block className="max-h-64 border border-border/40 rounded-sm">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="w-[40px]" />
                            <TableHead className="w-[180px]">Scanned</TableHead>
                            <TableHead className="w-[120px]">Trigger</TableHead>
                            <TableHead className="w-[120px]">Highest</TableHead>
                            <TableHead className="w-[90px] text-right">Total</TableHead>
                            <TableHead className="w-[90px] text-right">Fixable</TableHead>
                            <TableHead />
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {group.scans.map((scan) => {
                            const isSelected = selected.includes(scan.id);
                            return (
                              <TableRow
                                key={scan.id}
                                className={cn(isSelected && 'bg-accent/30')}
                              >
                                <TableCell>
                                  <Checkbox
                                    checked={isSelected}
                                    onCheckedChange={() => toggleSelect(scan.id)}
                                    aria-label={`Select scan ${scan.id}`}
                                  />
                                </TableCell>
                                <TableCell className="font-mono text-xs">
                                  {new Date(scan.scanned_at).toLocaleString()}
                                </TableCell>
                                <TableCell className="font-mono text-xs capitalize">
                                  {scan.triggered_by}
                                </TableCell>
                                <TableCell>
                                  {scan.highest_severity ? (
                                    <SeverityChip severity={scan.highest_severity} />
                                  ) : (
                                    <span className="text-xs text-success font-mono">none</span>
                                  )}
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs tabular-nums">
                                  {scan.total_vulnerabilities}
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs tabular-nums text-success">
                                  {scan.fixable_count}
                                </TableCell>
                                <TableCell className="text-right">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 text-xs"
                                    onClick={() => setInspectScanId(scan.id)}
                                  >
                                    Open
                                  </Button>
                                </TableCell>
                              </TableRow>
                            );
                          })}
                        </TableBody>
                      </Table>
                    </ScrollArea>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </SheetSection>
      </CapabilityGate>

      <ScanComparisonSheet
        baselineScanId={compareIds?.[0] ?? null}
        currentScanId={compareIds?.[1] ?? null}
        onClose={() => setCompareIds(null)}
      />

      <VulnerabilityScanSheet
        scanId={inspectScanId}
        onClose={() => setInspectScanId(null)}
        canGenerateSbom={isAdmin}
        canExportSarif={isPaid && isAdmin}
        canCompare={false}
        canManageSuppressions={isAdmin}
      />
    </SystemSheet>
  );
}
