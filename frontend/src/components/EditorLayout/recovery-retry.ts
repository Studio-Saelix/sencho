import type { RecoverableAction } from './EditorView';

// The stack action handlers the recovery panel routes "Retry" to. Shared by
// both detail surfaces (desktop EditorView and MobileStackDetail) so the
// action-to-handler mapping lives in one place.
export interface RetryHandlers {
    deployStack: (e: React.MouseEvent) => void;
    restartStack: (e: React.MouseEvent) => void;
    updateStack: (e?: React.MouseEvent) => void;
    rollbackStack: () => void;
}

// Resolve the retry handler for a recoverable action. Rollback takes no event,
// so it is wrapped to match the panel's onRetry signature.
export function retryHandlerFor(
    action: RecoverableAction,
    handlers: RetryHandlers,
): (e: React.MouseEvent) => void {
    switch (action) {
        case 'deploy':
            return handlers.deployStack;
        case 'restart':
            return handlers.restartStack;
        case 'rollback':
            return () => handlers.rollbackStack();
        case 'update':
            return handlers.updateStack;
    }
}
