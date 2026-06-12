import { useMemo } from 'react';
import { KeyRound, FileWarning, AlertTriangle } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { SeverityBadge } from '@/components/ui/SeverityBadge';
import type { ScanSummary, ScanDetailTab } from '@/types/security';

type FindingsKind = 'secret' | 'misconfig';

interface FindingsTabProps {
  kind: FindingsKind;
  summaries: Record<string, ScanSummary>;
  loading: boolean;
  /** True when the summaries fetch failed; render an error state, never a false "no findings". */
  error?: boolean;
  onInspect: (scanId: number, initialTab?: ScanDetailTab) => void;
}

const COPY: Record<FindingsKind, {
  icon: typeof KeyRound;
  detailTab: ScanDetailTab;
  countField: 'secret_count' | 'misconfig_count';
  emptyTitle: string;
  emptyBody: string;
  intro?: string;
}> = {
  secret: {
    icon: KeyRound,
    detailTab: 'secrets',
    countField: 'secret_count',
    emptyTitle: 'No secret findings',
    emptyBody: 'Trivy found no exposed credentials or keys in the scanned images on this node.',
  },
  misconfig: {
    icon: FileWarning,
    detailTab: 'misconfigs',
    countField: 'misconfig_count',
    emptyTitle: 'No Compose risks found',
    emptyBody: 'Scan a stack from Resources to surface misconfigurations like privileged containers, host mounts, or missing healthchecks.',
    intro: 'Compose risks are misconfigurations in your stack definitions, such as privileged containers, Docker socket mounts, host networking, broad bind mounts, or missing healthchecks. Open a result for the specific findings and how to fix them; the Policy packs tab explains each category.',
  },
};

/** Index of images/stacks that carry findings of the given kind. Rows open the
 *  existing scan sheet on the matching detail tab. */
export function FindingsTab({ kind, summaries, loading, error, onInspect }: FindingsTabProps) {
  const copy = COPY[kind];
  const Icon = copy.icon;
  const rows = useMemo(
    () =>
      Object.values(summaries)
        // Both kinds filter on the kind's count; misconfig additionally requires a
        // stack/config scan (image_ref `stack:<name>`).
        .filter((s) => s[copy.countField] > 0 && (kind !== 'misconfig' || s.image_ref.startsWith('stack:')))
        .sort((a, b) => b.scanned_at - a.scanned_at),
    [summaries, kind, copy.countField],
  );

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <AlertTriangle className="w-12 h-12 text-warning/60 mb-4" strokeWidth={1.5} />
        <h3 className="text-lg font-medium mb-1">Couldn't load scan results</h3>
        <p className="text-sm text-muted-foreground max-w-md">Scan results failed to load for this node. Try again shortly.</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-12 w-full rounded-lg" />
        <Skeleton className="h-12 w-full rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {copy.intro && <p className="text-sm text-muted-foreground max-w-2xl">{copy.intro}</p>}

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Icon className="w-12 h-12 text-muted-foreground/50 mb-4" strokeWidth={1.5} />
          <h3 className="text-lg font-medium mb-1">{copy.emptyTitle}</h3>
          <p className="text-sm text-muted-foreground max-w-md">{copy.emptyBody}</p>
        </div>
      ) : (
        <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-card-border">
                <th className="text-left font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle px-4 py-2">
                  {kind === 'misconfig' ? 'Stack' : 'Image'}
                </th>
                <th className="text-right font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle px-4 py-2">Findings</th>
                <th className="text-right font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle px-4 py-2 max-md:hidden">Severity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => {
                const label = kind === 'misconfig' ? s.image_ref.replace(/^stack:/, '') : s.image_ref;
                const count = s[copy.countField];
                return (
                  <tr key={s.image_ref} className="border-b border-card-border/40 last:border-0 hover:bg-glass-highlight">
                    <td className="px-4 py-2.5 font-mono text-xs truncate max-w-0 w-full">
                      <button type="button" className="hover:text-brand truncate block w-full text-left" onClick={() => onInspect(s.scan_id, copy.detailTab)}>
                        {label}
                      </button>
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono tabular-nums text-xs text-stat-value">{count}</td>
                    <td className="px-4 py-2.5 text-right max-md:hidden">
                      <SeverityBadge summary={s} onClick={() => onInspect(s.scan_id, copy.detailTab)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
