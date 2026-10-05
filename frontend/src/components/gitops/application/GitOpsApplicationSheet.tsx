import { useEffect, useRef } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';

import { Skeleton } from '@/components/ui/skeleton';
import { SystemSheet } from '@/components/ui/system-sheet';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useWorkplaceCapabilities } from '../portfolio/useWorkplaceCapabilities';
import {
  closeGitOpsApplication,
  hasGitSourceSheet,
  openGitSourceInPlace,
  owningSurfaceHandoff,
} from '../portfolio/portfolioNavigation';
import GitOpsApplicationDetail from './GitOpsApplicationDetail';
import { ApplicationLoadError } from './ApplicationLoadError';
import { BlueprintOperations } from './BlueprintOperations';
import { useGitOpsApplication } from './useGitOpsApplication';

/**
 * Any GitOps application that has no Git source sheet of its own (every
 * Blueprint application), opened over the portfolio list so the list stays
 * where it was and the decisions happen on the object that raised them.
 * Closing returns to the list; the address keeps the `?application=` deep link.
 *
 * A Direct application is its stack's Git source, so a link that names one
 * hands off to that sheet instead of showing a second, read-only copy of it.
 */
export function GitOpsApplicationSheet({ id }: { id: string }) {
  const { data, loading, error, staleSince, refreshing, refresh } = useGitOpsApplication(id);
  const row = data?.application ?? null;
  const { canOpenFleet } = useWorkplaceCapabilities();
  const isMobile = useIsMobile();
  const redirectsToGitSource = row !== null && hasGitSourceSheet(row);

  // Once per mount: closing pops history asynchronously, and a refresh that lands
  // before it settles must not pop it a second time and leave GitOps.
  const handedOff = useRef(false);
  useEffect(() => {
    if (handedOff.current || !row || !hasGitSourceSheet(row)) return;
    handedOff.current = true;
    openGitSourceInPlace(row);
    closeGitOpsApplication();
  }, [row]);

  const handoff = row && !redirectsToGitSource
    ? owningSurfaceHandoff(row, { canOpenBlueprint: canOpenFleet && !isMobile })
    : null;

  return (
    <SystemSheet
      open
      onOpenChange={(open) => { if (!open) closeGitOpsApplication(); }}
      size="xl"
      crumb={['GitOps', 'Application']}
      name={row?.name ?? 'Application'}
      meta={(
        <span className="flex flex-wrap items-center gap-2">
          {refreshing && (
            <RefreshCw className="h-3 w-3 animate-spin" strokeWidth={1.5} aria-label="Refreshing" />
          )}
          {staleSince !== null && (
            <span className="rounded-sm border border-warning/30 bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-warning">
              last refresh failed · showing last-known
            </span>
          )}
        </span>
      )}
      secondaryActions={handoff ? [{
        label: handoff.label,
        icon: ExternalLink,
        // The owning sheet replaces this one, as a Direct application's Git source does.
        onClick: () => { handoff.open(); closeGitOpsApplication(); },
      }] : undefined}
    >
      <div data-testid="gitops-application-sheet">
        {(loading && !data) || redirectsToGitSource ? (
          <div className="flex flex-col gap-4" aria-busy="true">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-48 w-full rounded-lg" />
          </div>
        ) : error ? (
          <ApplicationLoadError error={error} onRetry={refresh} />
        ) : data ? (
          <GitOpsApplicationDetail
            detail={data}
            actions={<BlueprintOperations data={data} refresh={refresh} />}
          />
        ) : null}
      </div>
    </SystemSheet>
  );
}
