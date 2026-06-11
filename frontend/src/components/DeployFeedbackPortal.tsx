import { useDeployFeedback } from '@/context/DeployFeedbackContext';
import { useDeployFeedbackStyle } from '@/hooks/use-deploy-feedback-style';
import TerminalComponent from './Terminal';
import { DeployFeedbackModal } from './DeployFeedbackModal';
import { DeployFeedbackPill } from './DeployFeedbackPill';

export function DeployFeedbackPortal() {
  const { panelState, minimized, setMinimized, bannerActive, onTerminalReady, onTerminalError, onMessage } = useDeployFeedback();
  const [style] = useDeployFeedbackStyle();

  return (
    <>
      <DeployFeedbackModal
        isMinimized={minimized}
        onMinimize={() => setMinimized(true)}
      />
      {/* The pill is the minimized surface. In Modal style it shows whenever the
          modal is minimized. In Inline style the in-page banner is the surface,
          so the pill only fills in when the banner is not covering the session:
          an App Store install, after navigating away from the stack, or a failed
          op the banner steps aside for. This keeps a click-through to the log in
          every case without ever overlapping the banner. */}
      <DeployFeedbackPill
        isVisible={panelState.isOpen && minimized && (style === 'modal' || !bannerActive)}
        onExpand={() => setMinimized(false)}
      />
      {/* Inline style streams without the modal: the modal owns the terminal in
          Modal style, but in Inline style the modal stays closed, so mount the
          single progress terminal here (hidden) to feed logRows to the banner.
          Exactly one terminal owns the per-session socket at a time. */}
      {style === 'inline' && panelState.isOpen && (
        <div aria-hidden className="h-0 overflow-hidden">
          <TerminalComponent
            deploySessionId={panelState.deploySessionId}
            onReady={onTerminalReady}
            onError={onTerminalError}
            onMessage={onMessage}
          />
        </div>
      )}
    </>
  );
}
