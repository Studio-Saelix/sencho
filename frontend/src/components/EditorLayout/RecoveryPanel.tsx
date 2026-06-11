import { useState } from 'react';
import { AlertTriangle, ChevronDown, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '../ui/button';
import { RecoveryActions, RecoveryClassification } from './RecoveryActions';
import { capitalize, formatElapsed } from './recovery-format';
import type { Node } from '@/context/NodeContext';
import type { StackActionResult } from './EditorView';

interface RecoveryPanelProps {
    stackName: string;
    result: StackActionResult;
    activeNode: Node | null;
    backupInfo: { exists: boolean; timestamp: number | null };
    // Mirrors the existing header-action gate (can('stack:deploy', 'stack', name)).
    canDeploy: boolean;
    onRetry: (e: React.MouseEvent) => void;
    onRestart: (e: React.MouseEvent) => void;
    onRollback: () => void;
    onRefreshState: () => void;
    onDismiss: () => void;
}

// Inline recovery card for the mobile stack detail, shown after an
// update/deploy/restart/rollback fails or stalls. Styled as a quiet card with a
// thin destructive rail (the toast accent language) so it blends with the
// surrounding detail rather than shouting; the desktop surface uses RecoveryChip
// instead. The error and the classified cause stay visible on the card; the
// actions collapse behind one Take action menu so the card stays small on a
// phone. The full failure output stays in the deploy modal.
export function RecoveryPanel({
    stackName,
    result,
    activeNode,
    backupInfo,
    canDeploy,
    onRetry,
    onRestart,
    onRollback,
    onRefreshState,
    onDismiss,
}: RecoveryPanelProps) {
    const [actionsOpen, setActionsOpen] = useState(false);
    const elapsed = formatElapsed(result.endedAt - result.startedAt);

    return (
        <div
            data-testid="recovery-panel"
            role="region"
            aria-label={`${capitalize(result.action)} failed, recovery actions`}
            className="relative overflow-hidden rounded-xl border border-muted bg-card p-3"
        >
            <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-destructive/70" />
            <div className="flex items-start justify-between gap-3 pl-2">
                <div className="flex min-w-0 items-start gap-2">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" strokeWidth={1.8} />
                    <div className="min-w-0">
                        <p className="text-sm font-medium text-foreground">
                            {capitalize(result.action)} failed
                            <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.14em] text-stat-subtitle tabular-nums">
                                {elapsed}
                            </span>
                        </p>
                        <p className="mt-0.5 truncate text-xs text-muted-foreground" title={result.errorMessage}>
                            {result.errorMessage ?? 'The operation did not complete.'}
                            {result.rolledBack && ' · rolled back to previous version'}
                        </p>
                        <div className="mt-1.5">
                            <RecoveryClassification result={result} />
                        </div>
                    </div>
                </div>
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
                    onClick={onDismiss}
                    title="Dismiss"
                    aria-label="Dismiss recovery panel"
                >
                    <X className="h-3.5 w-3.5" />
                </Button>
            </div>

            <div className="mt-2.5 flex justify-end pl-2">
                <Popover open={actionsOpen} onOpenChange={setActionsOpen}>
                    <PopoverTrigger asChild>
                        <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs">
                            Take action
                            <ChevronDown className="h-3 w-3 opacity-70" />
                        </Button>
                    </PopoverTrigger>
                    <PopoverContent align="end" className="w-60 p-1" data-testid="recovery-actions-menu">
                        <RecoveryActions
                            variant="list"
                            stackName={stackName}
                            result={result}
                            activeNode={activeNode}
                            backupInfo={backupInfo}
                            canDeploy={canDeploy}
                            onRetry={onRetry}
                            onRestart={onRestart}
                            onRollback={onRollback}
                            onRefreshState={onRefreshState}
                        />
                    </PopoverContent>
                </Popover>
            </div>
        </div>
    );
}
