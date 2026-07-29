import type { ReactNode } from 'react';
import { MotionConfig } from 'motion/react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { useReducedMotion } from './hooks/use-theme';
import { NodeProvider } from './context/NodeContext';
import { LicenseProvider } from './context/LicenseContext';
import { Login } from './components/Login';
import { Setup } from './components/Setup';
import EditorLayout from './components/EditorLayout';
import { MfaChallenge } from './components/MfaChallenge';
import { DeployFeedbackProvider } from './context/DeployFeedbackContext';
import { DeployFeedbackPortal } from './components/DeployFeedbackPortal';
import { ToastContainer } from './components/ui/toast';
import { Button } from './components/ui/button';
import { AlertCircle, RefreshCw } from 'lucide-react';

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
          <EditorLayout />
          {/* Portal lives inside LicenseProvider so the editor surface and its
              portalled overlays can read license state via useLicense().
              Outer DeployFeedbackProvider is still an ancestor through App. */}
          <DeployFeedbackPortal />
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
      <ToastContainer />
    </AuthProvider>
  );
}

export default App;
