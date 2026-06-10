import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  CircleHelp,
  HeartPulse,
  X,
  Minimize2,
  Terminal as TerminalIcon,
} from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { StructuredLogRow } from '@/components/log-rendering/StructuredLogRow';
import TerminalComponent from '@/components/Terminal';
import { useDeployFeedback, VERB_LABELS, type HealthGateUiState } from '@/context/DeployFeedbackContext';

const AUTO_CLOSE_SECONDS = 4;

// Warn that an in-flight operation has gone quiet after this much silence. The
// backend idle-output timeout terminates a truly hung step later (default
// ~10min); this earlier heads-up keeps the modal from looking falsely busy.
const STALL_WARN_MS = 75_000;

interface DeployFeedbackModalProps {
  isMinimized: boolean;
  onMinimize: () => void;
}

function formatElapsed(seconds: number): string {
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s}s`;
  }
  return `${seconds}s`;
}

export function DeployFeedbackModal({ isMinimized, onMinimize }: DeployFeedbackModalProps) {
  const { panelState, healthGate, logRows, lastOutputAt, onTerminalReady, onTerminalError, onMessage, onPanelClose } = useDeployFeedback();

  const [showRaw, setShowRaw] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [countdown, setCountdown] = useState(AUTO_CLOSE_SECONDS);
  const [userScrolledUp, setUserScrolledUp] = useState(false);

  const startTimeRef = useRef<number>(0);
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoCloseHoveredRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { isOpen, stackName, action, status, errorMessage, progressUnavailable } = panelState;

  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShowRaw(false);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setElapsedSeconds(0);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCountdown(AUTO_CLOSE_SECONDS);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setUserScrolledUp(false);
      startTimeRef.current = 0;
    }
  }, [isOpen]);

  useEffect(() => {
    if (isOpen && status !== 'preparing') {
      if (startTimeRef.current === 0) startTimeRef.current = Date.now();
      if (elapsedIntervalRef.current !== null) return;
      elapsedIntervalRef.current = setInterval(() => {
        setElapsedSeconds(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);
    } else {
      if (elapsedIntervalRef.current !== null) {
        clearInterval(elapsedIntervalRef.current);
        elapsedIntervalRef.current = null;
      }
    }
    return () => {
      if (elapsedIntervalRef.current !== null) {
        clearInterval(elapsedIntervalRef.current);
        elapsedIntervalRef.current = null;
      }
    };
  }, [isOpen, status]);

  const clearCountdownInterval = useCallback(() => {
    if (countdownIntervalRef.current !== null) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
  }, []);

  const startCountdown = useCallback(() => {
    clearCountdownInterval();
    setCountdown(AUTO_CLOSE_SECONDS);
    let remaining = AUTO_CLOSE_SECONDS;
    countdownIntervalRef.current = setInterval(() => {
      remaining -= 1;
      setCountdown(remaining);
      if (remaining <= 0) {
        clearCountdownInterval();
        if (!autoCloseHoveredRef.current) {
          onPanelClose();
        }
      }
    }, 1000);
  }, [clearCountdownInterval, onPanelClose]);

  // Auto-close only when there is nothing left to watch: success with no gate,
  // or success whose gate passed. An observing gate suspends the countdown; a
  // failed/unknown gate keeps the modal open until the user closes it.
  const gateHoldsOpen = healthGate !== null && healthGate.status !== 'passed';
  useEffect(() => {
    if (status === 'succeeded' && isOpen && !gateHoldsOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      startCountdown();
    } else {
      clearCountdownInterval();
    }

    return () => {
      clearCountdownInterval();
    };
  }, [status, isOpen, gateHoldsOpen, startCountdown, clearCountdownInterval]);

  useEffect(() => {
    if (!userScrolledUp && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logRows.length, userScrolledUp]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setUserScrolledUp(distanceFromBottom > 32);
  }, []);

  const handleMouseEnter = useCallback(() => {
    autoCloseHoveredRef.current = true;
    clearCountdownInterval();
  }, [clearCountdownInterval]);

  const handleMouseLeave = useCallback(() => {
    autoCloseHoveredRef.current = false;
    if (status === 'succeeded' && isOpen && !gateHoldsOpen) {
      startCountdown();
    }
  }, [status, isOpen, gateHoldsOpen, startCountdown]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onPanelClose();
    },
    [onPanelClose]
  );

  const isDialogOpen = isOpen && !isMinimized;
  const verbLabel = VERB_LABELS[action];

  // Re-evaluated each second by the elapsed-time interval's re-render. Warns
  // while the operation is still streaming but has produced no output for a
  // while, including the case where no first line ever arrived. Suppressed once
  // the progress stream is unavailable: no more output can arrive, so the modal
  // already shows "Live progress unavailable" and a stall warning would be noise.
  const lastLine = logRows.length > 0 ? logRows[logRows.length - 1].message : null;
  const secondsSinceOutput = lastOutputAt > 0 ? Math.floor((Date.now() - lastOutputAt) / 1000) : 0;
  const stalled = status === 'streaming' && !progressUnavailable && lastOutputAt > 0 && Date.now() - lastOutputAt > STALL_WARN_MS;

  return (
    <Modal
      open={isDialogOpen}
      onOpenChange={handleOpenChange}
      showClose={false}
      className="max-w-[640px] max-h-[70vh] flex flex-col"
    >
      <div
        data-testid="deploy-feedback-modal"
        className="flex flex-col flex-1 min-h-0"
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <DialogTitle className="sr-only">
          {verbLabel.present} {stackName}
        </DialogTitle>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-glass-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium text-foreground shrink-0">
              {verbLabel.present}
            </span>
            <span className="text-sm font-mono text-foreground/80 truncate max-w-[200px]">
              {stackName}
            </span>
            {status !== 'preparing' && elapsedSeconds > 0 && (
              <span className="text-xs font-mono text-muted-foreground shrink-0">
                {formatElapsed(elapsedSeconds)}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <StatusIndicator
              status={status}
              progressUnavailable={progressUnavailable}
              rowCount={logRows.length}
              errorMessage={errorMessage}
              countdown={countdown}
              showCountdown={!gateHoldsOpen}
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onMinimize}
              title="Minimize"
            >
              <Minimize2 className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 hover:bg-destructive/10 hover:text-destructive"
              onClick={onPanelClose}
              title="Close"
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* Post-update health gate status */}
        {status === 'succeeded' && healthGate && (
          <HealthGateBanner gate={healthGate} />
        )}

        {/* Stalled-output warning: in-flight but quiet */}
        {stalled && (
          <div
            data-testid="deploy-feedback-stalled"
            className="flex items-start gap-2 px-4 py-2 border-b border-warning/30 bg-warning/5 shrink-0"
          >
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-warning" />
            <div className="min-w-0 text-xs text-warning">
              <p>
                {lastLine
                  ? `No new output for ${formatElapsed(secondsSinceOutput)}. The operation may be stalled.`
                  : 'No output received yet. The operation may be stalled.'}
              </p>
              {lastLine && (
                <p className="mt-0.5 truncate font-mono text-[11px] text-warning/80" title={lastLine}>
                  {lastLine}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Body */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto min-h-0"
          onScroll={handleScroll}
        >
          {logRows.length === 0 ? (
            <EmptyBody status={status} progressUnavailable={progressUnavailable} />
          ) : (
            <div className="py-1">
              {logRows.map((row) => (
                <StructuredLogRow key={row.id} row={row} />
              ))}
            </div>
          )}
        </div>

        {/* always mounted so onMessage feeds structured rows even before user toggles raw view */}
        <div
          className="border-t border-glass-border shrink-0"
          style={{ height: showRaw ? '200px' : 0, overflow: 'hidden' }}
        >
          <TerminalComponent
            deploySessionId={panelState.deploySessionId}
            onReady={onTerminalReady}
            onError={onTerminalError}
            onMessage={onMessage}
          />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2 border-t border-glass-border shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowRaw((prev) => !prev)}
          >
            <TerminalIcon className="h-3.5 w-3.5" />
            {showRaw ? 'Hide raw' : 'Raw output'}
          </Button>

          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={onMinimize}
            >
              <Minimize2 className="h-3.5 w-3.5" />
              Minimize
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 text-xs text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              onClick={onPanelClose}
            >
              <X className="h-3.5 w-3.5" />
              Close
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

// Re-renders every second via the elapsed-time interval, so the observing
// elapsed count stays live without its own timer.
function HealthGateBanner({ gate }: { gate: HealthGateUiState }) {
  const elapsed = gate.startedAt ? Math.max(0, Math.floor((Date.now() - gate.startedAt) / 1000)) : 0;
  const windowLabel = gate.windowSeconds ? ` of ${gate.windowSeconds}s` : '';

  if (gate.status === 'observing') {
    return (
      <div data-testid="health-gate-banner" data-status="observing" className="flex items-start gap-2 px-4 py-2 border-b border-glass-border bg-card/40 shrink-0">
        <HeartPulse className="h-3.5 w-3.5 mt-0.5 shrink-0 text-brand" />
        <p className="min-w-0 text-xs text-muted-foreground">
          Health gate: observing containers ({elapsed}s{windowLabel}). Closing this panel does not stop the observation.
        </p>
      </div>
    );
  }
  if (gate.status === 'passed') {
    return (
      <div data-testid="health-gate-banner" data-status="passed" className="flex items-start gap-2 px-4 py-2 border-b border-success/30 bg-success/5 shrink-0">
        <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0 text-success" />
        <p className="min-w-0 text-xs text-success">
          Health gate passed: containers stayed healthy through the observation window.
        </p>
      </div>
    );
  }
  if (gate.status === 'failed') {
    return (
      <div data-testid="health-gate-banner" data-status="failed" className="flex items-start gap-2 px-4 py-2 border-b border-destructive/30 bg-destructive/5 shrink-0">
        <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-destructive" />
        <p className="min-w-0 text-xs text-destructive">
          Health gate failed{gate.reason ? `: ${gate.reason}` : ''}. Rollback options are available on the stack.
        </p>
      </div>
    );
  }
  return (
    <div data-testid="health-gate-banner" data-status="unknown" className="flex items-start gap-2 px-4 py-2 border-b border-glass-border bg-card/40 shrink-0">
      <CircleHelp className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
      <p className="min-w-0 text-xs text-muted-foreground">
        Health gate result is unknown{gate.reason ? `: ${gate.reason}` : ''}. Check the stack's containers directly.
      </p>
    </div>
  );
}

interface StatusIndicatorProps {
  status: 'preparing' | 'streaming' | 'succeeded' | 'failed';
  progressUnavailable: boolean;
  rowCount: number;
  errorMessage?: string;
  countdown: number;
  /** False while a health gate is observing or terminal-unhealthy (no auto-close). */
  showCountdown: boolean;
}

function StatusIndicator({ status, progressUnavailable, rowCount, errorMessage, countdown, showCountdown }: StatusIndicatorProps) {
  // While the deploy is still in flight (preparing/streaming) but the progress
  // socket is gone, the deploy keeps running server-side with no live output.
  if (progressUnavailable && (status === 'preparing' || status === 'streaming')) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        <span>Live progress unavailable</span>
      </div>
    );
  }

  if (status === 'preparing') {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        <span>Connecting...</span>
      </div>
    );
  }

  if (status === 'streaming') {
    return (
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin text-brand" />
        <span>{rowCount} {rowCount === 1 ? 'line' : 'lines'}</span>
      </div>
    );
  }

  if (status === 'succeeded') {
    return (
      <div className="flex items-center gap-1.5 text-xs text-success">
        <CheckCircle2 className="h-3 w-3 text-success" />
        <span>Succeeded</span>
        {showCountdown && <span className="text-muted-foreground">closes in {countdown}s</span>}
      </div>
    );
  }

  // failed
  return (
    <div className="flex items-center gap-1.5 text-xs text-destructive">
      <AlertCircle className="h-3 w-3 text-destructive" />
      <span
        className="max-w-[200px] truncate"
        title={errorMessage}
      >
        {errorMessage ?? 'Failed'}
      </span>
    </div>
  );
}

interface EmptyBodyProps {
  status: 'preparing' | 'streaming' | 'succeeded' | 'failed';
  progressUnavailable: boolean;
}

function EmptyBody({ status, progressUnavailable }: EmptyBodyProps) {
  if (progressUnavailable && (status === 'preparing' || status === 'streaming')) {
    return (
      <div className="flex items-center justify-center py-10 text-sm text-muted-foreground text-center px-4">
        Live progress is unavailable for this deploy. It continues running in the background.
      </div>
    );
  }

  if (status === 'preparing') {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="text-sm">Connecting to log stream...</span>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center py-10 text-sm text-muted-foreground">
      Waiting for output...
    </div>
  );
}
