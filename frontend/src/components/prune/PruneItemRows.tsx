import { cn, formatBytes } from '@/lib/utils';
import { pruneItemKey, type PruneItemOutcome, type PrunePlanItem } from '@/lib/prunePlan';

function shortId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12);
}

/** References, digest, driver and ownership facts for one item, one string each. */
function itemMetadata(item: PrunePlanItem): string[] {
  const values: string[] = [];
  if (item.image?.references) {
    values.push(...item.image.references.filter((reference) => reference !== item.name));
  }
  if (item.image?.digest) values.push(item.image.digest);
  if (item.image?.createdAt) values.push(new Date(item.image.createdAt * 1000).toLocaleString());
  if (item.volume?.driver) values.push(`driver ${item.volume.driver}`);
  if (item.network?.driver) values.push(`driver ${item.network.driver}`);
  if (item.network?.scope) values.push(`scope ${item.network.scope}`);
  const labels = item.volume?.ownershipLabels ?? item.network?.ownershipLabels;
  if (labels) values.push(...Object.entries(labels).map(([key, value]) => `${key}=${value}`));
  return values;
}

const OUTCOME_WORD_CLASS: Record<PruneItemOutcome['status'], string> = {
  removed: 'text-success',
  skipped: 'text-warning',
  failed: 'text-destructive',
};

function outcomeDetail(item: PrunePlanItem, outcome: PruneItemOutcome | undefined): string {
  if (outcome?.status === 'skipped') return outcome.reason;
  if (outcome?.status === 'failed') return outcome.error;
  return item.reason;
}

export interface PruneItemRowsProps {
  items: readonly PrunePlanItem[];
  /** Outcomes of a finished run, keyed by `pruneItemKey`. */
  outcomes?: ReadonlyMap<string, PruneItemOutcome>;
  /**
   * `summary` is one line per item (target, name, size) for a confirmation;
   * `full` adds ownership, the short id, stack, metadata, the reason and any
   * outcome, for reviewing a plan or its result.
   */
  detail?: 'summary' | 'full';
  className?: string;
}

/**
 * The evidence list for a prune plan: flat hairline rows, no card per item. One
 * component renders it for every surface that shows a plan (the Resources
 * confirmation and the Fleet Reclaim review), so the two never name the same
 * item differently.
 */
export function PruneItemRows({ items, outcomes, detail = 'full', className }: PruneItemRowsProps) {
  return (
    <ul data-testid="prune-item-rows" className={cn('flex flex-col', className)}>
      {items.map((item) => {
        const outcome = outcomes?.get(pruneItemKey(item.target, item.id));
        const sized = item.sizeBytes != null && item.sizeBytes > 0;
        if (detail === 'summary') {
          return (
            <li key={`${item.target}:${item.id}`} className="border-t border-hairline py-1 font-mono text-[12px] text-stat-subtitle/90 first:border-t-0">
              <span className="block truncate">
                <span className="text-stat-subtitle/60">{item.target}</span>
                {' · '}
                {item.name}
                {sized ? ` · ${formatBytes(item.sizeBytes ?? 0)}` : ''}
              </span>
              {(item.image?.references ?? []).filter((reference) => reference !== item.name).map((reference) => (
                <span key={reference} className="block break-all">{reference}</span>
              ))}
            </li>
          );
        }
        return (
          <li key={`${item.target}:${item.id}`} className="border-t border-hairline py-2 first:border-t-0">
            <div className="flex items-start gap-2 max-md:flex-col">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="break-all font-mono text-xs text-stat-value">{item.name}</span>
                  <span className={cn(
                    'font-mono text-[10px] uppercase tracking-[0.14em]',
                    item.managed ? 'text-stat-subtitle' : 'text-warning',
                  )}>
                    {item.managed ? 'managed' : 'unmanaged'}
                  </span>
                  {outcome && (
                    <span className={cn('font-mono text-[10px] uppercase tracking-[0.14em]', OUTCOME_WORD_CLASS[outcome.status])}>
                      {outcome.status}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 break-all font-mono text-[10px] text-stat-subtitle">
                  {shortId(item.id)}{item.stackName ? ` · stack ${item.stackName}` : ''}
                </p>
                {itemMetadata(item).map((value) => (
                  <p key={value} className="mt-0.5 break-all font-mono text-[10px] text-stat-icon">{value}</p>
                ))}
                <p className="mt-1 text-[11px] text-stat-subtitle">{outcomeDetail(item, outcome)}</p>
              </div>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-stat-value">
                {item.sizeBytes == null ? 'size unavailable' : formatBytes(item.sizeBytes)}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
