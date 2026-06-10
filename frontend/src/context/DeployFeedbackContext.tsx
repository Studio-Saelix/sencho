import React, { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import { apiFetch } from '../lib/api';
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
  /**
   * Health gate run id from the success response, when the backend started a
   * post-update observation. Its presence is the feature signal: an older
   * node never returns one, so no gate UI appears.
   */
  healthGateId?: string | null;
}

/** Post-update health gate state for the current deploy session. */
export interface HealthGateUiState {
  stackName: string;
  gateId: string;
  trigger: 'update' | 'deploy';
  status: 'observing' | 'passed' | 'failed' | 'unknown';
  reason: string | null;
  windowSeconds: number | null;
  startedAt: number | null;
}

const GATE_POLL_INTERVAL_MS = 4_000;

interface DeployFeedbackContextValue {
  runWithLog: (
    params: { stackName: string; action: ActionVerb },
    run: (deployStarted: Promise<void>, deploySessionId: string) => Promise<RunResult>
  ) => Promise<RunResult>;
  panelState: DeployPanelState;
  /** Gate state for the current session, or null when no gate was started. */
  healthGate: HealthGateUiState | null;
  logRows: ParsedLogRow[];
  /**
   * Epoch ms of the most recent activity for the current session: stamped when
   * the deploy starts, again when the stream connects, and on every output
   * chunk. The modal compares it against now to warn that an in-flight
   * operation has gone quiet (a possible stall), covering the no-first-line
   * case because it is seeded at start rather than at first output.
   */
  lastOutputAt: number;
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
  const [healthGate, setHealthGate] = useState<HealthGateUiState | null>(null);
  const [logRows, setLogRows] = useState<ParsedLogRow[]>([]);
  const [lastOutputAt, setLastOutputAt] = useState<number>(0);

  // Poll timer for the current session's health gate; cleared on panel close
  // and whenever a new session starts.
  const gatePollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopGatePolling = useCallback(() => {
    if (gatePollRef.current !== null) {
      clearInterval(gatePollRef.current);
      gatePollRef.current = null;
    }
  }, []);

  // The provider is app-root today, but do not let the interval depend on it.
  useEffect(() => stopGatePolling, [stopGatePolling]);

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
    setLastOutputAt(Date.now());
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
    setLastOutputAt(Date.now());
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
    // The gate keeps observing server-side; only this session's poll stops.
    stopGatePolling();
    setHealthGate(null);
    setPanelState(DEFAULT_PANEL_STATE);
    setLogRows([]);
  }, [stopGatePolling]);

  // Poll the by-id gate endpoint until a terminal status. The id-scoped read
  // means a superseded gate still resolves to its terminal unknown state
  // instead of this session showing a newer run's result. Mirrors the backend
  // gate's own degradation: repeated failures (or an absurdly long poll)
  // resolve to an honest client-side unknown rather than observing forever.
  const startGatePolling = useCallback((stackName: string, gateId: string, trigger: 'update' | 'deploy', mySession: number) => {
    stopGatePolling();
    setHealthGate({ stackName, gateId, trigger, status: 'observing', reason: null, windowSeconds: null, startedAt: null });
    let strikes = 0;
    const pollStartedAt = Date.now();
    const giveUp = (reason: string) => {
      stopGatePolling();
      setHealthGate(prev => (prev && prev.gateId === gateId ? { ...prev, status: 'unknown', reason } : prev));
    };
    const tick = async () => {
      if (sessionIdRef.current !== mySession) {
        stopGatePolling();
        return;
      }
      // Backstop far beyond the largest configurable window (600s).
      if (Date.now() - pollStartedAt > 660_000) {
        giveUp('the observation did not report a result in time');
        return;
      }
      try {
        const res = await apiFetch(`/stacks/${stackName}/health-gate?gateId=${encodeURIComponent(gateId)}`);
        const report = res.ok
          ? await res.json() as {
              id: string | null;
              status: 'observing' | 'passed' | 'failed' | 'unknown' | 'never-run';
              reason: string | null;
              windowSeconds: number | null;
              startedAt: number | null;
            }
          : null;
        if (sessionIdRef.current !== mySession) return;
        // A non-ok response or a missing run (node switched, stack removed, or
        // an older node answering) is a strike, not a retry-forever condition.
        if (!report || report.id !== gateId || report.status === 'never-run') {
          strikes += 1;
          if (!res.ok) console.warn('[DeployFeedback] health gate poll returned', res.status);
          if (strikes >= 4) giveUp('the gate result could not be retrieved');
          return;
        }
        strikes = 0;
        setHealthGate({ stackName, gateId, trigger, status: report.status, reason: report.reason, windowSeconds: report.windowSeconds, startedAt: report.startedAt });
        if (report.status !== 'observing') stopGatePolling();
      } catch (e) {
        strikes += 1;
        console.warn('[DeployFeedback] health gate poll failed:', e);
        if (sessionIdRef.current === mySession && strikes >= 4) giveUp('the gate result could not be retrieved');
      }
    };
    void tick();
    gatePollRef.current = setInterval(() => { void tick(); }, GATE_POLL_INTERVAL_MS);
  }, [stopGatePolling]);

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
      stopGatePolling();
      setHealthGate(null);

      // idCounterRef is intentionally not reset; keys must remain globally unique across sessions.
      setLogRows([]);
      setLastOutputAt(Date.now());

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
        const timer = setTimeout(() => {
          // The stream neither connected nor errored within the window. Mark live
          // output unavailable (so the modal stops showing "Connecting...") and
          // release the deploy so a silent stall never blocks it.
          setPanelState((prev) => (prev.isOpen ? { ...prev, progressUnavailable: true } : prev));
          settle();
        }, PROGRESS_CONNECT_TIMEOUT_MS);
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
        if (result.ok && result.healthGateId && (params.action === 'update' || params.action === 'deploy')) {
          startGatePolling(params.stackName, result.healthGateId, params.action, mySession);
        }
      }

      return result;
    },
    [isEnabled, startGatePolling, stopGatePolling]
  );

  return (
    <DeployFeedbackContext.Provider
      value={{ runWithLog, panelState, healthGate, logRows, lastOutputAt, onTerminalReady, onTerminalError, onMessage, onPanelClose }}
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
