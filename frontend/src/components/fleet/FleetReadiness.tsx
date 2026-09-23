import { useCallback, useRef, useState } from 'react';
import { RefreshCw, ServerOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SENCHO_OPEN_STACK_EVENT, type SenchoOpenStackDetail } from '@/lib/events';
import { SENCHO_NAVIGATE_EVENT, type SenchoNavigateDetail } from '@/components/NodeManager';
import { toSecurityTab } from '@/lib/router/senchoRoute';
import type { SecurityTab } from '@/lib/events';
import type { SectionId } from '@/components/settings/types';
import type { ReadinessDomainKey, ReadinessFinding, ReadinessTarget } from '@/types/readiness';
import { FleetEmptyCard, FleetEmptyState, FleetTabHeading } from './FleetEmptyState';
import { TARGET_ACTION } from './readinessMeta';
import { useFleetReadiness } from './readiness/useFleetReadiness';
import { ReadinessSummaryStrip } from './readiness/ReadinessSummaryStrip';
import { ReadinessNodeMatrix } from './readiness/ReadinessNodeMatrix';
import { ReadinessFindingsTable } from './readiness/ReadinessFindingsTable';
import { ALL, EMPTY_FINDINGS_FILTER, type FindingsFilter } from './readiness/findingsFilter';
import { useNow } from './readiness/useNow';

const TITLE = 'Fleet Readiness';
const SUBTITLE = 'What needs attention before you operate, update, or recover the fleet.';

function navigate(detail: SenchoNavigateDetail): void {
  window.dispatchEvent(new CustomEvent<SenchoNavigateDetail>(SENCHO_NAVIGATE_EVENT, { detail }));
}

function ReadinessSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Checking readiness">
      <Skeleton className="h-[104px] w-full rounded-lg" />
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
  /** Bumped by the Fleet toolbar's Refresh button to request a new check. */
  refreshKey: number;
  /** Opens the in-view node details sheet. */
  onOpenNodeDetails: (nodeId: number) => void;
  /** Switches to a node and opens its Security view; absent when the shell did not provide one. */
  onOpenNodeSecurity?: (nodeId: number, tab: SecurityTab | null) => void;
  /** Opens a Settings section; absent when the shell did not provide one. */
  onOpenSettingsSection?: (section: SectionId) => void;
  /** Snapshots is an admin-only tab, so its shortcut follows the same gate. */
  isAdmin: boolean;
}

/**
 * Fleet Readiness: what across this fleet needs attention before you operate,
 * update, recover, or rely on it.
 *
 * Every state, reason code, and finding is decided on the hub; this surface
 * renders the payload and routes each finding to the surface that already owns
 * its remediation. Nothing here recomputes a verdict.
 */
export function FleetReadiness({
  refreshKey,
  onOpenNodeDetails,
  onOpenNodeSecurity,
  onOpenSettingsSection,
  isAdmin,
}: FleetReadinessProps) {
  const { data, error, checking, retry } = useFleetReadiness(refreshKey);
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
  const focusCell = useCallback((nodeId: number, domain: ReadinessDomainKey) => {
    const hasOwn = findings?.some(finding => finding.nodeId === nodeId && finding.domain === domain) ?? false;
    setFilter({ ...EMPTY_FINDINGS_FILTER, nodeId, domain: hasOwn ? domain : ALL });
    findingsRef.current?.scrollIntoView({ block: 'start' });
  }, [findings]);

  const heading = <FleetTabHeading title={TITLE} subtitle={SUBTITLE} />;

  if (!data) {
    return (
      <div className="space-y-4">
        {heading}
        {error === null ? <ReadinessSkeleton /> : (
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
      {heading}
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
          <ReadinessSummaryStrip data={data} checking={checking} />
          <div ref={findingsRef} className="scroll-mt-4">
            <ReadinessFindingsTable
              findings={data.findings}
              domains={data.domains}
              nodes={data.nodes}
              filter={filter}
              onFilterChange={setFilter}
              actionFor={actionFor}
              onOpen={openFinding}
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
    </div>
  );
}
