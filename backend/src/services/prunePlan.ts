import { createHash } from 'crypto';

export type PruneTarget = 'images' | 'volumes' | 'networks' | 'containers';
export type PruneScope = 'managed' | 'all';

interface PrunePlanItemBase {
  id: string;
  name: string;
  sizeBytes?: number;
  managed: boolean;
  reason: string;
  stackName?: string;
}

export type PrunePlanItem =
  | (PrunePlanItemBase & { target: 'containers'; image?: never; volume?: never; network?: never })
  | (PrunePlanItemBase & {
    target: 'images';
    image: {
    references: string[];
    digest?: string;
    createdAt?: number;
    };
    volume?: never;
    network?: never;
  })
  | (PrunePlanItemBase & {
    target: 'volumes';
    volume: {
    driver?: string;
    ownershipLabels?: Record<string, string>;
    };
    image?: never;
    network?: never;
  })
  | (PrunePlanItemBase & {
    target: 'networks';
    network: {
    driver?: string;
    scope?: string;
    ownershipLabels?: Record<string, string>;
    };
    image?: never;
    volume?: never;
  });

export interface PrunePlan {
  scope: PruneScope;
  /** Ordered execution sequence (dependency-safe when multi-target). */
  targets: PruneTarget[];
  items: PrunePlanItem[];
  reclaimableBytes: number;
  /**
   * sha256 of nodeId, scope, targets, and a sorted per-item identity key.
   * Non-image items use `target:id`. Images also bind digest and the full
   * sorted RepoTags set, so retagging an already-planned free image invalidates
   * the dry-run authorization (fleet preflight must reject the whole execute).
   */
  fingerprint: string;
  createdAt: number;
  nodeId: number;
}

/** Fields required to fingerprint one plan item (full PrunePlanItem is accepted). */
export type FingerprintPlanItem = {
  target: PruneTarget;
  id: string;
  image?: {
    references: string[];
    digest?: string;
  };
};

export type PruneItemOutcome =
  | { id: string; target: PruneTarget; status: 'removed'; sizeBytes?: number }
  | { id: string; target: PruneTarget; status: 'skipped'; reason: string }
  | { id: string; target: PruneTarget; status: 'failed'; error: string };

export const PRUNE_TARGETS: readonly PruneTarget[] = ['images', 'volumes', 'networks', 'containers'];

/** Safe multi-target order: volumes while containers still hold refs, then containers, then images. */
export const PRUNE_EXECUTION_ORDER: readonly PruneTarget[] = ['volumes', 'containers', 'images', 'networks'];

export const PRUNEABLE_CONTAINER_STATES = new Set(['created', 'exited', 'dead']);

const COMPOSE_OWNERSHIP_LABEL_KEYS = new Set([
  'com.docker.compose.project',
  'com.docker.compose.project.working_dir',
  'com.docker.compose.project.config_files',
  'com.docker.compose.volume',
  'com.docker.compose.network',
  'com.docker.compose.service',
]);

/**
 * Disclosure allowlist for ownership evidence returned to API clients.
 * Do not broaden it without reviewing Docker label values for sensitive data.
 */
export function projectPruneOwnershipLabels(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const projected = Object.entries(value).filter(
    (entry): entry is [string, string] => COMPOSE_OWNERSHIP_LABEL_KEYS.has(entry[0])
      && typeof entry[1] === 'string' && entry[1].length > 0,
  );
  return projected.length > 0 ? Object.fromEntries(projected) : undefined;
}

export function hasOnlyPruneOwnershipLabels(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, label]) => COMPOSE_OWNERSHIP_LABEL_KEYS.has(key) && typeof label === 'string' && label.length > 0,
  );
}

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

/**
 * Canonical identity line for one planned resource. Image lines include the
 * full reviewed reference set so a tag add/remove on the same image Id is
 * detectable as plan drift (not merely an Id match).
 */
export function fingerprintPlanItemKey(item: FingerprintPlanItem): string {
  if (item.target === 'images') {
    const refs = [...(item.image?.references ?? [])]
      .filter((ref) => Boolean(ref) && ref !== '<none>:<none>')
      .sort((a, b) => a.localeCompare(b));
    const digest = item.image?.digest ?? '';
    return `images:${item.id}\t${digest}\t${refs.join('\t')}`;
  }
  return `${item.target}:${item.id}`;
}

export function fingerprintPrunePlan(
  nodeId: number,
  scope: PruneScope,
  targets: PruneTarget[],
  items: FingerprintPlanItem[],
): string {
  const lines = items
    .map((item) => fingerprintPlanItemKey(item))
    .sort((a, b) => a.localeCompare(b));
  const canonical = `${nodeId}|${scope}|${targets.join(',')}|${lines.join('\n')}`;
  return createHash('sha256').update(canonical).digest('hex');
}

/** Sorted live RepoTags comparable to a plan item's image.references. */
export function normalizePruneImageReferences(refs: string[] | null | undefined): string[] {
  if (!refs) return [];
  return [...refs]
    .filter((ref) => Boolean(ref) && ref !== '<none>:<none>')
    .sort((a, b) => a.localeCompare(b));
}

export function pruneImageReferencesEqual(
  planned: string[] | null | undefined,
  live: string[] | null | undefined,
): boolean {
  const a = normalizePruneImageReferences(planned);
  const b = normalizePruneImageReferences(live);
  if (a.length !== b.length) return false;
  return a.every((ref, index) => ref === b[index]);
}

export class PrunePlanStaleError extends Error {
  readonly code = 'PRUNE_PLAN_STALE' as const;

  constructor(message = 'Prune plan is stale; refresh and confirm again') {
    super(message);
    this.name = 'PrunePlanStaleError';
  }
}
