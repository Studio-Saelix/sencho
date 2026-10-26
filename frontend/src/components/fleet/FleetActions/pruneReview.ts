import type { FleetNode } from '@/components/FleetView/types';
import type { FleetPruneNodeResult, FleetPruneTarget } from '@/lib/prunePlan';
import { isPruneItemOutcome, isPrunePlanItem } from '@/lib/prunePlan';

export interface ReviewedPlanState {
  key: string;
  results: FleetPruneNodeResult[];
}

export function reviewStateIsValid(
  reviewed: ReviewedPlanState | null,
  reviewKey: string,
  nodes: FleetNode[],
  selectedTargets: FleetPruneTarget[],
): reviewed is ReviewedPlanState {
  if (!reviewed || reviewed.key !== reviewKey || reviewed.results.length !== nodes.length) return false;
  const currentIds = new Set(nodes.map((node) => node.id));
  const resultIds = new Set(reviewed.results.map((result) => result.nodeId));
  return resultIds.size === reviewed.results.length
    && reviewed.results.every((result) => currentIds.has(result.nodeId)
    && (result.reachable
      ? typeof result.fingerprint === 'string' && result.fingerprint.length > 0
        && Array.isArray(result.items) && result.items.every((item) => isPrunePlanItem(item) && selectedTargets.includes(item.target as FleetPruneTarget))
      : !result.fingerprint));
}

export function executeResultsAreValid(
  value: unknown,
  reviewedResults: FleetPruneNodeResult[],
  selectedTargets: FleetPruneTarget[],
): value is FleetPruneNodeResult[] {
  if (!Array.isArray(value)) return false;
  const expectedIds = reviewedResults.filter((result) => result.reachable).map((result) => result.nodeId);
  if (value.length !== expectedIds.length) return false;
  const seen = new Set<number>();
  return value.every((result) => {
    if (!result || typeof result !== 'object') return false;
    const entry = result as Partial<FleetPruneNodeResult>;
    if (!Number.isInteger(entry.nodeId) || seen.has(entry.nodeId as number)) return false;
    seen.add(entry.nodeId as number);
    if (!expectedIds.includes(entry.nodeId as number)) return false;
    if (typeof entry.nodeName !== 'string' || typeof entry.reachable !== 'boolean' || !Array.isArray(entry.targets)) return false;
    const targetIds = new Set<FleetPruneTarget>();
    for (const target of entry.targets) {
      if (!target || typeof target !== 'object') return false;
      const row = target as Partial<FleetPruneNodeResult['targets'][number]>;
      if (!selectedTargets.includes(row.target as FleetPruneTarget) || targetIds.has(row.target as FleetPruneTarget)
        || typeof row.success !== 'boolean' || row.dryRun !== false
        || typeof row.reclaimedBytes !== 'number' || !Number.isFinite(row.reclaimedBytes) || row.reclaimedBytes < 0) return false;
      for (const count of [row.removed, row.skipped, row.failed]) {
        if (count !== undefined && (!Number.isInteger(count) || count < 0)) return false;
      }
      targetIds.add(row.target as FleetPruneTarget);
    }
    if (targetIds.size !== selectedTargets.length) return false;
    if (entry.reclaimedBytes !== undefined
      && (typeof entry.reclaimedBytes !== 'number' || !Number.isFinite(entry.reclaimedBytes) || entry.reclaimedBytes < 0)) return false;
    if (entry.outcomes !== undefined) {
      if (!Array.isArray(entry.outcomes) || !entry.outcomes.every(isPruneItemOutcome)) return false;
      const reviewed = reviewedResults.find((result) => result.nodeId === entry.nodeId);
      const expectedItems = new Set((reviewed?.items ?? []).map((item) => `${item.target}\0${item.id}`));
      const outcomeKeys = new Set(entry.outcomes.map((outcome) => `${outcome.target}\0${outcome.id}`));
      if (outcomeKeys.size !== entry.outcomes.length || outcomeKeys.size !== expectedItems.size
        || [...outcomeKeys].some((key) => !expectedItems.has(key))) return false;
    }
    return true;
  });
}
