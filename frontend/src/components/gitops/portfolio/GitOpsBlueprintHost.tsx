import { useEffect } from 'react';
import { useBlueprintSheets } from '@/components/blueprints/useBlueprintSheets';
import { raiseGitOpsStateInvalidate } from '@/lib/gitSourceControllerAction';
import { GITOPS_BLUEPRINT_EVENT, type GitOpsBlueprintRequest } from './portfolioNavigation';

/**
 * Hosts a Blueprint's detail sheet and the create dialog over the GitOps workplace,
 * so opening or declaring one never leaves GitOps. They are the same sheets the
 * Fleet Blueprints tab hosts, with the same permissions and handlers.
 */
export function GitOpsBlueprintHost() {
  const { openBlueprint, openCreate, sheets } = useBlueprintSheets({
    // Nothing is reread here; the list and an open application sheet refresh on the announcement.
    onChanged: () => { raiseGitOpsStateInvalidate(null); return true; },
    showPortfolioLink: false,
  });

  useEffect(() => {
    const handler = (event: Event) => {
      const request = (event as CustomEvent<GitOpsBlueprintRequest>).detail;
      if (request.handled) return;
      request.handled = true;
      if (request.intent.kind === 'open') openBlueprint(request.intent.blueprintId);
      else openCreate();
    };
    window.addEventListener(GITOPS_BLUEPRINT_EVENT, handler);
    return () => window.removeEventListener(GITOPS_BLUEPRINT_EVENT, handler);
  }, [openBlueprint, openCreate]);

  return sheets;
}
