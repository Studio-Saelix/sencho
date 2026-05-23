import React, { createContext, useContext, useState, useRef, useCallback } from 'react';
import { type ParsedLogRow, parseLogChunk } from '../components/log-rendering/composeLogParser';
import { useDeployFeedbackEnabled } from '../hooks/use-deploy-feedback-enabled';

export type ActionVerb = 'deploy' | 'update' | 'down' | 'restart' | 'stop' | 'install';

// eslint-disable-next-line react-refresh/only-export-components
export const VERB_LABELS: Record<ActionVerb, { present: string; past: string }> = {
  deploy:  { present: 'Deploying',  past: 'Deployed'  },
  update:  { present: 'Updating',   past: 'Updated'   },
  down:    { present: 'Stopping',   past: 'Stopped'   },
  restart: { present: 'Restarting', past: 'Restarted' },
  stop:    { present: 'Stopping',   past: 'Stopped'   },
  install: { present: 'Installing', past: 'Installed' },
};

export interface DeployPanelState {
  isOpen: boolean;
  stackName: string;
  action: ActionVerb;
  status: 'preparing' | 'streaming' | 'succeeded' | 'failed';
  errorMessage?: string;
  /**
   * Monotonic id incremented on every runWithLog call. Lets external
   * consumers (e.g. the sidebar footer elapsed-time tracker) detect a new
   * deploy of the same stack+action even when isOpen stays true across the
   * transition.
   */
  sessionId: number;
}

interface RunResult {
  ok: boolean;
  errorMessage?: string;
}

interface DeployFeedbackContextValue {
  runWithLog: (
    params: { stackName: string; action: ActionVerb },
    run: (deployStarted: Promise<void>) => Promise<RunResult>
  ) => Promise<RunResult>;
  panelState: DeployPanelState;
  logRows: ParsedLogRow[];
  onTerminalReady: () => void;
  onMessage: (text: string) => void;
  onPanelClose: () => void;
}

const DEFAULT_PANEL_STATE: DeployPanelState = {
  isOpen: false,
  stackName: '',
  action: 'deploy',
  status: 'preparing',
  sessionId: 0,
};

const DeployFeedbackContext = createContext<DeployFeedbackContextValue | undefined>(undefined);

export function DeployFeedbackProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [panelState, setPanelState] = useState<DeployPanelState>(DEFAULT_PANEL_STATE);
  const [logRows, setLogRows] = useState<ParsedLogRow[]>([]);

  // Holds the resolver for the current session's deployStarted promise.
  // Updated at the start of each runWithLog call; not state because
  // changing it must not trigger a re-render.
  const readyResolverRef = useRef<(() => void) | null>(null);

  // Tracks whether a session is still active so a cancelled session
  // cannot mutate state for the new session that replaced it.
  const sessionIdRef = useRef(0);

  // Monotonically increasing counter for unique log row IDs.
  // Never reset between deploys so React keys remain globally unique.
  const idCounterRef = useRef(0);

  const [isEnabled] = useDeployFeedbackEnabled();

  const onTerminalReady = useCallback(() => {
    setPanelState((prev) => ({ ...prev, status: 'streaming' }));
    if (readyResolverRef.current !== null) {
      readyResolverRef.current();
      readyResolverRef.current = null;
    }
  }, []);

  const onMessage = useCallback((text: string) => {
    const newRows = parseLogChunk(text, idCounterRef.current);
    idCounterRef.current += newRows.length;
    setLogRows((prev) => [...prev, ...newRows]);
  }, []);

  const onPanelClose = useCallback(() => {
    sessionIdRef.current += 1;
    readyResolverRef.current = null;
    setPanelState(DEFAULT_PANEL_STATE);
    setLogRows([]);
  }, []);

  const runWithLog = useCallback(
    async (
      params: { stackName: string; action: ActionVerb },
      run: (deployStarted: Promise<void>) => Promise<RunResult>
    ): Promise<RunResult> => {
      if (!isEnabled) {
        return run(Promise.resolve());
      }

      // Cancel any existing session before starting a new one.
      sessionIdRef.current += 1;
      const mySession = sessionIdRef.current;

      // idCounterRef is intentionally not reset; keys must remain globally unique across sessions.
      setLogRows([]);

      setPanelState({
        isOpen: true,
        stackName: params.stackName,
        action: params.action,
        status: 'preparing',
        sessionId: mySession,
      });

      const deployStarted = new Promise<void>((resolve) => {
        readyResolverRef.current = () => {
          setTimeout(resolve, 50);
        };
      });

      let result: RunResult;
      try {
        result = await run(deployStarted);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'An unexpected error occurred';
        result = { ok: false, errorMessage: message };
      }

      if (sessionIdRef.current === mySession) {
        setPanelState((prev) => ({
          ...prev,
          status: result.ok ? 'succeeded' : 'failed',
          errorMessage: result.ok ? undefined : result.errorMessage,
        }));
      }

      return result;
    },
    [isEnabled]
  );

  return (
    <DeployFeedbackContext.Provider
      value={{ runWithLog, panelState, logRows, onTerminalReady, onMessage, onPanelClose }}
    >
      {children}
    </DeployFeedbackContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useDeployFeedback(): DeployFeedbackContextValue {
  const context = useContext(DeployFeedbackContext);
  if (context === undefined) {
    throw new Error('useDeployFeedback must be used within a DeployFeedbackProvider');
  }
  return context;
}
