import type { Node } from '../services/DatabaseService';
import DockerController from '../services/DockerController';
import { FileSystemService } from '../services/FileSystemService';
import { NodeRegistry } from '../services/NodeRegistry';
import { safeRemoteFetch } from '../utils/outboundTarget';
import { ServiceUpdateRecoveryService } from '../services/ServiceUpdateRecoveryService';
import {
  PrunePlanStaleError,
  hasOnlyPruneOwnershipLabels,
  projectPruneOwnershipLabels,
  type PruneItemOutcome,
  type PrunePlan,
  type PrunePlanItem,
  type PruneScope,
} from '../services/prunePlan';
import { invalidateNodeCaches } from './cacheInvalidation';
import { getErrorMessage } from '../utils/errors';
import { TimeoutError, withTimeout } from '../utils/withTimeout';
import { formatNoTargetError } from '../utils/remoteTarget';
import { sanitizeForLog } from '../utils/safeLog';

export const FLEET_PRUNE_TARGETS = ['images', 'volumes', 'networks'] as const;
export type FleetPruneTarget = (typeof FLEET_PRUNE_TARGETS)[number];

export interface ReviewedFleetNode {
  nodeId: number;
  reachable: boolean;
}

export interface ReviewedFleetPlan {
  nodeId: number;
  fingerprint: string;
}

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

export type ParsedFleetPruneRequest = {
  targets: FleetPruneTarget[];
  scope: PruneScope;
  dryRun: boolean;
  reviewedNodes: ReviewedFleetNode[];
  plans: ReviewedFleetPlan[];
};

type ParseResult = { request: ParsedFleetPruneRequest } | { error: string };

type Preflight = {
  node: Node;
  reachable: boolean;
  plan?: PrunePlan;
  code?: string;
  error?: string;
};

type FleetPruneResponse = {
  status: number;
  body: { error?: string; code?: string; nodeId?: number; results?: FleetPruneNodeResult[] };
};

const PLAN_TIMEOUT_MS = 8_000;
const REMOTE_PLAN_TIMEOUT_MS = 120_000;
const BUSY_DAEMON_ERROR = 'Docker daemon is busy. Please try again in a moment.';

function parseTargets(value: unknown): FleetPruneTarget[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const targets = new Set<FleetPruneTarget>();
  for (const target of value) {
    if (typeof target !== 'string' || !(FLEET_PRUNE_TARGETS as readonly string[]).includes(target)) {
      return null;
    }
    targets.add(target as FleetPruneTarget);
  }
  return [...targets];
}

function parseReviewedNodes(value: unknown): ReviewedFleetNode[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const parsed: ReviewedFleetNode[] = [];
  const seen = new Set<number>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const { nodeId, reachable } = entry as { nodeId?: unknown; reachable?: unknown };
    if (!Number.isInteger(nodeId) || typeof reachable !== 'boolean' || seen.has(nodeId as number)) return null;
    seen.add(nodeId as number);
    parsed.push({ nodeId: nodeId as number, reachable });
  }
  return parsed;
}

function parsePlans(value: unknown): ReviewedFleetPlan[] | null {
  if (!Array.isArray(value)) return null;
  const parsed: ReviewedFleetPlan[] = [];
  const seen = new Set<number>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const { nodeId, fingerprint } = entry as { nodeId?: unknown; fingerprint?: unknown };
    if (!Number.isInteger(nodeId) || typeof fingerprint !== 'string' || fingerprint.trim() === '' || seen.has(nodeId as number)) {
      return null;
    }
    seen.add(nodeId as number);
    parsed.push({ nodeId: nodeId as number, fingerprint: fingerprint.trim() });
  }
  return parsed;
}

export function parseFleetPruneRequest(body: unknown): ParseResult {
  if (!body || typeof body !== 'object') return { error: 'Request body is required' };
  const input = body as Record<string, unknown>;
  const targets = parseTargets(input.targets);
  if (!targets) return { error: 'targets must be a non-empty array of images, volumes, or networks' };
  if (input.scope !== 'managed' && input.scope !== 'all') return { error: 'scope must be managed or all' };
  const scope: PruneScope = input.scope;
  const dryRun = input.dryRun === true;
  if (dryRun) return { request: { targets, scope, dryRun, reviewedNodes: [], plans: [] } };
  const reviewedNodes = parseReviewedNodes(input.reviewedNodes);
  const plans = parsePlans(input.plans);
  if (!reviewedNodes || !plans) return { error: 'reviewedNodes and plans are required for fleet prune execution' };
  return { request: { targets, scope, dryRun, reviewedNodes, plans } };
}

function validateReviewedRoster(
  nodes: Node[],
  reviewedNodes: ReviewedFleetNode[],
  plans: ReviewedFleetPlan[],
): string | null {
  const currentIds = nodes.map((node) => node.id).sort((a, b) => a - b);
  const reviewedIds = reviewedNodes.map((node) => node.nodeId).sort((a, b) => a - b);
  if (currentIds.length !== reviewedIds.length || currentIds.some((id, index) => id !== reviewedIds[index])) {
    return 'The fleet node roster changed after the dry run';
  }
  const reachableIds = reviewedNodes.filter((node) => node.reachable).map((node) => node.nodeId).sort((a, b) => a - b);
  const planIds = plans.map((plan) => plan.nodeId).sort((a, b) => a - b);
  if (reachableIds.length !== planIds.length || reachableIds.some((id, index) => id !== planIds[index])) {
    return 'Plans must exactly cover the reachable nodes from the dry run';
  }
  return null;
}

function targetRowsFromPlan(plan: PrunePlan, targets: FleetPruneTarget[]): FleetPruneTargetResult[] {
  return targets.map((target) => ({
    target,
    success: true,
    reclaimedBytes: plan.items
      .filter((item) => item.target === target)
      .reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0),
    dryRun: true,
  }));
}

function failedTargetRows(
  targets: FleetPruneTarget[],
  error: string,
  dryRun: boolean,
): FleetPruneTargetResult[] {
  return targets.map((target) => ({ target, success: false, reclaimedBytes: 0, dryRun, error }));
}

function isPrunePlan(
  value: unknown,
  targets: FleetPruneTarget[],
  scope: PruneScope,
): value is PrunePlan {
  if (!value || typeof value !== 'object') return false;
  const plan = value as Partial<PrunePlan>;
  const planTargets = Array.isArray(plan.targets) ? plan.targets : [];
  const requestedTargets = new Set(targets);
  const uniquePlanTargets = new Set(planTargets);
  const itemKeys = new Set<string>();
  const itemBytes = Array.isArray(plan.items)
    ? plan.items.reduce((sum, item) => sum + (typeof item?.sizeBytes === 'number' ? item.sizeBytes : 0), 0)
    : -1;
  return plan.scope === scope
    && planTargets.length === requestedTargets.size
    && uniquePlanTargets.size === requestedTargets.size
    && planTargets.every((target) => typeof target === 'string' && requestedTargets.has(target as FleetPruneTarget))
    && typeof plan.fingerprint === 'string'
    && plan.fingerprint.length > 0
    && Number.isInteger(plan.nodeId)
    && typeof plan.createdAt === 'number' && Number.isFinite(plan.createdAt) && plan.createdAt >= 0
    && typeof plan.reclaimableBytes === 'number' && Number.isFinite(plan.reclaimableBytes) && plan.reclaimableBytes >= 0
    && plan.reclaimableBytes === itemBytes
    && Array.isArray(plan.items)
    && plan.items.every((item) => {
      if (!isPrunePlanItem(item) || !requestedTargets.has(item.target as FleetPruneTarget)) return false;
      const key = `${item.target}\0${item.id}`;
      if (itemKeys.has(key)) return false;
      itemKeys.add(key);
      return true;
    });
}

function isPrunePlanItem(value: unknown): value is PrunePlanItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const validTarget = typeof item.target === 'string'
    && ['images', 'volumes', 'networks', 'containers'].includes(item.target);
  const validSize = item.sizeBytes === undefined
    || (typeof item.sizeBytes === 'number' && Number.isFinite(item.sizeBytes) && item.sizeBytes >= 0);
  const targetMetadata = item.target === 'images'
    ? Boolean(item.image && typeof item.image === 'object'
      && Array.isArray((item.image as { references?: unknown }).references)
      && (item.image as { references: unknown[] }).references.every((ref) => typeof ref === 'string'))
    : item.target === 'volumes'
      ? Boolean(item.volume && typeof item.volume === 'object')
      : item.target === 'networks'
        ? Boolean(item.network && typeof item.network === 'object')
        : true;
  return validTarget
    && typeof item.id === 'string'
    && typeof item.name === 'string'
    && typeof item.managed === 'boolean'
    && typeof item.reason === 'string'
    && validSize
    && targetMetadata
    && hasOnlyPruneOwnershipLabels((item.volume as { ownershipLabels?: unknown } | undefined)?.ownershipLabels)
    && hasOnlyPruneOwnershipLabels((item.network as { ownershipLabels?: unknown } | undefined)?.ownershipLabels);
}

function projectRemoteItem(item: PrunePlanItem): PrunePlanItem {
  const base = {
    id: item.id,
    name: item.name,
    managed: item.managed,
    reason: item.reason,
    ...(typeof item.sizeBytes === 'number' ? { sizeBytes: item.sizeBytes } : {}),
    ...(typeof item.stackName === 'string' ? { stackName: item.stackName } : {}),
  };
  if (item.target === 'images') {
    return { ...base, target: 'images', image: {
      references: Array.isArray(item.image.references)
        ? item.image.references.filter((reference): reference is string => typeof reference === 'string')
        : [],
      ...(typeof item.image.digest === 'string' ? { digest: item.image.digest } : {}),
      ...(typeof item.image.createdAt === 'number' ? { createdAt: item.image.createdAt } : {}),
    } };
  }
  if (item.target === 'volumes') {
    const ownershipLabels = projectPruneOwnershipLabels(item.volume.ownershipLabels);
    return { ...base, target: 'volumes', volume: {
      ...(typeof item.volume.driver === 'string' ? { driver: item.volume.driver } : {}),
      ...(ownershipLabels ? { ownershipLabels } : {}),
    } };
  }
  if (item.target === 'networks') {
    const ownershipLabels = projectPruneOwnershipLabels(item.network.ownershipLabels);
    return { ...base, target: 'networks', network: {
      ...(typeof item.network.driver === 'string' ? { driver: item.network.driver } : {}),
      ...(typeof item.network.scope === 'string' ? { scope: item.network.scope } : {}),
      ...(ownershipLabels ? { ownershipLabels } : {}),
    } };
  }
  return { ...base, target: 'containers' };
}

function projectRemotePlan(plan: PrunePlan): PrunePlan {
  return {
    scope: plan.scope,
    targets: [...plan.targets],
    items: plan.items.map(projectRemoteItem),
    reclaimableBytes: plan.reclaimableBytes,
    fingerprint: plan.fingerprint,
    createdAt: plan.createdAt,
    nodeId: plan.nodeId,
  };
}

function isPruneItemOutcome(value: unknown): value is PruneItemOutcome {
  if (!value || typeof value !== 'object') return false;
  const outcome = value as { id?: unknown; target?: unknown; status?: unknown; sizeBytes?: unknown; reason?: unknown; error?: unknown };
  if (typeof outcome.id !== 'string' || typeof outcome.target !== 'string') return false;
  if (outcome.status === 'removed') return outcome.sizeBytes === undefined
    || (typeof outcome.sizeBytes === 'number' && Number.isFinite(outcome.sizeBytes) && outcome.sizeBytes >= 0);
  if (outcome.status === 'skipped') return typeof outcome.reason === 'string';
  if (outcome.status === 'failed') return typeof outcome.error === 'string';
  return false;
}

function validateRemoteOutcomes(
  value: unknown,
  plan: PrunePlan,
  targets: FleetPruneTarget[],
): PruneItemOutcome[] | null {
  if (!Array.isArray(value) || value.length !== plan.items.length) return null;
  const requestedTargets = new Set<string>(targets);
  const expected = new Set(plan.items.map((item) => `${item.target}\0${item.id}`));
  const seen = new Set<string>();
  for (const outcome of value) {
    if (!isPruneItemOutcome(outcome) || !requestedTargets.has(outcome.target)) return null;
    const key = `${outcome.target}\0${outcome.id}`;
    if (!expected.has(key) || seen.has(key)) return null;
    seen.add(key);
  }
  return seen.size === expected.size ? value : null;
}

async function buildLocalPreflight(node: Node, targets: FleetPruneTarget[], scope: PruneScope): Promise<Preflight> {
  try {
    const knownStacks = await FileSystemService.getInstance(node.id).getStacks();
    const controller = DockerController.getInstance(node.id);
    const isImageHeld = ServiceUpdateRecoveryService.getInstance().buildHeldImagePredicate(node.id);
    const plan = await withTimeout(
      controller.buildPrunePlan(targets, scope, knownStacks, node.id, isImageHeld),
      PLAN_TIMEOUT_MS,
      'docker prune plan',
    );
    return { node, reachable: true, plan };
  } catch (error) {
    console.error(`[Fleet prune] Plan failed on ${sanitizeForLog(node.name)}: ${sanitizeForLog(getErrorMessage(error, 'Unknown error'))}`);
    return {
      node,
      reachable: true,
      code: error instanceof TimeoutError ? 'DOCKER_DAEMON_BUSY' : 'PRUNE_PLAN_FAILED',
      error: error instanceof TimeoutError ? BUSY_DAEMON_ERROR : getErrorMessage(error, 'Failed to build prune plan'),
    };
  }
}

async function fetchRemotePlan(node: Node, targets: FleetPruneTarget[], scope: PruneScope): Promise<Preflight> {
  const proxyTarget = NodeRegistry.getInstance().getProxyTarget(node.id);
  if (!proxyTarget) return { node, reachable: false, error: formatNoTargetError(node) };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (proxyTarget.apiToken) headers.Authorization = `Bearer ${proxyTarget.apiToken}`;
  try {
    const response = await safeRemoteFetch(`${proxyTarget.apiUrl.replace(/\/$/, '')}/api/system/prune/plan`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ targets, scope }),
      signal: AbortSignal.timeout(REMOTE_PLAN_TIMEOUT_MS),
    }, proxyTarget.trustedLoopback);
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const message = data && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `Remote returned ${response.status}`;
      return { node, reachable: true, code: 'REMOTE_PLAN_FAILED', error: message };
    }
    if (!isPrunePlan(data, targets, scope)) {
      return { node, reachable: true, code: 'REMOTE_PLAN_INVALID', error: 'Remote returned a malformed prune plan' };
    }
    return { node, reachable: true, plan: projectRemotePlan(data) };
  } catch (error) {
    console.error(`[Fleet prune] Remote plan transport failed for ${sanitizeForLog(node.name)}: ${sanitizeForLog(getErrorMessage(error, 'Unknown error'))}`);
    return { node, reachable: false, error: getErrorMessage(error, 'Failed to reach remote node') };
  }
}

function buildPreflight(node: Node, targets: FleetPruneTarget[], scope: PruneScope): Promise<Preflight> {
  return node.type === 'local'
    ? buildLocalPreflight(node, targets, scope)
    : fetchRemotePlan(node, targets, scope);
}

function preflightResult(entry: Preflight, targets: FleetPruneTarget[]): FleetPruneNodeResult {
  if (entry.plan) {
    return {
      nodeId: entry.node.id,
      nodeName: entry.node.name,
      reachable: true,
      fingerprint: entry.plan.fingerprint,
      items: entry.plan.items,
      reclaimableBytes: entry.plan.reclaimableBytes,
      targets: targetRowsFromPlan(entry.plan, targets),
    };
  }
  const error = entry.error ?? 'Failed to build prune plan';
  return {
    nodeId: entry.node.id,
    nodeName: entry.node.name,
    reachable: entry.reachable,
    code: entry.code,
    error,
    reclaimableBytes: 0,
    targets: failedTargetRows(targets, error, true),
  };
}

function outcomeTargetRows(
  targets: FleetPruneTarget[],
  outcomes: PruneItemOutcome[],
  fallbackSuccess = true,
): FleetPruneTargetResult[] {
  return targets.map((target) => {
    const targetOutcomes = outcomes.filter((outcome) => outcome.target === target);
    const failed = targetOutcomes.filter((outcome) => outcome.status === 'failed');
    const skipped = targetOutcomes.filter((outcome) => outcome.status === 'skipped');
    const removed = targetOutcomes.filter((outcome) => outcome.status === 'removed');
    const removedBytes = removed.reduce((sum, outcome) => sum + (outcome.status === 'removed' ? outcome.sizeBytes ?? 0 : 0), 0);
    return {
      target,
      success: outcomes.length === 0 ? fallbackSuccess : failed.length === 0,
      reclaimedBytes: outcomes.length === 0 ? 0 : removedBytes,
      dryRun: false,
      removed: removed.length,
      skipped: skipped.length,
      failed: failed.length,
      error: failed.length > 0 ? failed.map((outcome) => outcome.status === 'failed' ? outcome.error : '').filter(Boolean).join('; ') : undefined,
    };
  });
}

async function executeLocal(entry: Preflight, targets: FleetPruneTarget[]): Promise<FleetPruneNodeResult> {
  try {
    const plan = entry.plan;
    if (!plan) throw new Error('Local prune preflight is missing');
    const knownStacks = await FileSystemService.getInstance(entry.node.id).getStacks();
    const isImageHeld = ServiceUpdateRecoveryService.getInstance().buildHeldImagePredicate(entry.node.id);
    const result = await DockerController.getInstance(entry.node.id).executePrunePlan(plan, knownStacks, isImageHeld);
    if (result.mutated) {
      try {
        invalidateNodeCaches(entry.node.id);
      } catch (error) {
        console.error(`[Fleet prune] Cache invalidation failed on ${sanitizeForLog(entry.node.name)}: ${sanitizeForLog(getErrorMessage(error, 'Unknown error'))}`);
      }
    }
    return {
      nodeId: entry.node.id,
      nodeName: entry.node.name,
      reachable: true,
      reclaimedBytes: result.reclaimedBytes,
      outcomes: result.outcomes,
      targets: outcomeTargetRows(targets, result.outcomes),
    };
  } catch (error) {
    console.error(`[Fleet prune] Execution failed on ${sanitizeForLog(entry.node.name)}: ${sanitizeForLog(getErrorMessage(error, 'Unknown error'))}`);
    const stale = error instanceof PrunePlanStaleError;
    const message = getErrorMessage(error, stale ? 'Prune plan changed' : 'Prune failed');
    return {
      nodeId: entry.node.id,
      nodeName: entry.node.name,
      reachable: true,
      code: stale ? 'PRUNE_PLAN_STALE' : 'PRUNE_EXECUTE_FAILED',
      error: message,
      reclaimedBytes: 0,
      targets: failedTargetRows(targets, message, false),
    };
  }
}

async function executeRemote(entry: Preflight, targets: FleetPruneTarget[], scope: PruneScope): Promise<FleetPruneNodeResult> {
  const plan = entry.plan;
  const proxyTarget = NodeRegistry.getInstance().getProxyTarget(entry.node.id);
  if (!plan || !proxyTarget) {
    const error = 'Node became unreachable after fleet preflight';
    return {
      nodeId: entry.node.id, nodeName: entry.node.name, reachable: false, error,
      reclaimedBytes: 0, targets: failedTargetRows(targets, error, false),
    };
  }
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (proxyTarget.apiToken) headers.Authorization = `Bearer ${proxyTarget.apiToken}`;
  try {
    const response = await safeRemoteFetch(`${proxyTarget.apiUrl.replace(/\/$/, '')}/api/system/prune/system`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ targets, scope, planFingerprint: plan.fingerprint }),
      signal: AbortSignal.timeout(REMOTE_PLAN_TIMEOUT_MS),
    }, proxyTarget.trustedLoopback);
    const data: unknown = await response.json().catch(() => null);
    const record = data && typeof data === 'object' ? data as Record<string, unknown> : null;
    if (!response.ok) {
      const message = typeof record?.error === 'string' ? record.error : `Remote returned ${response.status}`;
      return {
        nodeId: entry.node.id, nodeName: entry.node.name, reachable: true,
        code: typeof record?.code === 'string' ? record.code : 'REMOTE_PRUNE_FAILED',
        error: message, reclaimedBytes: 0, targets: failedTargetRows(targets, message, false),
      };
    }
    if (!record || typeof record.reclaimedBytes !== 'number' || !Number.isFinite(record.reclaimedBytes)
      || record.reclaimedBytes < 0 || (record.success !== undefined && typeof record.success !== 'boolean')) {
      const error = 'Remote returned a malformed prune result';
      return {
        nodeId: entry.node.id, nodeName: entry.node.name, reachable: true,
        code: 'REMOTE_PRUNE_INVALID', error, reclaimedBytes: 0, targets: failedTargetRows(targets, error, false),
      };
    }
    const hasOutcomes = Object.prototype.hasOwnProperty.call(record, 'outcomes');
    const outcomes = hasOutcomes ? validateRemoteOutcomes(record.outcomes, plan, targets) : undefined;
    if (hasOutcomes && !outcomes) {
      const error = 'Remote returned malformed or incomplete prune outcomes';
      return {
        nodeId: entry.node.id, nodeName: entry.node.name, reachable: true,
        code: 'REMOTE_PRUNE_INVALID', error, reclaimedBytes: 0, targets: failedTargetRows(targets, error, false),
      };
    }
    return {
      nodeId: entry.node.id,
      nodeName: entry.node.name,
      reachable: true,
      reclaimedBytes: record.reclaimedBytes,
      outcomes: outcomes ?? undefined,
      targets: outcomeTargetRows(targets, outcomes ?? [], record.success !== false),
    };
  } catch (error) {
    const message = getErrorMessage(error, 'Failed to reach remote node');
    console.error(`[Fleet prune] Remote execution transport failed for ${sanitizeForLog(entry.node.name)}: ${sanitizeForLog(message)}`);
    return {
      nodeId: entry.node.id, nodeName: entry.node.name, reachable: false,
      error: message, reclaimedBytes: 0, targets: failedTargetRows(targets, message, false),
    };
  }
}

function comparePreflight(
  preflights: Preflight[],
  reviewedNodes: ReviewedFleetNode[],
  plans: ReviewedFleetPlan[],
): { code: string; error: string; nodeId?: number } | null {
  const reviewedById = new Map(reviewedNodes.map((node) => [node.nodeId, node]));
  const plansById = new Map(plans.map((plan) => [plan.nodeId, plan]));
  for (const entry of preflights) {
    const reviewed = reviewedById.get(entry.node.id);
    if (!reviewed) return { code: 'PRUNE_NODE_ROSTER_CHANGED', error: 'The fleet node roster changed after the dry run' };
    if (entry.reachable !== reviewed.reachable) {
      return {
        code: 'PRUNE_NODE_REACHABILITY_CHANGED',
        nodeId: entry.node.id,
        error: `Reachability changed for ${entry.node.name} after the dry run`,
      };
    }
    if (!reviewed.reachable) continue;
    if (!entry.plan) {
      return {
        code: entry.code ?? 'PRUNE_PLAN_FAILED',
        nodeId: entry.node.id,
        error: entry.error ?? `Failed to rebuild the plan for ${entry.node.name}`,
      };
    }
    if (entry.plan.fingerprint !== plansById.get(entry.node.id)?.fingerprint) {
      return {
        code: 'PRUNE_PLAN_STALE',
        nodeId: entry.node.id,
        error: `The prune plan changed on ${entry.node.name} after the dry run`,
      };
    }
  }
  return null;
}

export async function runFleetPrune(
  nodes: Node[],
  request: ParsedFleetPruneRequest,
  activeLocks: Set<string>,
): Promise<FleetPruneResponse> {
  if (request.dryRun) {
    const preflights = await Promise.all(nodes.map((node) => buildPreflight(node, request.targets, request.scope)));
    return { status: 200, body: { results: preflights.map((entry) => preflightResult(entry, request.targets)) } };
  }

  const rosterError = validateReviewedRoster(nodes, request.reviewedNodes, request.plans);
  if (rosterError) return { status: 409, body: { code: 'PRUNE_NODE_ROSTER_CHANGED', error: rosterError } };

  const lockKeys = nodes.filter((node) => node.type === 'local').map((node) => `bulk-prune:${node.id}`);
  const busyKey = lockKeys.find((key) => activeLocks.has(key));
  if (busyKey) return { status: 409, body: { code: 'PRUNE_ALREADY_RUNNING', error: 'A prune is already running on a reviewed node' } };
  for (const key of lockKeys) activeLocks.add(key);

  try {
    const preflights = await Promise.all(nodes.map((node) => buildPreflight(node, request.targets, request.scope)));
    const conflict = comparePreflight(preflights, request.reviewedNodes, request.plans);
    if (conflict) {
      return {
        status: 409,
        body: { ...conflict, results: preflights.map((entry) => preflightResult(entry, request.targets)) },
      };
    }
    const reviewedReachable = new Set(request.reviewedNodes.filter((node) => node.reachable).map((node) => node.nodeId));
    const executable = preflights.filter((entry) => reviewedReachable.has(entry.node.id));
    const results = await Promise.all(executable.map((entry) => entry.node.type === 'local'
      ? executeLocal(entry, request.targets)
      : executeRemote(entry, request.targets, request.scope)));
    return { status: 200, body: { results } };
  } finally {
    for (const key of lockKeys) activeLocks.delete(key);
  }
}
