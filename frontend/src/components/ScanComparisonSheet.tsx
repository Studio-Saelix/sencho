import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SystemSheet, SheetSection } from '@/components/ui/system-sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusPath } from '@/components/ui/status-path';
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
  MinusCircle,
  PlusCircle,
  ShieldCheck,
  ShieldOff,
  Equal,
} from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';
import { cveUrl } from '@/lib/cveUrl';
import { formatShortDigest } from '@/lib/formatDigest';
import { SEVERITY_ROW_TINT } from '@/lib/severityStyles';
import type { StatusTone } from '@/lib/statusTone';
import { useVisualBusy } from '@/hooks/useVisualBusy';
import { SeverityChip } from './VulnerabilityScanSheet';
import type {
  ScanCompareResult,
  ScanCompareSide,
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

function trimmedDigest(scan: ScanCompareSide): string | null {
  const digest = scan.image_digest?.trim();
  return digest || null;
}

function scanCompareLabel(scan: ScanCompareSide): string {
  const digest = trimmedDigest(scan);
  if (digest) return `${formatShortDigest(digest)} · ${scan.image_ref}`;
  return scan.image_ref;
}

function isCrossIdentity(a: ScanCompareSide, b: ScanCompareSide): boolean {
  const aDigest = trimmedDigest(a);
  const bDigest = trimmedDigest(b);
  if (aDigest && bDigest) return aDigest !== bDigest;
  return a.image_ref !== b.image_ref;
}

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

const SUMMARY_SEVERITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'] as const;

type DeltaSummary = {
  tone: StatusTone;
  title: 'Regressed' | 'Improved' | 'Fewer findings' | 'Mixed' | 'No net change';
  line: string;
};

/**
 * The one Answer for the diff. It compares counts per severity, not CVE
 * identity, and never states a verdict the counts do not support:
 * - A net-new CRITICAL is the only destructive reading; any other net increase
 *   warns; only decreases read as an improvement.
 * - A new CRITICAL or HIGH whose net is hidden by an offsetting resolved one is
 *   named in the sentence, and an improvement that carries one reads as mixed.
 * - When the nets cancel but findings still came and went, it says how many
 *   instead of claiming nothing changed.
 * - A result cut off at the row limit cannot be called an improvement or
 *   unchanged: a row missing from one scan but present in the other would
 *   show up as a resolved finding, so it reads "Fewer findings" in a neutral
 *   tone and names the limit when it reports no change.
 */
function summarizeDelta(
  added: Record<VulnSeverity, number>,
  removed: Record<VulnSeverity, number>,
  rowLimit: number | null,
): DeltaSummary {
  const parts: string[] = [];
  let anyUp = false;
  let anyDown = false;
  for (const sev of SUMMARY_SEVERITIES) {
    const net = added[sev] - removed[sev];
    if (net === 0) continue;
    if (net > 0) anyUp = true;
    else anyDown = true;
    parts.push(`${net > 0 ? '+' : ''}${net} ${sev.toLowerCase()}`);
  }
  const hidden: string[] = [];
  if (added.CRITICAL > 0 && added.CRITICAL - removed.CRITICAL <= 0) hidden.push(`${added.CRITICAL} new critical`);
  if (added.HIGH > 0 && added.HIGH - removed.HIGH <= 0) hidden.push(`${added.HIGH} new high`);
  const hiddenNote = hidden.length > 0 ? ` ${hidden.join(', ')}.` : '';
  const net = `Net change: ${parts.join(', ')}.${hiddenNote}`;
  const addedTotal = Object.values(added).reduce((total, n) => total + n, 0);
  const removedTotal = Object.values(removed).reduce((total, n) => total + n, 0);

  if (added.CRITICAL - removed.CRITICAL > 0) return { tone: 'destructive', title: 'Regressed', line: net };
  if (anyUp) return { tone: 'warning', title: 'Regressed', line: net };
  if (anyDown && hidden.length > 0) return { tone: 'warning', title: 'Mixed', line: net };
  if (anyDown) {
    return rowLimit === null
      ? { tone: 'success', title: 'Improved', line: net }
      : { tone: 'neutral', title: 'Fewer findings', line: net };
  }
  if (addedTotal + removedTotal > 0) {
    return {
      tone: hidden.length > 0 ? 'warning' : 'neutral',
      title: 'No net change',
      line: `${addedTotal} added, ${removedTotal} removed.${hiddenNote}`,
    };
  }
  return {
    tone: 'neutral',
    title: 'No net change',
    line: rowLimit === null ? 'No findings changed.' : `No change in the first ${rowLimit} findings.`,
  };
}

/** Holds roughly the loaded layout (the Answer, the scans, the filters and some rows) so the sheet does not jump when data arrives. */
function ComparisonSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading comparison" data-testid="scan-diff-skeleton" className="flex flex-col gap-4">
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-7 w-72" />
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    </div>
  );
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
  // Parents commonly pass an inline arrow; keeping it in a ref stops each parent
  // render from re-running the fetch and blanking the sheet.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });

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
      onCloseRef.current();
    } finally {
      setLoading(false);
    }
  }, [baselineScanId, currentScanId]);

  useEffect(() => {
    if (baselineScanId != null && currentScanId != null) load();
  }, [baselineScanId, currentScanId, load]);

  const open = baselineScanId != null && currentScanId != null;
  const { showBusy } = useVisualBusy(loading);

  const addedCounts = useMemo(() => (data ? countBySeverity(data.added) : null), [data]);
  const removedCounts = useMemo(() => (data ? countBySeverity(data.removed) : null), [data]);

  const crossImage = data != null && isCrossIdentity(data.scanA, data.scanB);

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

  const meta = data ? `#${data.scanA.id} → #${data.scanB.id}` : (loading ? 'Loading…' : '');

  const summary = addedCounts && removedCounts
    ? summarizeDelta(addedCounts, removedCounts, data?.truncated ? (data.row_limit ?? 1000) : null)
    : null;

  return (
    <SystemSheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      crumb={['Security', 'Scans', 'Compare']}
      name="Diff"
      meta={meta}
      size="xl"
    >
      {loading && showBusy && <ComparisonSkeleton />}

      {data && !loading && summary && (
        <>
          <SheetSection title="Change" hideHeader>
            {/* A cut-off comparison was announced as an alert before; keep that for the one state that can mislead. */}
            <div role={data.truncated ? 'alert' : undefined}>
              <StatusPath
                answer={{
                  tone: summary.tone,
                  title: summary.title,
                  line: summary.line,
                  detail: crossImage
                    ? 'You are comparing scans from two different image identities. Package-level changes may reflect image differences rather than CVE drift.'
                    : null,
                  marker: data.truncated
                    ? `partial · first ${data.row_limit ?? 1000} findings per scan, so this may be incomplete`
                    : undefined,
                }}
                stages={[]}
              />
            </div>
          </SheetSection>

          <SheetSection title="Scans">
            <div className="flex items-center gap-3 text-xs font-mono tabular-nums">
              <div className="flex-1 min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Baseline</div>
                <div className="text-stat-value truncate">{scanCompareLabel(data.scanA)}</div>
                <div className="text-stat-subtitle tabular-nums">{new Date(data.scanA.scanned_at).toLocaleString()}</div>
              </div>
              <ArrowRight className="w-4 h-4 text-muted-foreground shrink-0" strokeWidth={1.5} />
              <div className="flex-1 min-w-0">
                <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Current</div>
                <div className="text-stat-value truncate">{scanCompareLabel(data.scanB)}</div>
                <div className="text-stat-subtitle tabular-nums">{new Date(data.scanB.scanned_at).toLocaleString()}</div>
              </div>
            </div>
          </SheetSection>

          <SheetSection title="Findings">
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

            <ScrollArea block className="h-[60vh] max-md:h-auto">
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
