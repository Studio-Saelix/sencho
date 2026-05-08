import { useCallback, useEffect, useMemo, useState } from 'react';
import { SystemSheet, SheetSection } from '@/components/ui/system-sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Loader2,
  MinusCircle,
  PlusCircle,
  ShieldCheck,
  ShieldOff,
  Equal,
  AlertTriangle,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';
import { cveUrl } from '@/lib/cveUrl';
import { SEVERITY_ROW_TINT } from '@/lib/severityStyles';
import { SeverityChip } from './VulnerabilityScanSheet';
import type {
  ScanCompareResult,
  ScanCompareVulnerability,
  VulnSeverity,
} from '@/types/security';

interface ScanComparisonSheetProps {
  baselineScanId: number | null;
  currentScanId: number | null;
  onClose: () => void;
}

type DiffFilter = 'added' | 'removed' | 'unchanged';

const PAGE_SIZE = 25;

const SEVERITY_ORDER: Record<VulnSeverity, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3,
  UNKNOWN: 4,
};

function sortBySeverity<T extends { severity: VulnSeverity }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}

function countBySeverity(rows: Array<{ severity: VulnSeverity }>): Record<VulnSeverity, number> {
  const counts: Record<VulnSeverity, number> = {
    CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0,
  };
  for (const r of rows) counts[r.severity] += 1;
  return counts;
}

type DeltaTone = 'success' | 'warning' | 'destructive' | 'muted';

const DELTA_TONE_CLASS: Record<DeltaTone, string> = {
  destructive: 'text-destructive border-destructive/40 bg-destructive/10',
  warning: 'text-warning border-warning/40 bg-warning/10',
  success: 'text-success border-success/40 bg-success/10',
  muted: 'text-muted-foreground border-border bg-muted/30',
};

function formatDelta(
  severity: VulnSeverity,
  added: number,
  removed: number,
): { text: string; tone: DeltaTone } {
  const net = added - removed;
  if (net > 0) {
    const tone: DeltaTone = severity === 'CRITICAL' ? 'destructive' : 'warning';
    return { text: `+${net}`, tone };
  }
  if (net < 0) return { text: `${net}`, tone: 'success' };
  return { text: '0', tone: 'muted' };
}

export function ScanComparisonSheet({
  baselineScanId,
  currentScanId,
  onClose,
}: ScanComparisonSheetProps) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<ScanCompareResult | null>(null);
  const [filter, setFilter] = useState<DiffFilter>('added');
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    if (baselineScanId == null || currentScanId == null) return;
    setLoading(true);
    setData(null);
    setPage(0);
    setFilter('added');
    try {
      const res = await apiFetch(
        `/security/compare?scanId1=${baselineScanId}&scanId2=${currentScanId}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error || 'Failed to load comparison');
      }
      const body = (await res.json()) as ScanCompareResult;
      setData(body);
    } catch (err) {
      toast.error((err as Error)?.message || 'Failed to load comparison');
      onClose();
    } finally {
      setLoading(false);
    }
  }, [baselineScanId, currentScanId, onClose]);

  useEffect(() => {
    if (baselineScanId != null && currentScanId != null) load();
  }, [baselineScanId, currentScanId, load]);

  const open = baselineScanId != null && currentScanId != null;

  const addedCounts = useMemo(() => (data ? countBySeverity(data.added) : null), [data]);
  const removedCounts = useMemo(() => (data ? countBySeverity(data.removed) : null), [data]);

  const crossImage = data != null && data.scanA.image_ref !== data.scanB.image_ref;

  const rows = useMemo<ScanCompareVulnerability[]>(() => {
    if (!data) return [];
    if (filter === 'added') return sortBySeverity(data.added);
    if (filter === 'removed') return sortBySeverity(data.removed);
    return sortBySeverity(data.unchanged as ScanCompareVulnerability[]);
  }, [data, filter]);

  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageItems = rows.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
  const needsPagination = rows.length > PAGE_SIZE;

  const meta = data
    ? `#${data.scanA.id} → #${data.scanB.id} · +${data.added.length} −${data.removed.length}`
    : (loading ? 'Loading…' : '');

  const footerContext = data
    ? `${data.scanA.image_ref} → ${data.scanB.image_ref}`
    : undefined;

  return (
    <SystemSheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      crumb={['Security', 'Scans', 'Compare']}
      name="Diff"
      meta={meta}
      footerContext={footerContext}
      size="xl"
    >
      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" strokeWidth={1.5} />
        </div>
      )}

      {data && !loading && (
        <>
          <SheetSection title="Scans">
            <div className="flex items-center gap-3 text-xs font-mono tabular-nums mb-3">
              <div className="flex-1 min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Baseline</div>
                <div className="text-stat-value truncate">{data.scanA.image_ref}</div>
                <div className="text-stat-subtitle tabular-nums">{new Date(data.scanA.scanned_at).toLocaleString()}</div>
              </div>
              <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" strokeWidth={1.5} />
              <div className="flex-1 min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Current</div>
                <div className="text-stat-value truncate">{data.scanB.image_ref}</div>
                <div className="text-stat-subtitle tabular-nums">{new Date(data.scanB.scanned_at).toLocaleString()}</div>
              </div>
            </div>

            {crossImage && (
              <div className="flex items-start gap-2 rounded border border-warning/40 bg-warning/10 px-3 py-2 mb-3 text-xs text-warning">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-[1px]" strokeWidth={1.5} />
                <span>
                  You are comparing scans from two different image references. Package-level changes may reflect image differences rather than CVE drift.
                </span>
              </div>
            )}

            {data.truncated && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded border border-warning/40 bg-warning/10 px-3 py-2 mb-3 text-xs text-warning"
              >
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-[1px]" strokeWidth={1.5} />
                <span>
                  Showing the first {data.row_limit ?? 1000} findings per scan. One or both scans exceed this limit, so the comparison may be incomplete.
                </span>
              </div>
            )}

            {addedCounts && removedCounts && (
              <div className="flex flex-wrap gap-2">
                {(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as VulnSeverity[]).map((sev) => {
                  const delta = formatDelta(sev, addedCounts[sev], removedCounts[sev]);
                  return (
                    <span
                      key={sev}
                      aria-label={`${sev} delta ${delta.text}`}
                      data-tone={delta.tone}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs font-mono tabular-nums shadow-card-bevel',
                        DELTA_TONE_CLASS[delta.tone],
                      )}
                    >
                      <span className="uppercase tracking-[0.18em] text-[10px]">{sev}</span>
                      <span>{delta.text}</span>
                    </span>
                  );
                })}
              </div>
            )}
          </SheetSection>

          <SheetSection title={`Findings · ${filter}`}>
            <div className="flex items-center gap-1 flex-wrap mb-3">
              <Button
                variant={filter === 'added' ? 'default' : 'ghost'}
                size="sm"
                className="h-7 text-xs px-2.5"
                onClick={() => { setFilter('added'); setPage(0); }}
              >
                <PlusCircle className="w-3 h-3 mr-1" strokeWidth={1.5} />
                Added ({data.added.length})
              </Button>
              <Button
                variant={filter === 'removed' ? 'default' : 'ghost'}
                size="sm"
                className="h-7 text-xs px-2.5"
                onClick={() => { setFilter('removed'); setPage(0); }}
              >
                <MinusCircle className="w-3 h-3 mr-1" strokeWidth={1.5} />
                Removed ({data.removed.length})
              </Button>
              <Button
                variant={filter === 'unchanged' ? 'default' : 'ghost'}
                size="sm"
                className="h-7 text-xs px-2.5"
                onClick={() => { setFilter('unchanged'); setPage(0); }}
                title={
                  crossImage
                    ? 'Same CVE and package name appear in both images. Because the images differ, this does not necessarily mean the finding is literally unchanged.'
                    : 'Findings present in both scans'
                }
              >
                <Equal className="w-3 h-3 mr-1" strokeWidth={1.5} />
                {crossImage ? 'Shared' : 'Unchanged'} ({data.unchanged.length})
              </Button>
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

            <ScrollArea block className="max-h-[60vh]">
              {pageItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-center py-16 gap-2">
                  <ShieldCheck className="w-8 h-8 text-success" strokeWidth={1.5} />
                  <div className="text-sm text-muted-foreground">
                    {filter === 'added' && 'No new findings. Nothing regressed between these scans.'}
                    {filter === 'removed' && 'No findings were resolved between these scans.'}
                    {filter === 'unchanged' && 'No findings are shared between the two scans.'}
                  </div>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[180px] text-[10px] uppercase tracking-[0.18em] font-mono text-stat-subtitle">CVE</TableHead>
                      <TableHead className="text-[10px] uppercase tracking-[0.18em] font-mono text-stat-subtitle">Package</TableHead>
                      <TableHead className="w-[100px] text-[10px] uppercase tracking-[0.18em] font-mono text-stat-subtitle">Severity</TableHead>
                      <TableHead className="w-[110px] text-[10px] uppercase tracking-[0.18em] font-mono text-stat-subtitle">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageItems.map((v, idx) => {
                      const href = cveUrl(v.vulnerability_id, v.primary_url);
                      const rowClass = cn(
                        SEVERITY_ROW_TINT[v.severity],
                        filter === 'unchanged' && 'opacity-75',
                        v.suppressed && 'opacity-60',
                      );
                      return (
                        <TableRow key={`${v.vulnerability_id}-${v.pkg_name}-${idx}`} className={rowClass}>
                          <TableCell className="font-mono text-xs tabular-nums">
                            <span className="inline-flex items-center gap-1.5">
                              {v.suppressed && (
                                <ShieldOff
                                  className="w-3 h-3 text-muted-foreground"
                                  strokeWidth={1.5}
                                  aria-label="Suppressed"
                                />
                              )}
                              {href ? (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                  className="hover:underline"
                                >
                                  {v.vulnerability_id}
                                </a>
                              ) : (
                                v.vulnerability_id
                              )}
                            </span>
                          </TableCell>
                          <TableCell className="font-mono text-xs truncate max-w-[180px]" title={v.pkg_name}>
                            {v.pkg_name}
                          </TableCell>
                          <TableCell>
                            <SeverityChip severity={v.severity} />
                          </TableCell>
                          <TableCell className="font-mono text-xs">
                            {filter === 'added' && (
                              <span className="inline-flex items-center gap-1 text-destructive">
                                <PlusCircle className="w-3 h-3" strokeWidth={1.5} />
                                Added
                              </span>
                            )}
                            {filter === 'removed' && (
                              <span className="inline-flex items-center gap-1 text-success">
                                <MinusCircle className="w-3 h-3" strokeWidth={1.5} />
                                Removed
                              </span>
                            )}
                            {filter === 'unchanged' && (
                              <span className="inline-flex items-center gap-1 text-muted-foreground">
                                <Equal className="w-3 h-3" strokeWidth={1.5} />
                                {crossImage ? 'Shared' : 'Unchanged'}
                              </span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}
            </ScrollArea>
          </SheetSection>
        </>
      )}
    </SystemSheet>
  );
}

export type { ScanComparisonSheetProps };
