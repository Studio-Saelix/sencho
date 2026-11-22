import { Disclosure } from '@/components/ui/disclosure';
import { PruneItemRows } from '@/components/prune/PruneItemRows';
import { plural } from '@/lib/blueprintTargets';
import { formatBytes } from '@/lib/utils';
import {
  pruneItemKey,
  type FleetPruneNodeResult,
  type FleetPruneTarget,
  type PruneItemOutcome,
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

/** Volumes and networks report no size, so a node whose plan has none counts items instead of showing 0 B. */
function planSize(plan: FleetPruneNodeResult): string {
  const bytes = plan.reclaimableBytes ?? 0;
  const items = plan.items?.length ?? 0;
  return bytes > 0 || items === 0 ? formatBytes(bytes) : plural(items, 'item');
}

function executionSize(execution: FleetPruneNodeResult): string {
  const bytes = execution.reclaimedBytes ?? 0;
  const removed = execution.outcomes?.filter((outcome) => outcome.status === 'removed').length ?? 0;
  return bytes > 0 || removed === 0 ? formatBytes(bytes) : `${removed} removed`;
}

/** Counts the items a finished node failed or skipped, so a collapsed node still shows its exceptions. */
function unremovedSummary(outcomes: PruneItemOutcome[]): string | undefined {
  const skipped = outcomes.filter((outcome) => outcome.status === 'skipped').length;
  const failed = outcomes.filter((outcome) => outcome.status === 'failed').length;
  const parts = [failed > 0 && `${failed} failed`, skipped > 0 && `${skipped} skipped`].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** The quiet qualifier on a node row: its error, or the exceptions of a finished run. */
function executionMeta(execution: FleetPruneNodeResult | undefined): string | undefined {
  if (execution?.error) return 'error';
  if (execution?.outcomes) return unremovedSummary(execution.outcomes);
  return undefined;
}

function NodePlan({ plan, execution, solo }: { plan: FleetPruneNodeResult; execution?: FleetPruneNodeResult; solo: boolean }) {
  if (!plan.reachable || !plan.fingerprint) {
    return (
      <div className="border-t border-hairline py-2 first:border-t-0">
        <div className="font-mono text-xs text-stat-value">{plan.nodeName} · excluded</div>
        <p className="mt-1 text-[11px] text-stat-subtitle">{plan.error ?? 'Node was unreachable during the dry run.'}</p>
      </div>
    );
  }
  const items = plan.items ?? [];
  const outcomesByItem = new Map<string, PruneItemOutcome>(
    execution?.outcomes?.map((outcome) => [pruneItemKey(outcome.target, outcome.id), outcome]) ?? [],
  );
  return (
    <Disclosure
      variant="row"
      defaultOpen={solo}
      className="border-t border-hairline first:border-t-0"
      // The only reachable node opens to its items, and its total is already the status block's answer, so it is not stated again here.
      label={solo ? plan.nodeName : `${plan.nodeName} · ${execution ? executionSize(execution) : planSize(plan)}`}
      meta={executionMeta(execution)}
    >
      {execution?.error && (
        <p className="font-mono text-[11px] text-destructive">{execution.error}</p>
      )}
      {(['images', 'volumes', 'networks'] as FleetPruneTarget[]).map((target) => {
        const targetItems = items.filter((item) => item.target === target);
        const bytes = targetItems.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
        return (
          <section key={target}>
            <h4 className="font-mono text-[10px] uppercase tracking-[0.18em] text-stat-subtitle">
              {TARGET_LABELS[target]} · {targetItems.length}{bytes > 0 || targetItems.length === 0 ? ` · ${formatBytes(bytes)}` : ''}
            </h4>
            {targetItems.length > 0 && <PruneItemRows items={targetItems} outcomes={outcomesByItem} className="mt-1" />}
          </section>
        );
      })}
      {execution && !execution.error && !execution.outcomes && (
        <p className="text-[11px] text-stat-subtitle">
          This node reported {formatBytes(execution.reclaimedBytes ?? 0)} reclaimed without itemized outcomes.
        </p>
      )}
    </Disclosure>
  );
}

export function PrunePlanResults({ planResults, executeResults }: Props) {
  const executionByNode = new Map(executeResults?.map((result) => [result.nodeId, result]));
  // The only reachable node opens straight to its items; several stay collapsed so a long fleet stays scannable.
  const reachable = planResults.filter((plan) => plan.reachable && plan.fingerprint).length;
  return (
    <div className="flex flex-col">
      {planResults.map((plan) => (
        <NodePlan key={plan.nodeId} plan={plan} execution={executionByNode.get(plan.nodeId)} solo={reachable === 1} />
      ))}
    </div>
  );
}
