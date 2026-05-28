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
   * True once the progress socket has failed to connect or dropped. The deploy
   * is owned by its HTTP request, so it still runs to completion; this only
   * tells the UI that live output is no longer arriving.
   */
  progressUnavailable: boolean;
  /**
   * Per-deploy correlation id sent to the backend on both the `connectTerminal`
   * WebSocket message and the deploy POST header, so concurrent deploys never
   * cross-stream output. Empty until the first runWithLog call.
   */
  deploySessionId: string;
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
    run: (deployStarted: Promise<void>, deploySessionId: string) => Promise<RunResult>
  ) => Promise<RunResult>;
  panelState: DeployPanelState;
  logRows: ParsedLogRow[];
  onTerminalReady: () => void;
  onTerminalError: () => void;
  onMessage: (text: string) => void;
  onPanelClose: () => void;
}

const DEFAULT_PANEL_STATE: DeployPanelState = {
  isOpen: false,
  stackName: '',
  action: 'deploy',
  status: 'preparing',
  progressUnavailable: false,
  deploySessionId: '',
  sessionId: 0,
};

/**
 * Upper bound on the parsed rows kept in memory for one deploy. A verbose deploy
 * (many services, many image layers) can emit thousands of lines; past this cap
 * the oldest rows are dropped and a single sentinel row marks the truncation, so
 * state and the rendered DOM stay bounded. The xterm raw view keeps its own
 * 10k-line scrollback independently.
 */
const MAX_LOG_ROWS = 5000;
const TRUNCATION_ROW_ID = 'row-truncated';

/**
 * Last-resort fallback: if the progress socket neither opens nor errors within
 * this window, release the deploy anyway so a silently stalled connection never
 * blocks the deploy itself. Connect failures normally resolve far sooner via
 * onTerminalError.
 */
const PROGRESS_CONNECT_TIMEOUT_MS = 8000;

const DeployFeedbackContext = createContext<DeployFeedbackContextValue | undefined>(undefined);

export function DeployFeedbackProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const [panelState, setPanelState] = useState<DeployPanelState>(DEFAULT_PANEL_STATE);
  const [logRows, setLogRows] = useState<ParsedLogRow[]>([]);

  // Idempotent resolver for the current session's deployStarted gate. Set at the
  // start of each runWithLog call; called by onTerminalReady (stream connected),
  // onTerminalError (stream failed/dropped), or the connect-timeout fallback.
  // Not state: changing it must not trigger a re-render.
  const settleStartRef = useRef<(() => void) | null>(null);

  // Whether the progress stream has connected for the current session. Lets
  // onTerminalError distinguish a connect failure (release the deploy gate) from
  // a mid-stream drop (gate already released; just mark output unavailable).
  const streamReadyRef = useRef(false);

  // Tracks whether a session is still active so a cancelled session
  // cannot mutate state for the new session that replaced it.
  const sessionIdRef = useRef(0);

  // Monotonically increasing counter for unique log row IDs.
  // Never reset between deploys so React keys remain globally unique.
  const idCounterRef = useRef(0);

  const [isEnabled] = useDeployFeedbackEnabled();

  const onTerminalReady = useCallback(() => {
    streamReadyRef.current = true;
    setPanelState((prev) => (prev.status === 'preparing' ? { ...prev, status: 'streaming' } : prev));
    // Give the connectTerminal handshake a beat to register on the backend
    // before the deploy POST fires, so the first lines are not missed.
    setTimeout(() => settleStartRef.current?.(), 50);
  }, []);

  const onTerminalError = useCallback(() => {
    // The progress socket failed to connect or dropped mid-stream. The deploy is
    // owned by its HTTP request, not this socket, so flag that live output is
    // gone and, if the stream never connected, release the gate so the deploy
    // still fires.
    setPanelState((prev) => (prev.isOpen ? { ...prev, progressUnavailable: true } : prev));
    if (!streamReadyRef.current) settleStartRef.current?.();
  }, []);

  const onMessage = useCallback((text: string) => {
    const newRows = parseLogChunk(text, idCounterRef.current);
    idCounterRef.current += newRows.length;
    setLogRows((prev) => {
      const combined = prev.length > 0 && prev[0].id === TRUNCATION_ROW_ID
        ? [...prev.slice(1), ...newRows]
        : [...prev, ...newRows];
      if (combined.length <= MAX_LOG_ROWS) return combined;
      const kept = combined.slice(combined.length - MAX_LOG_ROWS);
      return [
        { id: TRUNCATION_ROW_ID, timestamp: kept[0].timestamp, stage: 'LOG', level: 'info',
          message: `... earlier output truncated (showing last ${MAX_LOG_ROWS} lines) ...`, raw: '' },
        ...kept,
      ];
    });
  }, []);

  const onPanelClose = useCallback(() => {
    sessionIdRef.current += 1;
    settleStartRef.current = null;
    streamReadyRef.current = false;
    setPanelState(DEFAULT_PANEL_STATE);
    setLogRows([]);
  }, []);

  const runWithLog = useCallback(
    async (
      params: { stackName: string; action: ActionVerb },
      run: (deployStarted: Promise<void>, deploySessionId: string) => Promise<RunResult>
    ): Promise<RunResult> => {
      // Unique, unguessable per-deploy id correlating the progress socket with
      // the deploy POST so concurrent deploys cannot read each other's output.
      // Uses crypto.getRandomValues (the one Crypto member available in insecure
      // contexts, so it works over LAN HTTP, unlike crypto.randomUUID). When the
      // feature is disabled the id is never registered on the backend, so output
      // simply streams nowhere.
      const idBytes = new Uint8Array(16);
      crypto.getRandomValues(idBytes);
      const deploySessionId = Array.from(idBytes, (b) => b.toString(16).padStart(2, '0')).join('');

      if (!isEnabled) {
        return run(Promise.resolve(), deploySessionId);
      }

      // Cancel any existing session before starting a new one.
      sessionIdRef.current += 1;
      const mySession = sessionIdRef.current;
      streamReadyRef.current = false;

      // idCounterRef is intentionally not reset; keys must remain globally unique across sessions.
      setLogRows([]);

      setPanelState({
        isOpen: true,
        stackName: params.stackName,
        action: params.action,
        status: 'preparing',
        progressUnavailable: false,
        deploySessionId,
        sessionId: mySession,
      });

      const deployStarted = new Promise<void>((resolve) => {
        let done = false;
        const settle = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve();
        };
        // settle only runs asynchronously (timer fire or onTerminalReady/Error),
        // by which point `timer` is assigned, so the forward reference is safe.
        const timer = setTimeout(settle, PROGRESS_CONNECT_TIMEOUT_MS);
        settleStartRef.current = settle;
      });

      let result: RunResult;
      try {
        result = await run(deployStarted, deploySessionId);
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
      value={{ runWithLog, panelState, logRows, onTerminalReady, onTerminalError, onMessage, onPanelClose }}
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
