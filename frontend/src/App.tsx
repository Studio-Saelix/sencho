import type { ReactNode } from 'react';
import { useEffect, useRef } from 'react';
import { MotionConfig } from 'motion/react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { useReducedMotion } from './hooks/use-theme';
import { useUserPreferencesSync } from './hooks/useUserPreferencesSync';
import { subscribeToUnsaved } from './lib/preferences/preferenceEvents';
import { retryDomain } from './lib/preferences/syncBus';
import { toast } from './components/ui/toast-store';
import { NodeProvider } from './context/NodeContext';
import { LicenseProvider } from './context/LicenseContext';
import { BuildInfoProvider } from './context/BuildInfoProvider';
import { Login } from './components/Login';
import { Setup } from './components/Setup';
import EditorLayout from './components/EditorLayout';
import { MfaChallenge } from './components/MfaChallenge';
import { DeployFeedbackProvider } from './context/DeployFeedbackContext';
import { DeployFeedbackPortal } from './components/DeployFeedbackPortal';
import { ToastContainer } from './components/ui/toast';
import { Button } from './components/ui/button';
import { AlertCircle, RefreshCw } from 'lucide-react';

/** Mounts the per-user preference sync owner. Lives OUTSIDE AppContent (a
 *  sibling of the toast layer) because AppContent unmounts on logout; the sync
 *  owner must survive auth transitions to finish or abandon in-flight work.
 *  Also hosts the unsaved-change toast: a failed write raises an episode and
 *  this renders ONE error toast per episode with a Retry action that re-runs
 *  the failed operation by kind. */
function UserPreferencesSync() {
  useUserPreferencesSync();
  useUnsavedPreferenceToast();
  return null;
}

/** Subscribes to the sync bus failure surface. A new episode number shows the
 *  toast; clearing the episode (success) is silent; a retry failure keeps the
 *  episode alive so the toast does not stack. */
function useUnsavedPreferenceToast() {
  const episodeRef = useRef(0);
  useEffect(() => subscribeToUnsaved((episode) => {
    if (episode === null) {
      episodeRef.current = 0;
      return;
    }
    if (episode.episode === episodeRef.current) return;
    episodeRef.current = episode.episode;
    const domain = episode.domain === 'appearance' ? 'appearance preferences' : 'navigation preferences';
    toast.error(`Could not save your ${domain}. Your changes are kept on this device only.`, {
      action: { label: 'Retry', onClick: () => retryDomain(episode.domain) },
    });
  }), []);
}

/** Gates framer-motion animations on the "Reduced motion" appearance setting.
 *  'always' suppresses transform/layout motion app-wide; 'user' defers to the OS
 *  prefers-reduced-motion. Sonner toasts do not use framer-motion, so they are
 *  unaffected. Subscribes only to the motion flag to avoid re-rendering the app
 *  tree on unrelated theme changes. */
function MotionProvider({ children }: { children: ReactNode }) {
  const reducedMotion = useReducedMotion();
  return (
    <MotionConfig reducedMotion={reducedMotion ? 'always' : 'user'}>
      {children}
    </MotionConfig>
  );
}

function AppContent() {
  const { appStatus, isAuthenticated, needsSetup, completeSetup, permissionsStatus, retryPermissions } = useAuth();

  if (appStatus === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center app-canvas">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  if (needsSetup) {
    return <Setup onComplete={completeSetup} />;
  }

  if (appStatus === 'mfaChallenge') {
    return <MfaChallenge />;
  }

  if (!isAuthenticated) {
    return <Login />;
  }

  return (
    <MotionProvider>
      <NodeProvider>
        <LicenseProvider>
          {permissionsStatus === 'error' && (
            <div className="flex items-center justify-between gap-3 border-b border-destructive/30 bg-destructive/[0.06] px-[var(--density-row-x)] py-2 text-sm text-destructive" role="alert">
              <div className="flex min-w-0 items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden />
                <span>Permission controls are unavailable. Changes remain disabled until access is verified.</span>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => void retryPermissions()}>
                <RefreshCw aria-hidden />
                Retry
              </Button>
            </div>
          )}
          <BuildInfoProvider>
            <EditorLayout />
            {/* Portal lives inside LicenseProvider so the editor surface and its
                portalled overlays can read license state via useLicense().
                Outer DeployFeedbackProvider is still an ancestor through App. */}
            <DeployFeedbackPortal />
          </BuildInfoProvider>
        </LicenseProvider>
      </NodeProvider>
    </MotionProvider>
  );
}

function App() {
  return (
    <AuthProvider>
      <DeployFeedbackProvider>
        <AppContent />
      </DeployFeedbackProvider>
      <UserPreferencesSync />
      <ToastContainer />
    </AuthProvider>
  );
}

export default App;
