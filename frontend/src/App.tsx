import { AuthProvider, useAuth } from './context/AuthContext';
import { NodeProvider } from './context/NodeContext';
import { LicenseProvider } from './context/LicenseContext';
import { Login } from './components/Login';
import { Setup } from './components/Setup';
import EditorLayout from './components/EditorLayout';
import { MfaChallenge } from './components/MfaChallenge';
import { DeployFeedbackProvider } from './context/DeployFeedbackContext';
import { DeployFeedbackPortal } from './components/DeployFeedbackPortal';
import { ToastContainer } from './components/ui/toast';

function AppContent() {
  const { appStatus, isAuthenticated, needsSetup, completeSetup } = useAuth();

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
    <NodeProvider>
      <LicenseProvider>
        <EditorLayout />
        {/* Portal lives inside LicenseProvider so the editor surface and its
            portalled overlays can read license state via useLicense().
            Outer DeployFeedbackProvider is still an ancestor through App. */}
        <DeployFeedbackPortal />
      </LicenseProvider>
    </NodeProvider>
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
