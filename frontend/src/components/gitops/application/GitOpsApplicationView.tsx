import type { ReactNode } from 'react';
import { ArrowLeft, ExternalLink, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { POSTURE_LABEL, POSTURE_TONE_CLASS } from '@/lib/gitopsPortfolio';
import { useAuth } from '@/context/AuthContext';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-is-mobile';
import { useWorkplaceCapabilities } from '../portfolio/useWorkplaceCapabilities';
import { closeGitOpsApplication, owningSurfaceHandoff } from '../portfolio/portfolioNavigation';
import GitOpsApplicationDetail from './GitOpsApplicationDetail';
import GitOpsAuthorityActions from '@/components/gitops/GitOpsAuthorityActions';
import GitOpsRolloutControls from '@/components/gitops/GitOpsRolloutControls';
import { useGitOpsApplication, type GitOpsApplicationError } from './useGitOpsApplication';

/**
 * One GitOps application inside the workplace: the read-only review surface a
 * portfolio row drills into. It never changes state; its only outbound action
 * is the hand-off to the surface that owns operator decisions for this
 * application (the stack's Git panel, or the Blueprint deployments tab).
 *
 * Used by both the desktop workplace and the phone screen; the layout reflows
 * to one column on a narrow viewport without a separate phone build, because
 * review is the part of the operate loop the phone supports and acting stays
 * on the owning surfaces.
 */
export function GitOpsApplicationView({ id, className, headerActions }: {
  id: string;
  className?: string;
  /** Shell actions for the top bar; the phone screen passes its masthead actions so they stay reachable. */
  headerActions?: ReactNode;
}) {
  const { data, loading, error, staleSince, refreshing, refresh } = useGitOpsApplication(id);
  const { can } = useAuth();
  const row = data?.application ?? null;
  const { canOpenFleet } = useWorkplaceCapabilities();
  const isMobile = useIsMobile();
  const handoff = row ? owningSurfaceHandoff(row, { canOpenBlueprint: canOpenFleet && !isMobile }) : null;
  const canOperateBlueprint = data !== null
    && row !== null
    && !isMobile
    && id.startsWith('bp:')
    && row.targetMode === 'blueprint'
    && typeof data.blueprintEnabled === 'boolean';
  // A posture from a newer build still renders, as an explicit unknown.
  const posture = row
    ? POSTURE_LABEL[row.posture] ?? { label: `unrecognized (${row.posture})`, tone: 'neutral' as const }
    : null;

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
                {posture && (
                  <span
                    data-testid="gitops-application-posture"
                    className={cn(
                      'rounded-md border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.12em]',
                      POSTURE_TONE_CLASS[posture.tone],
                    )}
                  >
                    {posture.label}
                  </span>
                )}
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
            actions={canOperateBlueprint ? (
              <div className="flex flex-col gap-2">
                <GitOpsAuthorityActions
                  applicationId={id}
                  blueprintId={row.blueprintId}
                  blueprintName={row.name}
                  projection={data.projection}
                  onChanged={refresh}
                  can={can}
                  blueprintEnabled={data.blueprintEnabled ?? false}
                />
                <GitOpsRolloutControls
                  applicationId={id}
                  projection={data.projection}
                  onChanged={refresh}
                  can={can}
                  blueprintEnabled={data.blueprintEnabled ?? false}
                  rollbackGenerations={data.rollbackCandidates}
                  nodeLabel={(nodeId) => {
                    const target = row.targets.find(entry => entry.nodeId === nodeId);
                    return target?.nodeName ?? `node ${nodeId}`;
                  }}
                />
              </div>
            ) : null}
          />
        </ScrollArea>
      ) : null}
    </div>
  );
}

function errorCopy(error: GitOpsApplicationError): { title: string; line: string } {
  switch (error.kind) {
    case 'not_readable':
      return {
        title: 'This application is not available',
        line: 'It no longer exists, your account cannot read it, or its owning node is not reporting it right now.',
      };
    case 'invalid_link':
      return {
        title: 'This link does not point to a GitOps application',
        line: 'Open the application from the portfolio list instead.',
      };
    case 'unsupported':
      return {
        title: 'The owning node cannot show this application',
        line: `Its Sencho version cannot serve application reads; run the same version there as on this node (${error.message}).`,
      };
    case 'unreachable':
      return {
        title: 'The owning node did not answer',
        line: `The application's state is unknown until the node reports again (${error.message}).`,
      };
    case 'evidence_unavailable':
      return {
        title: 'Evidence for this application is unavailable',
        line: `Its owning node reports it, but not yet with state this node can read; retry once it reports again (${error.message}).`,
      };
    case 'failed':
      return { title: 'The application could not be read', line: error.message };
  }
}

function ApplicationLoadError({ error, onRetry }: { error: GitOpsApplicationError; onRetry: () => void }) {
  const copy = errorCopy(error);
  return (
    <div data-testid="gitops-application-error" data-error={error.kind} className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <p className="font-heading text-xl text-stat-value">{copy.title}</p>
      <p className="max-w-md font-mono text-xs text-stat-subtitle">{copy.line}</p>
      {error.kind !== 'invalid_link' && error.kind !== 'unsupported' && (
        <Button variant="outline" size="sm" className="max-md:min-h-11" onClick={onRetry}>Retry</Button>
      )}
    </div>
  );
}
