import { useEffect, useState } from 'react';
import { Terminal as TerminalIcon, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { useDeployFeedback, VERB_LABELS } from '@/context/DeployFeedbackContext';
import { useDeployFeedbackStyle } from '@/hooks/use-deploy-feedback-style';
import { formatElapsed } from './recovery-format';
import { classifyOperationPhase } from './operation-phase';
import type { Node } from '@/context/NodeContext';

// How long the banner lingers on a clean completion before clearing itself.
const AUTO_DISMISS_MS = 4000;

interface StackOperationBannerProps {
    stackName: string;
    activeNode: Node | null;
    panelStartedAt: number | null;
    // 'band' is the desktop treatment (a full-bleed section between the header
    // and the container list); 'card' is the mobile treatment (a standalone
    // card with a status rail). The inner content is identical.
    variant: 'band' | 'card';
    className?: string;
}

// Inline progress for the active deploy/update on the viewed stack, shown only
// in Inline progress style (the modal is the surface otherwise). Reads the
// deploy-feedback session directly: operation, elapsed, the live phase and
// latest output line, the post-update health gate, and a "View output" button
// that opens the full log modal. A dismiss button clears it without the modal.
export function StackOperationBanner({ stackName, activeNode, panelStartedAt, variant, className }: StackOperationBannerProps) {
    const { panelState, healthGate, logRows, minimized, setMinimized, setBannerActive, onPanelClose } = useDeployFeedback();
    const [style] = useDeployFeedbackStyle();

    const { action, status, nodeId, progressUnavailable } = panelState;
    // A failed gate routes into the recovery surface (RecoveryChip/Panel), so the
    // banner steps aside for it rather than double-reporting the failure.
    const active =
        style === 'inline' &&
        panelState.isOpen &&
        panelState.stackName === stackName &&
        nodeId === (activeNode?.id ?? null) &&
        status !== 'failed' &&
        healthGate?.status !== 'failed';

    const gateObserving = healthGate?.status === 'observing';
    const succeeded = status === 'succeeded';
    // Operation finished (succeeded and any gate has settled past observing):
    // freeze the elapsed here and switch to past tense.
    const done = succeeded && !gateObserving;
    // Fully done with a clean result (no gate, or a passed gate): auto-dismiss.
    const fullyDone = done && (healthGate == null || healthGate.status === 'passed');

    // Tell the portal this session is covered by the banner so its fallback pill
    // stays hidden here; when the banner is not active (off the stack detail, or
    // a failed op it steps aside for) the pill takes over as the surface.
    useEffect(() => {
        setBannerActive(active);
        return () => setBannerActive(false);
    }, [active, setBannerActive]);

    // Freeze the elapsed at completion so the timer stops at the final duration.
    const [frozenElapsed, setFrozenElapsed] = useState<string | null>(null);
    useEffect(() => {
        if (!active) {
            setFrozenElapsed(null);
            return;
        }
        if (done && frozenElapsed === null && panelStartedAt != null) {
            setFrozenElapsed(formatElapsed(Date.now() - panelStartedAt));
        }
    }, [active, done, frozenElapsed, panelStartedAt]);

    // Tick each second while running so elapsed and the gate's observing count
    // stay live; stop once done (the elapsed is frozen from then on).
    const [, tick] = useState(0);
    useEffect(() => {
        if (!active || done) return;
        const id = setInterval(() => tick((n) => n + 1), 1000);
        return () => clearInterval(id);
    }, [active, done]);

    // Auto-dismiss a few seconds after a clean completion. `minimized` false
    // means the user has the full-log modal open over the banner: hold off then
    // (neither surface auto-closes in Inline style, by design, so a log is not
    // yanked mid-read) and arm the timer once they close it back to the banner.
    useEffect(() => {
        if (!active || !fullyDone || !minimized) return;
        const timer = setTimeout(() => onPanelClose(), AUTO_DISMISS_MS);
        return () => clearTimeout(timer);
    }, [active, fullyDone, minimized, onPanelClose]);

    if (!active) {
        // The desktop band keeps its vertical slot reserved when idle so the
        // container cards sit at the same height whether or not an operation is
        // running, holding the space the removed section title used to occupy.
        // Mobile reserves nothing (its card slot is conditional).
        return variant === 'band' ? <div aria-hidden className="h-12" /> : null;
    }

    const verb = done ? VERB_LABELS[action].past : VERB_LABELS[action].present;
    const elapsed = frozenElapsed ?? (panelStartedAt != null ? formatElapsed(Date.now() - panelStartedAt) : null);

    let statusText: string | null = null;
    let detailLine: string | null = null;
    if (progressUnavailable && (status === 'preparing' || status === 'streaming')) {
        statusText = 'Live progress unavailable';
        detailLine = 'The operation continues running in the background.';
    } else if (gateObserving) {
        statusText = 'Verifying health';
        const gateElapsed = healthGate?.startedAt ? Math.max(0, Math.floor((Date.now() - healthGate.startedAt) / 1000)) : 0;
        detailLine = healthGate?.windowSeconds ? `${gateElapsed}s of ${healthGate.windowSeconds}s` : `${gateElapsed}s`;
    } else if (healthGate?.status === 'passed') {
        statusText = 'Health gate passed';
    } else if (healthGate?.status === 'unknown') {
        statusText = 'Health check unknown';
        detailLine = healthGate.reason ?? null;
    } else if (!succeeded) {
        statusText = classifyOperationPhase(logRows, action);
        detailLine = logRows.length > 0 ? logRows[logRows.length - 1].message : null;
    }

    const successDot = done || healthGate?.status === 'passed';

    const inner = (
        <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm">
                    <span
                        aria-hidden
                        className={cn(
                            'h-1.5 w-1.5 shrink-0 rounded-full',
                            successDot ? 'bg-success' : 'bg-brand animate-[pulse_2.4s_ease-in-out_infinite]',
                        )}
                    />
                    <span className="font-medium text-foreground">{verb}</span>
                    {elapsed && (
                        <>
                            <span className="text-stat-subtitle">·</span>
                            <span className="font-mono text-[11px] tabular-nums text-stat-subtitle">{elapsed}</span>
                        </>
                    )}
                    {statusText && (
                        <>
                            <span className="text-stat-subtitle">·</span>
                            <span className="truncate text-xs text-muted-foreground">{statusText}</span>
                        </>
                    )}
                </p>
                {detailLine && (
                    <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground" title={detailLine}>
                        {detailLine}
                    </p>
                )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
                <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                    onClick={() => setMinimized(false)}
                >
                    <TerminalIcon className="h-3.5 w-3.5" />
                    View output
                </Button>
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground hover:text-foreground"
                    onClick={onPanelClose}
                    title="Dismiss"
                    aria-label="Dismiss progress"
                >
                    <X className="h-3.5 w-3.5" />
                </Button>
            </div>
        </div>
    );

    const commonProps = {
        'data-testid': 'stack-operation-banner',
        role: 'status' as const,
        'aria-label': `${verb} ${stackName}`,
    };

    if (variant === 'band') {
        return (
            <div {...commonProps} className={cn('border-y border-hairline bg-band px-4 py-2.5', className)}>
                {inner}
            </div>
        );
    }
    return (
        <div {...commonProps} className={cn('relative overflow-hidden rounded-xl border border-muted bg-card p-3', className)}>
            <span aria-hidden className={cn('absolute inset-y-0 left-0 w-[3px]', successDot ? 'bg-success/70' : 'bg-brand/70')} />
            <div className="pl-2">{inner}</div>
        </div>
    );
}
