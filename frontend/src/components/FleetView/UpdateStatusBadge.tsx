import { RotateCcw, X, Loader2, Check } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { CursorProvider, Cursor, CursorFollow, CursorContainer } from '@/components/animate-ui/primitives/animate/cursor';
import type { NodeUpdateStatus } from './types';

interface UpdateStatusBadgeProps {
    status: NodeUpdateStatus['updateStatus'];
    error?: string | null;
    onRetry?: () => void;
    onDismiss?: () => void;
    operationKind?: NodeUpdateStatus['operationKind'];
}

export function UpdateStatusBadge({ status, error, onRetry, onDismiss, operationKind }: UpdateStatusBadgeProps) {
    const isReapply = operationKind === 'reapply_configuration';
    if (status === 'updating') return (
        <Badge className="text-[10px] px-1.5 py-0 h-4 bg-brand/15 text-brand border-brand/30 shrink-0">
            <Loader2 className="w-2.5 h-2.5 mr-0.5 animate-spin" /> {isReapply ? 'Reapplying' : 'Updating'}
        </Badge>
    );
    if (status === 'completed') return (
        <Badge className="text-[10px] px-1.5 py-0 h-4 bg-success-muted text-success border-success/30 shrink-0">
            <Check className="w-2.5 h-2.5 mr-0.5" /> {isReapply ? 'Reapplied' : 'Updated'}
        </Badge>
    );
    if (status === 'timeout' || status === 'failed') {
        const label = status === 'timeout' ? 'Timed out' : 'Failed';
        return (
            <CursorProvider>
                <CursorContainer className="flex items-center gap-1">
                    <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-4 shrink-0">{label}</Badge>
                    {onRetry && (
                        <button
                            onClick={(e) => { e.stopPropagation(); onRetry(); }}
                            className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                            title={isReapply ? 'Retry reapply' : 'Retry update'}
                            aria-label={isReapply ? 'Retry reapply' : 'Retry update'}
                        >
                            <RotateCcw className="w-3 h-3" strokeWidth={1.5} />
                        </button>
                    )}
                    {onDismiss && (
                        <button
                            onClick={(e) => { e.stopPropagation(); onDismiss(); }}
                            className="h-5 w-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                            title="Dismiss"
                            aria-label="Dismiss"
                        >
                            <X className="w-3 h-3" strokeWidth={1.5} />
                        </button>
                    )}
                    {error && (
                        <>
                            <Cursor>
                                <div className="h-2 w-2 rounded-full bg-destructive/60" />
                            </Cursor>
                            <CursorFollow side="bottom" sideOffset={8} align="end">
                                <div className="bg-popover/95 backdrop-blur-[10px] backdrop-saturate-[1.15] border border-card-border shadow-md rounded-lg px-3 py-2 max-w-xs" data-sn-glass="panel">
                                    <p className="font-mono tabular-nums text-xs text-stat-subtitle">{error}</p>
                                </div>
                            </CursorFollow>
                        </>
                    )}
                </CursorContainer>
            </CursorProvider>
        );
    }
    return null;
}
