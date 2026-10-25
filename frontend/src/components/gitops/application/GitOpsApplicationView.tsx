import type { ReactNode } from 'react';
import { ArrowLeft, ExternalLink, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useWorkplaceCapabilities } from '../portfolio/useWorkplaceCapabilities';
import { closeGitOpsApplication, owningSurfaceHandoff } from '../portfolio/portfolioNavigation';
import GitOpsApplicationDetail from './GitOpsApplicationDetail';
import { ApplicationLoadError } from './ApplicationLoadError';
import { BlueprintOperations } from './BlueprintOperations';
import { useGitOpsApplication } from './useGitOpsApplication';

/**
 * One GitOps application as a page of the phone screen (the desktop workplace
 * opens GitOpsApplicationSheet over its list instead). On a phone it is read-only:
 * BlueprintOperations renders nothing there, and the only outbound action is the
 * hand-off to the surface that owns operator decisions for this application (the
 * stack's Git panel, or the Blueprint deployments tab), because review is the part
 * of the operate loop the phone supports and acting stays on the owning surfaces.
 */
export function GitOpsApplicationView({ id, className, headerActions }: {
  id: string;
  className?: string;
  /** Shell actions for the top bar; the phone screen passes its masthead actions so they stay reachable. */
  headerActions?: ReactNode;
}) {
  const { data, loading, error, staleSince, refreshing, refresh } = useGitOpsApplication(id);
  const row = data?.application ?? null;
  const { canOpenFleet } = useWorkplaceCapabilities();
  const isMobile = useIsMobile();
  const handoff = row ? owningSurfaceHandoff(row, { canOpenBlueprint: canOpenFleet && !isMobile }) : null;
  return (
    <div data-testid="gitops-application-view" className={cn('flex h-full min-h-0 flex-col overflow-hidden p-6', className)}>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" className="-ml-2 h-8 gap-1.5 max-md:min-h-11" onClick={closeGitOpsApplication}>
          <ArrowLeft className="h-4 w-4" strokeWidth={1.5} />
          All applications
        </Button>
        {refreshing && (
          <RefreshCw className="h-3.5 w-3.5 animate-spin text-stat-subtitle" strokeWidth={1.5} aria-label="Refreshing" />
        )}
        {headerActions && <div className="ml-auto flex items-center gap-2">{headerActions}</div>}
      </div>

      {loading && !data ? (
        <div className="flex flex-col gap-4" aria-busy="true">
          <Skeleton className="h-10 w-full max-w-md rounded-md" />
          <Skeleton className="min-h-0 flex-1 rounded-lg" />
        </div>
      ) : error ? (
        <ApplicationLoadError error={error} onRetry={refresh} />
      ) : data && row ? (
        <ScrollArea className="min-h-0 flex-1">
          <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1.5">
              <h1 className="truncate font-heading text-2xl leading-tight tracking-tight text-stat-value">{row.name}</h1>
              <div className="flex flex-wrap items-center gap-2">
                {staleSince !== null && (
                  <>
                    <span className="rounded-sm border border-warning/30 bg-warning/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-warning">
                      last refresh failed · showing last-known
                    </span>
                    <Button variant="ghost" size="sm" className="h-6 px-2 font-mono text-[10px] uppercase tracking-wide max-md:min-h-11" onClick={refresh}>
                      Retry
                    </Button>
                  </>
                )}
              </div>
            </div>
            {handoff && (
              <Button variant="outline" size="sm" className="gap-1.5 max-md:min-h-11" onClick={handoff.open}>
                <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.5} />
                {handoff.label}
              </Button>
            )}
          </header>
          <GitOpsApplicationDetail
            detail={data}
            actions={<BlueprintOperations data={data} refresh={refresh} />}
          />
        </ScrollArea>
      ) : null}
    </div>
  );
}
