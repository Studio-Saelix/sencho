import type { StatusPathAnswer } from '@/components/ui/status-path';
import { plural } from '@/lib/blueprintTargets';
import type { FleetPruneNodeResult } from '@/lib/prunePlan';
import { formatBytes } from '@/lib/utils';

export interface PlanSummary {
  reachable: number;
  unreachable: number;
  items: number;
  bytes: number;
  unsized: number;
}

export function summarizePlan(results: FleetPruneNodeResult[]): PlanSummary {
  const reachable = results.filter((result) => result.reachable);
  const items = reachable.flatMap((result) => result.items ?? []);
  return {
    reachable: reachable.length,
    unreachable: results.length - reachable.length,
    items: items.length,
    bytes: reachable.reduce((sum, result) => sum + (result.reclaimableBytes ?? 0), 0),
    unsized: items.filter((item) => item.sizeBytes == null).length,
  };
}

/** The Answer for a reviewed plan: what Prune will do, and what the plan could not cover. */
export function planAnswer(summary: PlanSummary, notice: string | null): StatusPathAnswer {
  const marker = summary.unreachable > 0 ? `${summary.unreachable} unreachable, left out` : undefined;
  const sizeNote = summary.unsized > 0 ? `${plural(summary.unsized, 'item')} reported no size.` : null;
  const detail = [notice, sizeNote].filter(Boolean).join(' ') || null;
  if (summary.reachable === 0) {
    return { tone: 'warning', title: 'No node reachable', line: 'No node could be reviewed, so nothing can be pruned.', marker, detail };
  }
  if (summary.items === 0) {
    return { tone: 'neutral', title: 'Nothing to reclaim', line: `${plural(summary.reachable, 'node')} reviewed, no unused resources found.`, marker, detail };
  }
  return {
    tone: 'warning',
    title: `${formatBytes(summary.bytes)} to reclaim`,
    line: `${plural(summary.items, 'item')} on ${plural(summary.reachable, 'node')}`,
    marker,
    detail,
  };
}

export interface OutcomeSummary {
  answer: StatusPathAnswer;
  /** The first node whose plan changed between review and execution, when any did. */
  stale: FleetPruneNodeResult | undefined;
  removedAny: boolean;
  failedAny: boolean;
  reclaimed: number;
}

/** The Answer once Prune has run: bytes reclaimed, with skipped or failed items named. */
export function outcomeSummary(results: FleetPruneNodeResult[]): OutcomeSummary {
  const outcomes = results.flatMap((result) => result.outcomes ?? []);
  const removed = outcomes.filter((outcome) => outcome.status === 'removed').length;
  const skipped = outcomes.filter((outcome) => outcome.status === 'skipped').length;
  const failed = outcomes.filter((outcome) => outcome.status === 'failed').length;
  const reclaimed = results.reduce((sum, result) => sum + (result.reclaimedBytes ?? 0), 0);
  const stale = results.find((result) => result.code === 'PRUNE_PLAN_STALE');
  const failedAny = results.some((result) => result.targets.some((target) => !target.success));
  const removedAny = removed > 0;
  const marker = [failed > 0 && `${failed} failed`, skipped > 0 && `${skipped} skipped`].filter(Boolean).join(' · ') || undefined;
  const nodes = plural(results.length, 'node');
  const line = outcomes.length > 0 ? `${plural(removed, 'item')} removed on ${nodes}` : `Across ${nodes}`;

  if (stale && !removedAny) {
    return {
      answer: { tone: 'destructive', title: 'Nothing was pruned', line: `The plan changed on “${stale.nodeName}” after it was built.`, marker },
      stale, removedAny, failedAny, reclaimed,
    };
  }
  if (stale || failedAny) {
    const title = stale ? `Partly pruned, ${formatBytes(reclaimed)} reclaimed` : `${formatBytes(reclaimed)} reclaimed with failures`;
    const detail = stale ? `The plan changed on “${stale.nodeName}” after it was built.` : undefined;
    return { answer: { tone: 'warning', title, line, marker, detail }, stale, removedAny, failedAny, reclaimed };
  }
  return { answer: { tone: 'success', title: `Reclaimed ${formatBytes(reclaimed)}`, line, marker }, stale, removedAny, failedAny, reclaimed };
}
