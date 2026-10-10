import type { PostureReason, PostureTarget } from '@/types/security';

/** A stack service an exposure or update verb can act on. */
export interface StackServiceRef {
  stack: string;
  service: string;
}

export type ReasonVerb =
  /** Review the stack's update readiness, then update it. */
  | { kind: 'review-update'; label: string; clicks: 2; stacks: string[] }
  /** Classify what each listed service publishes. */
  | { kind: 'set-exposure-intent'; label: string; clicks: 2; services: StackServiceRef[] }
  | { kind: 'check-again'; label: string; clicks: 1 }
  | { kind: 'rescan-node'; label: string; clicks: 1 }
  /** Go to the reason's own tab, as before. */
  | { kind: 'navigate'; label: string; clicks: 1 };

/** What the account and the node allow; each field mirrors the route guard of the verb it enables. */
export interface ReasonVerbContext {
  /** `node:manage` on the active node: update recheck. */
  canManageNode: boolean;
  /** Global `node:manage`: the node scan route takes no resource, so a node-scoped grant does not pass it. */
  canScanNode: boolean;
  /** `stack:deploy` on the stack: the update route. */
  canDeployStack: (stack: string) => boolean;
  /** `stack:edit` on the stack: the exposure intent route. */
  canEditStack: (stack: string) => boolean;
  /** The scanner is installed and usable on this node. */
  scannerAvailable: boolean;
  updateChecksDisabled: boolean;
  /** A replica node takes triage from its control instance. */
  isReplica: boolean;
}

function uniqueStacks(targets: readonly PostureTarget[], allowed: (stack: string) => boolean): string[] {
  const stacks = targets.flatMap(target => (target.stackName !== undefined && allowed(target.stackName) ? [target.stackName] : []));
  return [...new Set(stacks)].sort();
}

function uniqueServices(targets: readonly PostureTarget[], allowed: (stack: string) => boolean): StackServiceRef[] {
  const seen = new Set<string>();
  const services: StackServiceRef[] = [];
  for (const target of targets) {
    if (target.stackName === undefined || target.serviceName === undefined || !allowed(target.stackName)) continue;
    const id = `${target.stackName}\u0000${target.serviceName}`;
    if (seen.has(id)) continue;
    seen.add(id);
    services.push({ stack: target.stackName, service: target.serviceName });
  }
  return services;
}

/**
 * The verb a reason carries, decided from its kind and structured targets.
 * Pure and never reads message text. A verb the account cannot run falls back to
 * the reason's own navigation, so a button never answers 403; an older remote that
 * sends image-only targets resolves to navigation for the same reason.
 * Returns null where the reason has nothing to offer (triage on a replica).
 */
export function resolveReasonVerb(reason: PostureReason, ctx: ReasonVerbContext, navigateLabel: string): ReasonVerb | null {
  const fallback: ReasonVerb = { kind: 'navigate', label: navigateLabel, clicks: 1 };
  const targets = reason.targets ?? [];
  switch (reason.kind) {
    case 'fixable_cve': {
      const stacks = uniqueStacks(targets, ctx.canDeployStack);
      return stacks.length > 0 ? { kind: 'review-update', label: 'Review update', clicks: 2, stacks } : fallback;
    }
    case 'public_exposure': {
      const services = uniqueServices(targets, ctx.canEditStack);
      return services.length > 0 ? { kind: 'set-exposure-intent', label: 'Set exposure intent', clicks: 2, services } : fallback;
    }
    case 'update_check_uncertain':
      return ctx.canManageNode && !ctx.updateChecksDisabled ? { kind: 'check-again', label: 'Check again', clicks: 1 } : fallback;
    case 'stale_scan':
      return ctx.canScanNode && ctx.scannerAvailable ? { kind: 'rescan-node', label: 'Rescan node', clicks: 1 } : fallback;
    case 'needs_review':
      return ctx.isReplica ? null : { kind: 'navigate', label: 'Triage', clicks: 1 };
    case 'failed_scan':
      return { kind: 'navigate', label: 'Open History', clicks: 1 };
    default:
      return fallback;
  }
}
