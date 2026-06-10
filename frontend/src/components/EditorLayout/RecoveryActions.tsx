import { useState } from 'react';
import { RotateCcw, RotateCw, Undo2, RefreshCw, Copy, Check } from 'lucide-react';
import { Button } from '../ui/button';
import { toast } from '@/components/ui/toast-store';
import { copyToClipboard } from '@/lib/clipboard';
import type { Node } from '@/context/NodeContext';
import type { StackActionResult } from './EditorView';
import { buildDiagnostics } from './recovery-format';

interface RecoveryActionsProps {
    stackName: string;
    result: StackActionResult;
    activeNode: Node | null;
    backupInfo: { exists: boolean; timestamp: number | null };
    canDeploy: boolean;
    onRetry: (e: React.MouseEvent) => void;
    onRestart: (e: React.MouseEvent) => void;
    onRollback: () => void;
    onRefreshState: () => void;
    // 'inline' wraps the actions in a row (mobile card); 'list' stacks them as
    // full-width menu rows (desktop chip popover).
    variant?: 'inline' | 'list';
}

// The recovery action set shared by the mobile inline panel and the desktop
// chip popover, so retry/restart/rollback/refresh/copy have one implementation.
export function RecoveryActions({
    stackName,
    result,
    activeNode,
    backupInfo,
    canDeploy,
    onRetry,
    onRestart,
    onRollback,
    onRefreshState,
    variant = 'inline',
}: RecoveryActionsProps) {
    const [copied, setCopied] = useState(false);

    const verb = result.action;
    const showRestart = canDeploy && result.action !== 'restart';
    const showRollback = canDeploy && backupInfo.exists && result.action !== 'rollback';
    const list = variant === 'list';

    const handleCopy = async () => {
        try {
            await copyToClipboard(buildDiagnostics(stackName, result, activeNode, backupInfo));
            setCopied(true);
            toast.success('Troubleshooting details copied.');
            setTimeout(() => setCopied(false), 2000);
        } catch {
            toast.error('Could not copy troubleshooting details.');
        }
    };

    const container = list ? 'flex flex-col' : 'flex flex-wrap items-center gap-1.5';
    const secondary = list
        ? 'h-8 w-full justify-start gap-2 px-2 text-xs text-muted-foreground hover:text-foreground'
        : 'h-7 gap-1.5 text-xs text-muted-foreground hover:text-foreground';
    const primary = list
        ? 'h-8 w-full justify-start gap-2 px-2 text-xs text-foreground'
        : 'h-7 gap-1.5 text-xs';

    return (
        <div className={container}>
            {canDeploy && (
                <Button variant={list ? 'ghost' : 'outline'} size="sm" className={primary} onClick={onRetry}>
                    <RotateCcw className="h-3.5 w-3.5" />
                    Retry {verb}
                </Button>
            )}
            {showRestart && (
                <Button variant="ghost" size="sm" className={secondary} onClick={onRestart}>
                    <RotateCw className="h-3.5 w-3.5" />
                    Restart
                </Button>
            )}
            {showRollback && (
                <Button variant="ghost" size="sm" className={secondary} onClick={() => onRollback()}>
                    <Undo2 className="h-3.5 w-3.5" />
                    Roll back
                </Button>
            )}
            <Button variant="ghost" size="sm" className={secondary} onClick={onRefreshState}>
                <RefreshCw className="h-3.5 w-3.5" />
                Refresh
            </Button>
            <Button variant="ghost" size="sm" className={secondary} onClick={() => void handleCopy()}>
                {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                Copy details
            </Button>
        </div>
    );
}
