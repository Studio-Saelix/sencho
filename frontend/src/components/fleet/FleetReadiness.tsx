import { useCallback, useMemo, useRef, useState } from 'react';
import { RefreshCw, ServerOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SENCHO_OPEN_STACK_EVENT, type SenchoOpenStackDetail } from '@/lib/events';
import { SENCHO_NAVIGATE_EVENT, type SenchoNavigateDetail } from '@/components/NodeManager';
import { toSecurityTab } from '@/lib/router/senchoRoute';
import type { SecurityTab } from '@/lib/events';
import type { SectionId } from '@/components/settings/types';
import type { ReadinessDomainKey, ReadinessFinding, ReadinessTarget } from '@/types/readiness';
import { useVisualBusy } from '@/hooks/useVisualBusy';
import { FleetEmptyCard, FleetEmptyState } from './FleetEmptyState';
import { TARGET_ACTION } from './readinessMeta';
import type { FleetReadinessState } from './readiness/useFleetReadiness';
import { ReadinessSummaryStrip } from './readiness/ReadinessSummaryStrip';
import { ReadinessNodeMatrix } from './readiness/ReadinessNodeMatrix';
import { ReadinessFindingsTable } from './readiness/ReadinessFindingsTable';
import { ALL, EMPTY_FINDINGS_FILTER, type FindingsFilter } from './readiness/findingsFilter';
import { useNow } from './readiness/useNow';
import { useReadinessVerbs } from './readiness/useReadinessVerbs';
import type { ReadinessVerb } from './readiness/readinessVerbs';
import { useFindingDismissal } from '@/hooks/useFindingDismissal';
import { READINESS_SEVERITY_SCALE, partitionFindings } from '@/lib/findingDismissals';
import type { FindingDismissal } from '@/types/findingDismissal';

function navigate(detail: SenchoNavigateDetail): void {
  window.dispatchEvent(new CustomEvent<SenchoNavigateDetail>(SENCHO_NAVIGATE_EVENT, { detail }));
}

/** Status row and findings table, sized like the loaded layout so nothing shifts when data lands. */
function ReadinessSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Checking readiness">
      <div className="flex items-center gap-4 border-b border-card-border pb-3">
        <Skeleton className="h-2 w-2 rounded-full" />
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="ml-auto h-4 w-24" />
      </div>
      <div className="rounded-lg border border-card-border border-t-card-border-top bg-card p-4 shadow-card-bevel">
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-2 w-2 rounded-full" />
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="ml-auto h-4 w-16" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

interface FleetReadinessProps {
  /**
   * The hub's readiness check, owned by the Fleet shell so it starts when Fleet
   * opens and survives switching tabs rather than reloading on every visit.
   */
  readiness: FleetReadinessState;
  /** Opens the in-view node details sheet. */
  onOpenNodeDetails: (nodeId: number) => void;
  /** Switches to a node and opens its Security view; absent when the shell did not provide one. */
  onOpenNodeSecurity?: (nodeId: number, tab: SecurityTab | null) => void;
  /** Opens a Settings section; absent when the shell did not provide one. */
  onOpenSettingsSection?: (section: SectionId) => void;
  /** Snapshots is an admin-only tab, so its shortcut follows the same gate. */
  isAdmin: boolean;
  /** Whether this account may dismiss the finding, from the shell that owns the auth context. */
  canDismiss: (finding: ReadinessFinding) => boolean;
  /** Whether this account may run the verb on the finding; a verb it may not run is not offered. */
  canRun: (verb: ReadinessVerb, finding: ReadinessFinding) => boolean;
}

/**
 * Fleet Readiness: what across this fleet needs attention before you operate,
 * update, recover, or rely on it.
 *
 * Every state, reason code, and finding is decided on the hub; this surface
 * renders the payload. A finding carries the verb that resolves it where it is
 * listed, or routes to the surface that owns its remediation when the work lives
 * elsewhere. Nothing here recomputes a verdict.
 */
export function FleetReadiness({
  readiness,
  onOpenNodeDetails,
  onOpenNodeSecurity,
  onOpenSettingsSection,
  isAdmin,
  canDismiss,
  canRun,
}: FleetReadinessProps) {
  const { data, error, checking, retry, patchDismissals } = readiness;
  // A fast answer never flashes the skeleton; the pane just holds its height.
  const { showBusy } = useVisualBusy(!data && error === null);
  const [filter, setFilter] = useState<FindingsFilter>(EMPTY_FINDINGS_FILTER);
  const findingsRef = useRef<HTMLDivElement>(null);
  // Relative "seen Xm ago" stamps in the matrix move with the clock.
  const now = useNow(30_000);

  const openFinding = useCallback((finding: ReadinessFinding) => {
    const target = finding.target;
    switch (target.surface) {
      case 'stack':
        window.dispatchEvent(new CustomEvent<SenchoOpenStackDetail>(SENCHO_OPEN_STACK_EVENT, {
          detail: { nodeId: target.nodeId, stackName: target.stackName },
        }));
        return;
      case 'auto-updates':
        navigate({ view: 'auto-updates' });
        return;
      case 'fleet-snapshots':
        navigate({ view: 'fleet', fleetTab: 'snapshots' });
        return;
      case 'security':
        // Security reads the active node, so the finding's node is selected first.
        onOpenNodeSecurity?.(finding.nodeId, target.tab === null ? null : toSecurityTab(target.tab));
        return;
      case 'node-details':
        onOpenNodeDetails(target.nodeId);
        return;
      case 'settings-nodes':
        onOpenSettingsSection?.('nodes');
    }
  }, [onOpenNodeDetails, onOpenNodeSecurity, onOpenSettingsSection]);

  const nodeNames = useMemo(() => new Map((data?.nodes ?? []).map(node => [node.id, node.name])), [data?.nodes]);
  const nodeName = useCallback((nodeId: number) => nodeNames.get(nodeId) ?? `node ${nodeId}`, [nodeNames]);
  const { verbFor, overlays } = useReadinessVerbs({ recheck: retry, openFinding, canRun, nodeName });

  // A finding is always listed; only the shortcut is withheld when the current
  // user cannot reach the surface it points at, so no row offers a dead button.
  const actionFor = useCallback((target: ReadinessTarget): string | null => {
    if (target.surface === 'fleet-snapshots' && !isAdmin) return null;
    if (target.surface === 'settings-nodes' && onOpenSettingsSection === undefined) return null;
    if (target.surface === 'security' && onOpenNodeSecurity === undefined) return null;
    return TARGET_ACTION[target.surface] ?? null;
  }, [isAdmin, onOpenNodeSecurity, onOpenSettingsSection]);

  // A cell whose cause the hub reports once, on Connectivity (an unreachable
  // node), has no findings of its own, so it narrows to the node instead of
  // landing on an empty list.
  const findings = data?.findings;
  const upsertDismissal = useCallback((dismissal: FindingDismissal) => {
    patchDismissals(current => [...current.filter(item => item.id !== dismissal.id && item.findingKey !== dismissal.findingKey), dismissal]);
  }, [patchDismissals]);
  const removeDismissal = useCallback((id: number) => {
    patchDismissals(current => current.filter(item => item.id !== id));
  }, [patchDismissals]);
  const { dismiss, restore, isPending } = useFindingDismissal({
    surface: 'readiness',
    onUpsert: upsertDismissal,
    onRemove: removeDismissal,
    onGone: retry,
  });

  // The matrix keeps the whole list: a dismissal moves a finding out of the
  // attention list, it never changes what a cell says.
  const partition = useMemo(
    () => partitionFindings(data?.findings ?? [], data?.dismissals ?? [], now, READINESS_SEVERITY_SCALE),
    [data?.findings, data?.dismissals, now],
  );
  const focusCell = useCallback((nodeId: number, domain: ReadinessDomainKey) => {
    const hasOwn = findings?.some(finding => finding.nodeId === nodeId && finding.domain === domain) ?? false;
    setFilter({ ...EMPTY_FINDINGS_FILTER, nodeId, domain: hasOwn ? domain : ALL });
    findingsRef.current?.scrollIntoView({ block: 'start' });
  }, [findings]);

  if (!data) {
    return (
      <div className="min-h-[320px] space-y-4">
        {error === null && showBusy && <ReadinessSkeleton />}
        {error !== null && (
          <FleetEmptyState>
            <FleetEmptyCard
              icon={ServerOff}
              title="Readiness is unavailable"
              description={error}
              action={(
                <Button variant="outline" size="sm" onClick={retry} disabled={checking}>
                  <RefreshCw className="mr-1.5 h-4 w-4" strokeWidth={1.5} />
                  Try again
                </Button>
              )}
            />
          </FleetEmptyState>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* A failed refresh keeps the last result on screen, so it has to say so:
          a readiness board that silently shows stale states is the one thing it
          must never do. */}
      {error !== null && (
        <div role="status" className="flex items-center justify-between gap-3 rounded-lg border border-warning/30 bg-warning/[0.06] px-3 py-2 text-[12px] text-warning">
          <span>
            {error}
            {data.nodes.length > 0 && ' Showing the previous result.'}
          </span>
          <Button variant="ghost" size="sm" className="shrink-0 text-warning" onClick={retry} disabled={checking}>
            Try again
          </Button>
        </div>
      )}
      {data.nodes.length === 0 ? (
        <FleetEmptyState>
          <FleetEmptyCard
            icon={ServerOff}
            title="No nodes yet"
            description="Add a node to see what across the fleet needs attention."
          />
        </FleetEmptyState>
      ) : (
        <>
          <ReadinessSummaryStrip data={data} checking={checking} dismissedCount={partition.dismissed.length} />
          <div ref={findingsRef} className="scroll-mt-4">
            <ReadinessFindingsTable
              findings={partition.active}
              dismissed={partition.dismissed}
              onRestore={dismissal => { void restore(dismissal.id); }}
              isRestoring={dismissal => isPending(dismissal.id)}
              now={now}
              canDismiss={canDismiss}
              onDismiss={(finding, mode, days) => { void dismiss(finding, mode, days); }}
              isDismissing={finding => isPending(finding.id)}
              domains={data.domains}
              nodes={data.nodes}
              filter={filter}
              onFilterChange={setFilter}
              actionFor={actionFor}
              onOpen={openFinding}
              verbFor={verbFor}
            />
          </div>
          <ReadinessNodeMatrix
            domains={data.domains}
            nodes={data.nodes}
            findings={data.findings}
            now={now}
            onOpenNode={onOpenNodeDetails}
            onFocusCell={focusCell}
          />
        </>
      )}
      {overlays}
    </div>
  );
}
