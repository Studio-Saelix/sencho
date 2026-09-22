import { useEffect, useState } from 'react';
import { applicationIdFromSearch, GITOPS_APPLICATION_EVENT } from '../portfolio/portfolioNavigation';

function readSelection(): string | null {
  return typeof window === 'undefined' ? null : applicationIdFromSearch(window.location.search);
}

/**
 * The application id the GitOps view is showing, read from the URL.
 *
 * The URL is the only store: opening and closing write it (see
 * portfolioNavigation.ts), Back and Forward move it, and this hook re-reads it
 * on either signal, so the view and the address bar cannot disagree.
 */
export function useGitOpsApplicationSelection(): string | null {
  const [selected, setSelected] = useState<string | null>(readSelection);
  useEffect(() => {
    const sync = () => setSelected(readSelection());
    window.addEventListener('popstate', sync);
    window.addEventListener(GITOPS_APPLICATION_EVENT, sync);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(GITOPS_APPLICATION_EVENT, sync);
    };
  }, []);
  return selected;
}
