import { useState } from 'react';
import { AlertTriangle, ChevronDown, X } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '../ui/button';
import { RecoveryActions, RecoveryClassification } from './RecoveryActions';
import { capitalize, formatElapsed } from './recovery-format';
import type { Node } from '@/context/NodeContext';
import type { StackActionResult } from './EditorView';

interface RecoveryChipProps {
    stackName: string;
    result: StackActionResult;
    activeNode: Node | null;
    backupInfo: { exists: boolean; timestamp: number | null };
    canDeploy: boolean;
    onRetry: (e: React.MouseEvent) => void;
    onRestart: (e: React.MouseEvent) => void;
    onRollback: () => void;
    onRefreshState: () => void;
    onDismiss: () => void;
}

// Desktop recovery surface: a compact status chip that opens a popover with the
// error and recovery actions, so a failed operation stays discoverable without a
// banner taking permanent space in the detail. The mobile detail uses the inline
// RecoveryPanel instead.
export function RecoveryChip({
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
}: RecoveryChipProps) {
    const [open, setOpen] = useState(false);
    const elapsed = formatElapsed(result.endedAt - result.startedAt);

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    data-testid="recovery-chip"
                    className="inline-flex items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10"
                >
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
                    <span className="font-medium">{capitalize(result.action)} failed</span>
                    <ChevronDown className="h-3 w-3 opacity-70" />
                </button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64 overflow-hidden p-0" data-testid="recovery-panel">
                <div className="px-3 pb-2 pt-2.5">
                    <p className="text-sm font-medium text-foreground">
                        {capitalize(result.action)} failed
                        <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.14em] text-stat-subtitle tabular-nums">
                            {elapsed}
                        </span>
                    </p>
                    <p className="mt-0.5 break-words text-xs text-muted-foreground">
                        {result.errorMessage ?? 'The operation did not complete.'}
                        {result.rolledBack && ' · rolled back to previous version'}
                    </p>
                    <div className="mt-1.5">
                        <RecoveryClassification result={result} />
                    </div>
                </div>
                <div className="border-t border-glass-border p-1">
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
                </div>
                <div className="border-t border-glass-border p-1">
                    <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-full justify-start gap-2 px-2 text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => { onDismiss(); setOpen(false); }}
                    >
                        <X className="h-3.5 w-3.5" />
                        Dismiss
                    </Button>
                </div>
            </PopoverContent>
        </Popover>
    );
}
