import { useEffect, useRef, useState } from 'react';
import type { DeployPanelState } from '@/context/DeployFeedbackContext';

/**
 * Returns the wall-clock timestamp (ms) at which the current deploy-panel
 * session opened, or null if the panel is closed.
 *
 * Keyed off DeployPanelState.sessionId (a monotonic counter from
 * DeployFeedbackContext), so a same-stack rerun, or any new runWithLog call
 * after a previous one finished but the panel stayed visible, resets the
 * timestamp. `isOpen` alone is not sufficient because the panel can flow
 * straight from `succeeded`/`failed` back to `preparing` if the user fires
 * a follow-up deploy without closing the panel first.
 */
export function usePanelSessionStartedAt(panelState: DeployPanelState): number | null {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const sessionRef = useRef<number>(0);

  useEffect(() => {
    if (!panelState.isOpen) {
      if (sessionRef.current !== 0) {
        sessionRef.current = 0;
        setStartedAt(null);
      }
      return;
    }
    if (panelState.sessionId !== sessionRef.current) {
      sessionRef.current = panelState.sessionId;
      setStartedAt(Date.now());
    }
  }, [panelState.isOpen, panelState.sessionId]);

  return startedAt;
}
