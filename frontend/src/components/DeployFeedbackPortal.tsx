import { useDeployFeedback } from '@/context/DeployFeedbackContext';
import { useDeployFeedbackStyle } from '@/hooks/use-deploy-feedback-style';
import TerminalComponent from './Terminal';
import { DeployFeedbackModal } from './DeployFeedbackModal';
import { DeployFeedbackPill } from './DeployFeedbackPill';

export function DeployFeedbackPortal() {
  const { panelState, minimized, setMinimized, onTerminalReady, onTerminalError, onMessage } = useDeployFeedback();
  const [style] = useDeployFeedbackStyle();

  return (
    <>
      <DeployFeedbackModal
        isMinimized={minimized}
        onMinimize={() => setMinimized(true)}
      />
      {/* The minimize pill belongs to Modal style only; in Inline style the
          in-page banner is the persistent surface and owns "View output". */}
      <DeployFeedbackPill
        isVisible={style === 'modal' && panelState.isOpen && minimized}
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
