import { Button } from '@/components/ui/button';
import { STATUS_DOT_CLASS } from '@/lib/statusTone';
import { cn } from '@/lib/utils';
import { isOperationRunning, operationStateWord } from './operationStatus';
import type { BootstrapOperation } from './types';

/**
 * How many of the latest stopped runs are listed after the ones still holding a
 * server. Only finished runs are cut. Holds are the way back to a run that needs
 * recovery, so none is dropped: they arrive a page at a time, and the list
 * offers the next page for as long as there is one.
 */
const RECENT_STOPPED = 3;

/**
 * Runs the hub has recorded, so an operator who closed the window can come
 * back to one: the runs that still hold their server (more of them on request),
 * then the latest stopped ones. Each row carries the verb for its state.
 */
export function BootstrapOperationsList({
  operations,
  loadFailed,
  disabled,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  onFollow,
  onRetry,
}: {
  operations: BootstrapOperation[];
  /** The list could not be loaded, so a run holding a server may be missing from it. */
  loadFailed: boolean;
  disabled: boolean;
  /** More runs that hold a server are waiting on the hub. */
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  onFollow: (operation: BootstrapOperation) => void;
  onRetry: (operation: BootstrapOperation) => void;
}) {
  const active = operations.filter((operation) => operation.active);
  const finished = operations.filter((operation) => !operation.active);
  const recent = finished.slice(0, RECENT_STOPPED);
  const rows = [...active, ...recent];
  // A failed refresh keeps the rows already loaded and says the list may be stale.
  const unavailable = loadFailed ? (
    <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle" data-testid="bootstrap-runs-unavailable">
      {rows.length > 0 ? 'Bootstrap runs could not be refreshed.' : 'Earlier bootstrap runs could not be loaded.'}
    </p>
  ) : null;
  if (rows.length === 0) return unavailable;

  return (
    <section className="space-y-2" aria-label="Bootstrap runs">
      <h4 className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">Bootstrap runs</h4>
      {unavailable}
      <ul className="max-h-72 overflow-y-auto rounded-lg border border-muted bg-card/40 px-3 py-1" data-testid="bootstrap-runs-list">
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
      {hasMore && onLoadMore && (
        <Button size="sm" variant="outline" className="h-7 text-xs" disabled={disabled || loadingMore} onClick={onLoadMore} data-testid="bootstrap-runs-more">
          {loadingMore ? 'Loading…' : 'Show more runs that hold a server'}
        </Button>
      )}
      {finished.length > recent.length && (
        <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle" data-testid="bootstrap-runs-older-hidden">
          Showing the latest {RECENT_STOPPED} finished runs. Runs that still hold a server are all reachable.
        </p>
      )}
    </section>
  );
}
