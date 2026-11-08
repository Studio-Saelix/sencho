import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { DismissedCountButton } from '@/components/ui/dismissed-sheet';
import type { DismissedNetworkingFinding } from '@/lib/networkingDismissals';
import {
  FINDING_GROUP_LABELS, findingSourceLabel, groupFindings, SEVERITY_TEXT_CLASS, type NetworkingFindingGroup,
} from '@/lib/networkingSeverity';
import type { NetworkingFinding } from '@/types/networking';
import { NetworkingFindingActions, type NetworkingFindingControls } from './NetworkingFindingActions';
import { NetworkingFindingText } from './NetworkingFindingText';

const GROUP_ORDER: NetworkingFindingGroup[] = ['needs-action', 'review-recommended', 'informational'];

const GROUP_CLASS: Record<NetworkingFindingGroup, string> = {
  'needs-action': 'text-destructive',
  'review-recommended': 'text-warning',
  informational: 'text-stat-subtitle',
};

/** The findings set aside, and the single way to bring one back. */
export interface NetworkingDismissedList {
  items: DismissedNetworkingFinding[];
  now: number;
  /** False for an item the account may not restore; its Restore action is then not offered. */
  canRestore: (item: DismissedNetworkingFinding) => boolean;
  onRestore: (item: DismissedNetworkingFinding) => void;
  isRestoring: (item: DismissedNetworkingFinding) => boolean;
}

export function NetworkingFindingsList({
  findings,
  dismissed,
  onOpenDismissed,
  loading,
  controls,
  disabled = false,
}: {
  findings: NetworkingFinding[];
  dismissed?: NetworkingDismissedList;
  /** Opens the dismissed sheet; the dismissed count in this tab is the control that reaches it. */
  onOpenDismissed: () => void;
  loading: boolean;
  controls: NetworkingFindingControls;
  disabled?: boolean;
}) {
  if (loading) return <p className="text-sm text-muted-foreground">Loading findings…</p>;
  const dismissedCount = dismissed?.items.length ?? 0;
  const dismissedCountRow = dismissedCount > 0 && (
    <p className="font-mono text-[11px] text-stat-subtitle">
      <DismissedCountButton count={dismissedCount} onClick={onOpenDismissed} />
    </p>
  );
  if (findings.length === 0) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {dismissedCount > 0 ? 'Nothing needs attention right now.' : 'No networking issues detected.'}
        </p>
        {dismissedCountRow}
      </div>
    );
  }

  const groups = groupFindings(findings);

  return (
    <div className="space-y-6">
      {dismissedCountRow}
      {GROUP_ORDER.map((group) => {
        const items = groups[group];
        if (!items.length) return null;
        return (
          <section key={group}>
            <p className={`mb-2 font-mono text-[10px] uppercase tracking-[0.18em] ${GROUP_CLASS[group]}`}>
              {FINDING_GROUP_LABELS[group]} · {items.length}
            </p>
            <div className="rounded-lg border border-card-border border-t-card-border-top bg-card shadow-card-bevel overflow-hidden">
              <ScrollArea className="h-[62vh] max-md:h-auto">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="w-20 text-[11px]">Severity</TableHead>
                      <TableHead className="text-[11px]">Finding</TableHead>
                      <TableHead className="w-32 text-[11px]">Stack</TableHead>
                      <TableHead className="w-32 text-[11px]">Service</TableHead>
                      <TableHead className="w-32 text-[11px]">Network</TableHead>
                      <TableHead className="w-40 text-[11px]">Source</TableHead>
                      {!disabled && <TableHead className="w-64 text-right text-[11px]">Action</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((finding, i) => (
                      <TableRow
                        key={finding.id}
                        className="animate-in fade-in-0 duration-200 hover:bg-muted/30 transition-colors"
                        style={{ animationDelay: `${Math.min(i * 20, 200)}ms` }}
                      >
                        <TableCell>
                          <span className={`font-mono text-[10px] uppercase tracking-wide ${SEVERITY_TEXT_CLASS[finding.severity]}`}>
                            {finding.severity}
                          </span>
                        </TableCell>
                        <TableCell>
                          <NetworkingFindingText finding={finding} />
                        </TableCell>
                        <TableCell className="font-mono text-xs text-stat-subtitle">{finding.stack ?? ''}</TableCell>
                        <TableCell className="font-mono text-xs text-stat-subtitle">{finding.service ?? ''}</TableCell>
                        <TableCell className="font-mono text-xs text-stat-subtitle">{finding.network ?? ''}</TableCell>
                        <TableCell className="font-mono text-[10px] uppercase tracking-wide text-stat-subtitle/80">
                          {findingSourceLabel(finding) ?? ''}
                        </TableCell>
                        {!disabled && (
                          <TableCell className="text-right">
                            <NetworkingFindingActions finding={finding} controls={controls} />
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </ScrollArea>
            </div>
          </section>
        );
      })}
    </div>
  );
}
