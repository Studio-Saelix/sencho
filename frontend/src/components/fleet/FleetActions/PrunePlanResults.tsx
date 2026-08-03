import { cn, formatBytes } from '@/lib/utils';
import type {
  FleetPruneNodeResult,
  FleetPruneTarget,
  PruneItemOutcome,
  PrunePlanItem,
} from '@/lib/prunePlan';

const TARGET_LABELS: Record<FleetPruneTarget, string> = {
  images: 'Images',
  volumes: 'Volumes',
  networks: 'Networks',
};

interface Props {
  planResults: FleetPruneNodeResult[];
  executeResults?: FleetPruneNodeResult[];
}

function shortId(id: string): string {
  return id.replace(/^sha256:/, '').slice(0, 12);
}

function metadata(item: PrunePlanItem): string[] {
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

function OutcomeBadge({ outcome }: { outcome?: PruneItemOutcome }) {
  if (!outcome) return null;
  const tone = outcome.status === 'removed'
    ? 'border-success/40 bg-success/10 text-success'
    : outcome.status === 'skipped'
      ? 'border-warning/40 bg-warning/10 text-warning'
      : 'border-destructive/40 bg-destructive/10 text-destructive';
  return (
    <span className={cn('rounded-sm border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em]', tone)}>
      {outcome.status}
    </span>
  );
}

function ItemRow({ item, outcome }: { item: PrunePlanItem; outcome?: PruneItemOutcome }) {
  const detail = outcome?.status === 'skipped'
    ? outcome.reason
    : outcome?.status === 'failed'
      ? outcome.error
      : item.reason;
  return (
    <li className="rounded border border-card-border/50 bg-card/40 px-2.5 py-2">
      <div className="flex items-start gap-2 max-md:flex-col">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="break-all font-mono text-xs text-stat-value">{item.name}</span>
            <span className={cn(
              'rounded-sm border px-1 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em]',
              item.managed
                ? 'border-success/40 bg-success/10 text-success'
                : 'border-warning/40 bg-warning/10 text-warning',
            )}>
              {item.managed ? 'managed' : 'unmanaged'}
            </span>
            <OutcomeBadge outcome={outcome} />
          </div>
          <p className="mt-1 break-all font-mono text-[10px] text-stat-subtitle">
            {shortId(item.id)}{item.stackName ? ` · stack ${item.stackName}` : ''}
          </p>
          {metadata(item).map((value) => (
            <p key={value} className="mt-0.5 break-all font-mono text-[10px] text-stat-icon">{value}</p>
          ))}
          <p className="mt-1 text-[11px] text-stat-subtitle">{detail}</p>
        </div>
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-stat-value">
          {item.sizeBytes == null ? 'size unavailable' : formatBytes(item.sizeBytes)}
        </span>
      </div>
    </li>
  );
}

function NodePlan({ plan, execution }: { plan: FleetPruneNodeResult; execution?: FleetPruneNodeResult }) {
  if (!plan.reachable || !plan.fingerprint) {
    return (
      <div className="rounded border border-card-border/60 bg-card/30 p-2.5">
        <div className="font-mono text-xs text-stat-value">{plan.nodeName} · excluded</div>
        <p className="mt-1 text-[11px] text-stat-subtitle">{plan.error ?? 'Node was unreachable during the dry run.'}</p>
      </div>
    );
  }
  const items = plan.items ?? [];
  const outcomesByItem = new Map<string, PruneItemOutcome>(
    execution?.outcomes?.map((outcome) => [`${outcome.target}\0${outcome.id}`, outcome]) ?? [],
  );
  return (
    <details open className="rounded border border-card-border/60 bg-card/30">
      <summary className="cursor-pointer px-2.5 py-2 font-mono text-xs text-stat-value">
        {plan.nodeName} · {formatBytes(execution?.reclaimedBytes ?? plan.reclaimableBytes ?? 0)}
      </summary>
      <div className="space-y-2 border-t border-card-border/50 p-2.5">
        {execution?.error && (
          <p className="rounded border border-destructive/40 bg-destructive/10 p-2 text-[11px] text-destructive">
            {execution.error}
          </p>
        )}
        {(['images', 'volumes', 'networks'] as FleetPruneTarget[]).map((target) => {
          const targetItems = items.filter((item) => item.target === target);
          const bytes = targetItems.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
          return (
            <details key={target} open={targetItems.length > 0} className="rounded border border-card-border/40">
              <summary className="cursor-pointer px-2 py-1.5 font-mono text-[11px] text-stat-subtitle">
                {TARGET_LABELS[target]} · {targetItems.length} · {formatBytes(bytes)}
              </summary>
              {targetItems.length > 0 && (
                <ul className="space-y-1.5 border-t border-card-border/40 p-2">
                  {targetItems.map((item) => (
                    <ItemRow
                      key={`${item.target}:${item.id}`}
                      item={item}
                      outcome={outcomesByItem.get(`${item.target}\0${item.id}`)}
                    />
                  ))}
                </ul>
              )}
            </details>
          );
        })}
        {execution && !execution.error && !execution.outcomes && (
          <p className="text-[11px] text-stat-subtitle">
            This node reported {formatBytes(execution.reclaimedBytes ?? 0)} reclaimed without itemized outcomes.
          </p>
        )}
      </div>
    </details>
  );
}

export function PrunePlanResults({ planResults, executeResults }: Props) {
  const executionByNode = new Map(executeResults?.map((result) => [result.nodeId, result]));
  return (
    <div className="space-y-2">
      {planResults.map((plan) => (
        <NodePlan key={plan.nodeId} plan={plan} execution={executionByNode.get(plan.nodeId)} />
      ))}
    </div>
  );
}
