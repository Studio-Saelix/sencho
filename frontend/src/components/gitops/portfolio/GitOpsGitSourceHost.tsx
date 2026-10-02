import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/hooks/use-theme';
import { GitSourcePanel } from '@/components/stack/GitSourcePanel';
import { GITOPS_GIT_SOURCE_EVENT, type GitOpsGitSourceTarget } from './portfolioNavigation';

function notifySourceChanged(): void {
  window.dispatchEvent(new Event('sencho:state-invalidate'));
}

/**
 * Hosts a Direct application's Git source sheet over the GitOps workplace, so
 * opening it never leaves GitOps. The panel targets the application's own
 * node, which need not be the active one.
 *
 * A change in the sheet raises the shared state-invalidate signal, which both
 * the portfolio list and an open application view refresh on.
 */
export function GitOpsGitSourceHost() {
  const { can } = useAuth();
  const { isDarkMode } = useTheme();
  const [target, setTarget] = useState<GitOpsGitSourceTarget | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const handler = (event: Event) => {
      setTarget((event as CustomEvent<GitOpsGitSourceTarget>).detail);
      setOpen(true);
    };
    window.addEventListener(GITOPS_GIT_SOURCE_EVENT, handler);
    return () => window.removeEventListener(GITOPS_GIT_SOURCE_EVENT, handler);
  }, []);

  if (target === null) return null;
  const { nodeId, stackName, applicationName } = target;
  return (
    <GitSourcePanel
      // A fresh panel per application, so one stack's form never shows under another's header.
      key={`${nodeId}:${stackName}`}
      open={open}
      onOpenChange={setOpen}
      stackName={stackName}
      nodeId={nodeId}
      crumb={['GitOps', applicationName, 'Git source']}
      showPortfolioLink={false}
      canEdit={can('stack:edit', 'stack', stackName, nodeId)}
      canDeploy={can('stack:deploy', 'stack', stackName, nodeId)}
      isDarkMode={isDarkMode}
      onSourceChanged={notifySourceChanged}
    />
  );
}
