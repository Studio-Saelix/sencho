import { Button } from '@/components/ui/button';
import { STATUS_DOT_CLASS } from '@/lib/statusTone';
import { cn } from '@/lib/utils';
import { isOperationRunning, operationStateWord } from './operationStatus';
import type { BootstrapOperation } from './types';

/** Stopped runs older than the active ones are listed only this many at a time. */
const RECENT_STOPPED = 3;

/**
 * Runs the hub has recorded, so an operator who closed the window can come
 * back to one: every run that still holds its server, then the latest stopped
 * ones. Each row carries the verb for its state.
 */
export function BootstrapOperationsList({
  operations,
  disabled,
  onFollow,
  onRetry,
}: {
  operations: BootstrapOperation[];
  disabled: boolean;
  onFollow: (operation: BootstrapOperation) => void;
  onRetry: (operation: BootstrapOperation) => void;
}) {
  const active = operations.filter((operation) => operation.active);
  const recent = operations.filter((operation) => !operation.active).slice(0, RECENT_STOPPED);
  const rows = [...active, ...recent];
  if (rows.length === 0) return null;

  return (
    <section className="space-y-2" aria-label="Bootstrap runs">
      <h4 className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Bootstrap runs</h4>
      <ul className="rounded-lg border border-muted bg-card/40 px-3 py-1">
        {rows.map((operation) => {
          const state = operationStateWord(operation);
          const running = isOperationRunning(operation);
          return (
            <li
              key={operation.id}
              className="flex flex-wrap items-center justify-between gap-2 border-t border-muted py-2 first:border-t-0"
              data-testid={`bootstrap-run-${operation.id}`}
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-foreground/80">{operation.targetName}</p>
                <p className="truncate font-mono text-[10px] text-stat-subtitle">
                  {operation.username}@{operation.host}:{operation.port} · {new Date(operation.updatedAt).toLocaleString()}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-stat-subtitle">
                  <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT_CLASS[state.tone])} />
                  {state.word}
                </span>
                <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={disabled} onClick={() => onFollow(operation)}>
                  {running ? 'Follow' : 'View'}
                </Button>
                {operation.actions.retry && (
                  <Button size="sm" variant="outline" className="h-7 text-xs" disabled={disabled} onClick={() => onRetry(operation)}>
                    Retry
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
