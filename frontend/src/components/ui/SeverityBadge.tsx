import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { CursorProvider, CursorContainer, Cursor, CursorFollow } from '@/components/animate-ui/primitives/animate/cursor';
import { SEVERITY_BADGE_CLASSES, SEVERITY_DOT_CLASSES } from '@/lib/severityStyles';
import type { ScanSummary, VulnSeverity } from '@/types/security';

/**
 * Severity pill for a scanned image's latest summary. Shows the highest
 * severity (or "Clean") with a state dot and a cursor-follow tooltip carrying
 * the last-scanned time and a severity breakdown. Shared by the Resources view
 * and the Security page so the badge stays identical everywhere.
 */
export function SeverityBadge({ summary, onClick }: { summary: ScanSummary; onClick: () => void }) {
    // highest_severity is derived from vulnerabilities only, so a scan with
    // secrets or misconfigurations but zero CVEs would otherwise read "Clean".
    // Treat those as a non-clean "Findings" state.
    const hasNonVulnFindings = (summary.secret_count ?? 0) > 0 || (summary.misconfig_count ?? 0) > 0;
    const key: VulnSeverity | 'CLEAN' | 'FINDINGS' =
        summary.highest_severity ?? (hasNonVulnFindings ? 'FINDINGS' : 'CLEAN');
    const label = key === 'CLEAN' ? 'Clean' : key === 'FINDINGS' ? 'Findings' : key;
    const [relative, setRelative] = useState<string>('');
    useEffect(() => {
        const compute = () => {
            const scanAge = Math.round((Date.now() - summary.scanned_at) / 60000);
            setRelative(
                scanAge < 1 ? 'just now'
                    : scanAge < 60 ? `${scanAge}m ago`
                    : scanAge < 1440 ? `${Math.round(scanAge / 60)}h ago`
                    : `${Math.round(scanAge / 1440)}d ago`,
            );
        };
        compute();
        const id = setInterval(compute, 60000);
        return () => clearInterval(id);
    }, [summary.scanned_at]);

    return (
        <CursorProvider>
            <CursorContainer className="inline-flex">
                <button
                    type="button"
                    onClick={onClick}
                    className={cn(
                        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-medium cursor-pointer hover:brightness-110 transition',
                        SEVERITY_BADGE_CLASSES[key],
                    )}
                >
                    <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', SEVERITY_DOT_CLASSES[key])} />
                    {label}
                </button>
            </CursorContainer>
            <Cursor>
                <div className="h-2 w-2 rounded-full bg-brand" />
            </Cursor>
            <CursorFollow side="bottom" align="end" sideOffset={8}>
                <div className="bg-popover/95 backdrop-blur-[10px] backdrop-saturate-[1.15] border border-card-border shadow-md rounded-md px-3 py-2">
                    <div className="font-mono tabular-nums text-xs space-y-1">
                        <div className="text-stat-subtitle uppercase tracking-wide">Last scanned</div>
                        <div className="text-stat-value">{relative}</div>
                        {summary.total > 0 && (
                            <div className="flex gap-3 mt-1">
                                {summary.critical > 0 && <span className="text-destructive">{summary.critical}C</span>}
                                {summary.high > 0 && <span className="text-warning">{summary.high}H</span>}
                                {summary.medium > 0 && <span className="text-warning">{summary.medium}M</span>}
                                {summary.low > 0 && <span className="text-muted-foreground">{summary.low}L</span>}
                            </div>
                        )}
                        {summary.total === 0 && hasNonVulnFindings && (
                            <div className="flex gap-3 mt-1 text-warning">
                                {(summary.secret_count ?? 0) > 0 && <span>{summary.secret_count} secret</span>}
                                {(summary.misconfig_count ?? 0) > 0 && <span>{summary.misconfig_count} misconfig</span>}
                            </div>
                        )}
                        {summary.total === 0 && !hasNonVulnFindings && (
                            <div className="text-success">No findings</div>
                        )}
                    </div>
                </div>
            </CursorFollow>
        </CursorProvider>
    );
}
