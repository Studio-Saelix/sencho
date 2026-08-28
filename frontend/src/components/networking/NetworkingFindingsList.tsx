import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { useAuth } from '@/context/AuthContext';
import { isNetworkingActionVisible } from '@/lib/networking';
import {
  FINDING_GROUP_LABELS, findingSourceLabel, groupFindings, SEVERITY_TEXT_CLASS, type NetworkingFindingGroup,
} from '@/lib/networkingSeverity';
import type { NetworkingFinding, NetworkingRecommendedAction } from '@/types/networking';

const GROUP_ORDER: NetworkingFindingGroup[] = ['needs-action', 'review-recommended', 'informational'];

const GROUP_CLASS: Record<NetworkingFindingGroup, string> = {
  'needs-action': 'text-destructive',
  'review-recommended': 'text-warning',
  informational: 'text-stat-subtitle',
};

export function NetworkingFindingsList({
  findings,
  loading,
  canEdit,
  isAdmin,
  onAction,
  disabled = false,
  nodeId,
}: {
  findings: NetworkingFinding[];
  loading: boolean;
  canEdit: ReturnType<typeof useAuth>['can'];
  isAdmin: boolean;
  onAction: (action: NetworkingRecommendedAction) => void | Promise<void>;
  disabled?: boolean;
  nodeId: number | null | undefined;
}) {
  if (loading) return <p className="text-sm text-muted-foreground">Loading findings…</p>;
  if (findings.length === 0) {
    return <p className="text-sm text-muted-foreground">No networking issues detected.</p>;
  }

  const groups = groupFindings(findings);

  return (
    <div className="space-y-6">
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
                      {!disabled && <TableHead className="w-44 text-right text-[11px]">Action</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {items.map((finding, i) => {
                      const sourceLabel = findingSourceLabel(finding);
                      const primary = finding.recommendedActions.find((action) =>
                        isNetworkingActionVisible(action, isAdmin, (stack) => canEdit('stack:edit', 'stack', stack, nodeId)),
                      );
                      return (
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
                            <p className="text-sm font-medium text-stat-value">{finding.title}</p>
                            <p className="text-xs text-stat-subtitle">{finding.message}</p>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-stat-subtitle">{finding.stack ?? ''}</TableCell>
                          <TableCell className="font-mono text-xs text-stat-subtitle">{finding.service ?? ''}</TableCell>
                          <TableCell className="font-mono text-xs text-stat-subtitle">{finding.network ?? ''}</TableCell>
                          <TableCell className="font-mono text-[10px] uppercase tracking-wide text-stat-subtitle/80">
                            {sourceLabel ?? ''}
                          </TableCell>
                          {!disabled && (
                            <TableCell className="text-right">
                              {primary && (
                                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => void onAction(primary)}>
                                  {primary.label}
                                </Button>
                              )}
                            </TableCell>
                          )}
                        </TableRow>
                      );
                    })}
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
