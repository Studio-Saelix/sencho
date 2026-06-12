import { useMemo } from 'react';
import { Boxes, AlertTriangle } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { SeverityBadge } from '@/components/ui/SeverityBadge';
import type { ScanSummary, ScanDetailTab } from '@/types/security';

interface ImagesTabProps {
  summaries: Record<string, ScanSummary>;
  loading: boolean;
  /** True when the summaries fetch failed; render an error state, never a false "clean". */
  error?: boolean;
  onInspect: (scanId: number, initialTab?: ScanDetailTab) => void;
}

/** Latest-scan index for real images (stack/config scans live in Compose risks). */
export function ImagesTab({ summaries, loading, error, onInspect }: ImagesTabProps) {
  const images = useMemo(
    () =>
      Object.values(summaries)
        .filter((s) => !s.image_ref.startsWith('stack:'))
        .sort((a, b) => b.scanned_at - a.scanned_at),
    [summaries],
  );

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

  if (images.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <Boxes className="w-12 h-12 text-muted-foreground/50 mb-4" strokeWidth={1.5} />
        <h3 className="text-lg font-medium mb-1">No scanned images</h3>
        <p className="text-sm text-muted-foreground">Scan an image from Resources to see its findings here.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-card-border">
            <th className="text-left font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle px-4 py-2">Image</th>
            <th className="text-left font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle px-4 py-2 max-md:hidden">Findings</th>
            <th className="text-right font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle px-4 py-2">Severity</th>
          </tr>
        </thead>
        <tbody>
          {images.map((s) => (
            <tr key={s.image_ref} className="border-b border-card-border/40 last:border-0 hover:bg-glass-highlight">
              <td className="px-4 py-2.5 font-mono text-xs truncate max-w-0 w-full">
                <button type="button" className="hover:text-brand truncate block w-full text-left" onClick={() => onInspect(s.scan_id, 'vulns')}>
                  {s.image_ref}
                </button>
              </td>
              <td className="px-4 py-2.5 font-mono tabular-nums text-xs text-stat-subtitle max-md:hidden">
                {s.critical > 0 && <span className="text-destructive mr-2">{s.critical}C</span>}
                {s.high > 0 && <span className="text-warning mr-2">{s.high}H</span>}
                {s.fixable > 0 && <span className="text-stat-subtitle">{s.fixable} fixable</span>}
                {s.total === 0 && <span className="text-success">clean</span>}
              </td>
              <td className="px-4 py-2.5 text-right">
                <SeverityBadge summary={s} onClick={() => onInspect(s.scan_id, 'vulns')} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
