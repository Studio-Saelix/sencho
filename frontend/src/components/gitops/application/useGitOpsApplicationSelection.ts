import { useEffect, useState } from 'react';
import { SENCHO_NAVIGATE_EVENT, type SenchoNavigateDetail } from '@/lib/events';
import {
  applicationIdFromSearch,
  closeGitOpsApplicationIfOpen,
  GITOPS_APPLICATION_EVENT,
} from '../portfolio/portfolioNavigation';

function readSelection(): string | null {
  return typeof window === 'undefined' ? null : applicationIdFromSearch(window.location.search);
}

/**
 * The application id the GitOps view is showing, read from the URL.
 *
 * The URL is the only store: opening and closing write it (see
 * portfolioNavigation.ts), Back and Forward move it, and this hook re-reads it
 * on either signal, so the view and the address bar cannot disagree. A
 * navigation to GitOps while an application is open (a contextual indicator
 * elsewhere in the shell) means "the portfolio", so it closes the view.
 */
export function useGitOpsApplicationSelection(): string | null {
  const [selected, setSelected] = useState<string | null>(readSelection);
  useEffect(() => {
    const sync = () => setSelected(readSelection());
    const onNavigate = (e: Event) => {
      if ((e as CustomEvent<SenchoNavigateDetail>).detail?.view === 'gitops') closeGitOpsApplicationIfOpen();
    };
    window.addEventListener('popstate', sync);
    window.addEventListener(GITOPS_APPLICATION_EVENT, sync);
    window.addEventListener(SENCHO_NAVIGATE_EVENT, onNavigate);
    return () => {
      window.removeEventListener('popstate', sync);
      window.removeEventListener(GITOPS_APPLICATION_EVENT, sync);
      window.removeEventListener(SENCHO_NAVIGATE_EVENT, onNavigate);
    };
  }, []);
  return selected;
}
