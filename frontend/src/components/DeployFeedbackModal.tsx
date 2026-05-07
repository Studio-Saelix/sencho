import { useEffect, useRef, useState, useCallback } from 'react';
import {
  Loader2,
  CheckCircle2,
  AlertCircle,
  X,
  Minimize2,
  Terminal as TerminalIcon,
} from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { StructuredLogRow } from '@/components/log-rendering/StructuredLogRow';
import TerminalComponent from '@/components/Terminal';
import { useDeployFeedback, VERB_LABELS } from '@/context/DeployFeedbackContext';

const AUTO_CLOSE_SECONDS = 4;

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
  const { panelState, logRows, onTerminalReady, onMessage, onPanelClose } = useDeployFeedback();

  const [showRaw, setShowRaw] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [countdown, setCountdown] = useState(AUTO_CLOSE_SECONDS);
  const [userScrolledUp, setUserScrolledUp] = useState(false);

  const startTimeRef = useRef<number>(0);
  const elapsedIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoCloseHoveredRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { isOpen, stackName, action, status, errorMessage } = panelState;

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

  useEffect(() => {
    if (status === 'succeeded' && isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      startCountdown();
    } else {
      clearCountdownInterval();
    }

    return () => {
      clearCountdownInterval();
    };
  }, [status, isOpen, startCountdown, clearCountdownInterval]);

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
    if (status === 'succeeded' && isOpen) {
      startCountdown();
    }
  }, [status, isOpen, startCountdown]);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) onPanelClose();
    },
    [onPanelClose]
  );

  const isDialogOpen = isOpen && !isMinimized;
  const verbLabel = VERB_LABELS[action];

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
              rowCount={logRows.length}
              errorMessage={errorMessage}
              countdown={countdown}
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

        {/* Body */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto min-h-0"
          onScroll={handleScroll}
        >
          {logRows.length === 0 ? (
            <EmptyBody status={status} />
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
            onReady={onTerminalReady}
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

interface StatusIndicatorProps {
  status: 'preparing' | 'streaming' | 'succeeded' | 'failed';
  rowCount: number;
  errorMessage?: string;
  countdown: number;
}

function StatusIndicator({ status, rowCount, errorMessage, countdown }: StatusIndicatorProps) {
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
        <span className="text-muted-foreground">closes in {countdown}s</span>
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
}

function EmptyBody({ status }: EmptyBodyProps) {
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
