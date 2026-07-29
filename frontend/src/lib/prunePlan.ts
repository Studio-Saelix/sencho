export type PruneTarget = 'containers' | 'images' | 'volumes' | 'networks';
export type FleetPruneTarget = Exclude<PruneTarget, 'containers'>;
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
  targets: PruneTarget[];
  items: PrunePlanItem[];
  reclaimableBytes: number;
  fingerprint: string;
  createdAt: number;
  nodeId: number;
}

export type PruneItemOutcome =
  | { id: string; target: PruneTarget; status: 'removed'; sizeBytes?: number }
  | { id: string; target: PruneTarget; status: 'skipped'; reason: string }
  | { id: string; target: PruneTarget; status: 'failed'; error: string };

export interface FleetPruneTargetResult {
  target: FleetPruneTarget;
  success: boolean;
  reclaimedBytes: number;
  dryRun: boolean;
  removed?: number;
  skipped?: number;
  failed?: number;
  error?: string;
}

export interface FleetPruneNodeResult {
  nodeId: number;
  nodeName: string;
  reachable: boolean;
  code?: string;
  error?: string;
  fingerprint?: string;
  items?: PrunePlanItem[];
  reclaimableBytes?: number;
  reclaimedBytes?: number;
  outcomes?: PruneItemOutcome[];
  targets: FleetPruneTargetResult[];
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function isPrunePlanItem(value: unknown): value is PrunePlanItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (typeof item.id !== 'string' || typeof item.name !== 'string'
    || typeof item.managed !== 'boolean' || typeof item.reason !== 'string'
    || (item.sizeBytes !== undefined && !finiteNonnegative(item.sizeBytes))) return false;
  if (item.target === 'containers') return true;
  if (item.target === 'images') {
    const image = item.image as Record<string, unknown> | undefined;
    return Boolean(image && Array.isArray(image.references) && image.references.every((ref) => typeof ref === 'string'));
  }
  if (item.target === 'volumes') return Boolean(item.volume && typeof item.volume === 'object');
  if (item.target === 'networks') return Boolean(item.network && typeof item.network === 'object');
  return false;
}

export function isPruneItemOutcome(value: unknown): value is PruneItemOutcome {
  if (!value || typeof value !== 'object') return false;
  const outcome = value as Record<string, unknown>;
  if (typeof outcome.id !== 'string' || typeof outcome.target !== 'string') return false;
  if (outcome.status === 'removed') return outcome.sizeBytes === undefined || finiteNonnegative(outcome.sizeBytes);
  if (outcome.status === 'skipped') return typeof outcome.reason === 'string';
  if (outcome.status === 'failed') return typeof outcome.error === 'string';
  return false;
}

export function isPrunePlan(value: unknown): value is PrunePlan {
  if (!value || typeof value !== 'object') return false;
  const plan = value as Partial<PrunePlan>;
  if ((plan.scope !== 'managed' && plan.scope !== 'all') || !Array.isArray(plan.targets)
    || new Set(plan.targets).size !== plan.targets.length || !Array.isArray(plan.items)
    || !finiteNonnegative(plan.reclaimableBytes) || typeof plan.fingerprint !== 'string'
    || plan.fingerprint.length === 0 || !Number.isInteger(plan.nodeId)
    || !finiteNonnegative(plan.createdAt)) return false;
  const targets = new Set<PruneTarget>(plan.targets);
  const itemKeys = new Set<string>();
  let total = 0;
  for (const item of plan.items) {
    if (!isPrunePlanItem(item) || !targets.has(item.target)) return false;
    const key = `${item.target}\0${item.id}`;
    if (itemKeys.has(key)) return false;
    itemKeys.add(key);
    total += item.sizeBytes ?? 0;
  }
  return total === plan.reclaimableBytes;
}
