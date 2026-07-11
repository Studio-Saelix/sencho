import { createHash } from 'crypto';

export type PruneTarget = 'images' | 'volumes' | 'networks' | 'containers';
export type PruneScope = 'managed' | 'all';

export interface PrunePlanItem {
  target: PruneTarget;
  id: string;
  name: string;
  sizeBytes?: number;
}

export interface PrunePlan {
  scope: PruneScope;
  /** Ordered execution sequence (dependency-safe when multi-target). */
  targets: PruneTarget[];
  items: PrunePlanItem[];
  reclaimableBytes: number;
  /** sha256 of sorted `target:id` pairs + scope + targets + nodeId. */
  fingerprint: string;
  createdAt: number;
  nodeId: number;
}

export type PruneItemOutcome =
  | { id: string; target: PruneTarget; status: 'removed'; sizeBytes?: number }
  | { id: string; target: PruneTarget; status: 'skipped'; reason: string }
  | { id: string; target: PruneTarget; status: 'failed'; error: string };

export const PRUNE_TARGETS: readonly PruneTarget[] = ['images', 'volumes', 'networks', 'containers'];

/** Safe multi-target order: volumes while containers still hold refs, then containers, then images. */
export const PRUNE_EXECUTION_ORDER: readonly PruneTarget[] = ['volumes', 'containers', 'images', 'networks'];

export const PRUNEABLE_CONTAINER_STATES = new Set(['created', 'exited', 'dead']);

export function isPruneTarget(value: unknown): value is PruneTarget {
  return typeof value === 'string' && (PRUNE_TARGETS as readonly string[]).includes(value);
}

/**
 * Single-target plans keep caller order. Multi-target plans normalize to the
 * dependency-safe sequence so reclaim never deletes a volume still held by a
 * planned container, and images become free after planned container removals.
 */
export function normalizePruneTargets(targets: PruneTarget[]): PruneTarget[] {
  const unique = [...new Set(targets)];
  if (unique.length <= 1) return unique;
  const rank = new Map(PRUNE_EXECUTION_ORDER.map((t, i) => [t, i]));
  return unique.sort((a, b) => (rank.get(a) ?? 99) - (rank.get(b) ?? 99));
}

export function fingerprintPrunePlan(
  nodeId: number,
  scope: PruneScope,
  targets: PruneTarget[],
  items: Pick<PrunePlanItem, 'target' | 'id'>[],
): string {
  const lines = items
    .map((item) => `${item.target}:${item.id}`)
    .sort((a, b) => a.localeCompare(b));
  const canonical = `${nodeId}|${scope}|${targets.join(',')}|${lines.join('\n')}`;
  return createHash('sha256').update(canonical).digest('hex');
}

export class PrunePlanStaleError extends Error {
  readonly code = 'PRUNE_PLAN_STALE' as const;

  constructor(message = 'Prune plan is stale; refresh and confirm again') {
    super(message);
    this.name = 'PrunePlanStaleError';
  }
}
