import { DatabaseService, type NotificationSuppressionRule, type NotificationSuppressionRetraction, type NotificationSuppressionRetractionKind, type Node } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';
import { LicenseService } from '../services/LicenseService';
import { PROXY_TIER_HEADER } from '../services/license-headers';
import {
  NOTIFICATION_SUPPRESSION_SCHEDULE_CAPABILITY,
  NOTIFICATION_SUPPRESSION_REPLICA_RETRACTION_CAPABILITY,
} from '../services/CapabilityRegistry';
import { remoteAdvertisesCapability } from './remoteCapabilities';
import { getErrorMessage } from '../utils/errors';
import { safeRemoteFetch } from '../utils/outboundTarget';

const SYNC_TIMEOUT_MS = 15_000;

function buildRemoteHeaders(apiToken: string): Record<string, string> {
  const proxyHeaders = LicenseService.getInstance().getProxyHeaders();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    [PROXY_TIER_HEADER]: proxyHeaders.tier,
  };
  if (apiToken) headers.Authorization = `Bearer ${apiToken}`;
  return headers;
}

function retractionFor(
  kind: NotificationSuppressionRetractionKind,
  rule: Pick<NotificationSuppressionRule, 'updated_at'>,
): NotificationSuppressionRetraction {
  return { kind, source_updated_at: rule.updated_at };
}

/** Hub node ids that should receive a replica for this rule (before wire identity normalize). */
export function replicationTargetIds(rule: NotificationSuppressionRule): number[] {
  return replicationTargets(rule).map((n) => n.id);
}

export function replicationTargets(rule: NotificationSuppressionRule): Node[] {
  const db = DatabaseService.getInstance();
  const remotes = db.getNodes().filter((n) => n.type === 'remote');
  if (rule.node_id != null) {
    const target = remotes.find((n) => n.id === rule.node_id);
    return target ? [target] : [];
  }
  return remotes;
}

/** Every registered remote: permanent deletes must reach historical replicas, not only current scope. */
export function allRemoteNodes(): Node[] {
  return DatabaseService.getInstance().getNodes().filter((n) => n.type === 'remote');
}

function replicaPayload(rule: NotificationSuppressionRule): NotificationSuppressionRule {
  return { ...rule, node_id: null };
}

type RetractionSupport = 'supported' | 'unsupported' | 'unreachable';

async function probeRetractionSupport(nodeId: number): Promise<RetractionSupport> {
  try {
    const meta = await NodeRegistry.getInstance().fetchMetaForNode(nodeId);
    // fetchMetaForNode returns OFFLINE_META (online:false, capabilities:[]) on
    // transport failure instead of throwing; treat that as unreachable.
    if (meta.online === false) return 'unreachable';
    return meta.capabilities.includes(NOTIFICATION_SUPPRESSION_REPLICA_RETRACTION_CAPABILITY)
      ? 'supported'
      : 'unsupported';
  } catch (err) {
    console.warn(
      `[SuppressionSync] Retraction capability probe failed for node ${nodeId}; treating as unreachable:`,
      getErrorMessage(err, 'unknown'),
    );
    return 'unreachable';
  }
}

function enqueuePending(
  node: Node,
  ruleId: number,
  retraction: NotificationSuppressionRetraction,
  lastError: string,
): void {
  DatabaseService.getInstance().upsertNotificationSuppressionPendingRetraction({
    rule_id: ruleId,
    node_id: node.id,
    kind: retraction.kind,
    source_updated_at: retraction.source_updated_at,
    last_error: lastError,
  });
}

function clearPending(nodeId: number, ruleId: number): void {
  DatabaseService.getInstance().deleteNotificationSuppressionPendingRetraction(ruleId, nodeId);
}

function resolveRemoteApi(node: Node): { baseUrl: string; apiToken: string; trustedLoopback: boolean } | null {
  const target = NodeRegistry.getInstance().getProxyTarget(node.id);
  if (!target?.apiUrl) return null;
  return {
    baseUrl: target.apiUrl.replace(/\/$/, ''),
    apiToken: target.apiToken,
    trustedLoopback: target.trustedLoopback,
  };
}

/** Non-2xx (including opaque 404) is always failure; never treat missing routes as applied. */
async function throwHttpFailure(res: Response): Promise<never> {
  const body = await res.text().catch(() => '');
  throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
}

/** Prefer JSON outcome; fall back to applied for pre-outcome remotes (bare 2xx). */
async function readOutcome(res: Response): Promise<string> {
  try {
    const json = (await res.json()) as { outcome?: string };
    return typeof json.outcome === 'string' ? json.outcome : 'applied';
  } catch {
    return 'applied';
  }
}

async function pushRuleToNode(node: Node, rule: NotificationSuppressionRule): Promise<void> {
  const remote = resolveRemoteApi(node);
  if (!remote) {
    console.warn(`[SuppressionSync] Skipping node "${node.name}": no proxy target`);
    return;
  }
  const res = await safeRemoteFetch(`${remote.baseUrl}/api/notification-suppression-rules/replica`, {
    method: 'POST',
    headers: buildRemoteHeaders(remote.apiToken),
    body: JSON.stringify({ rule: replicaPayload(rule) }),
    signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
  }, remote.trustedLoopback);
  if (!res.ok) await throwHttpFailure(res);
  const outcome = await readOutcome(res);
  if (outcome !== 'applied') {
    throw new Error(`replica POST outcome=${outcome}`);
  }
}

/**
 * Deliver a replica DELETE. On transport failure, durable-queues the retraction.
 * Clears pending only when the remote reports outcome=applied (not ignored_stale).
 */
export async function deleteRuleOnNode(
  node: Node,
  ruleId: number,
  retraction: NotificationSuppressionRetraction,
): Promise<{ outcome: string }> {
  const remote = resolveRemoteApi(node);
  if (!remote) {
    const err = `no proxy target for node "${node.name}" (id=${node.id})`;
    enqueuePending(node, ruleId, retraction, err);
    throw new Error(err);
  }
  try {
    const res = await safeRemoteFetch(`${remote.baseUrl}/api/notification-suppression-rules/replica/${ruleId}`, {
      method: 'DELETE',
      headers: buildRemoteHeaders(remote.apiToken),
      body: JSON.stringify(retraction),
      signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
    }, remote.trustedLoopback);
    if (!res.ok) await throwHttpFailure(res);
    const outcome = await readOutcome(res);
    if (outcome !== 'applied') {
      // ignored_stale and any other non-applied outcome keep the outbox row.
      const reason =
        outcome === 'ignored_stale'
          ? 'remote ignored_stale; rule still present'
          : `remote DELETE outcome=${outcome}`;
      enqueuePending(node, ruleId, retraction, reason);
      return { outcome };
    }
    clearPending(node.id, ruleId);
    return { outcome };
  } catch (err) {
    try {
      enqueuePending(node, ruleId, retraction, getErrorMessage(err, String(err)));
    } catch (enqueueErr) {
      console.error(
        `[SuppressionSync] Failed to durable-queue retract rule=${ruleId} node=${node.id}:`,
        getErrorMessage(enqueueErr, String(enqueueErr)),
      );
    }
    throw err;
  }
}

/**
 * Recoverable DELETE only when the remote advertises versioned retractions.
 * Otherwise enqueue pending and do not bare-delete on incompatible remotes.
 * @returns applied when DELETE was accepted; deferred when queued without sending
 *   or when the remote ignored a stale watermark.
 */
async function deliverRecoverableDelete(
  node: Node,
  ruleId: number,
  retraction: NotificationSuppressionRetraction,
  context: string,
): Promise<'applied' | 'deferred'> {
  const support = await probeRetractionSupport(node.id);
  if (support !== 'supported') {
    const reason =
      support === 'unsupported'
        ? 'remote lacks notification-suppression-replica-retraction; not sending recoverable DELETE'
        : 'remote unreachable for retraction capability probe; not sending recoverable DELETE';
    enqueuePending(node, ruleId, retraction, reason);
    console.warn(
      `[SuppressionSync] ${context} on node "${node.name}" (id=${node.id}): ${reason}; queued pending retraction`,
    );
    return 'deferred';
  }
  const { outcome } = await deleteRuleOnNode(node, ruleId, retraction);
  return outcome === 'applied' ? 'applied' : 'deferred';
}

async function pushOrCleanupScheduled(node: Node, rule: NotificationSuppressionRule): Promise<void> {
  const supportsSchedule = await remoteAdvertisesCapability(
    node.id,
    NOTIFICATION_SUPPRESSION_SCHEDULE_CAPABILITY,
  );
  if (supportsSchedule) {
    await pushRuleToNode(node, rule);
    return;
  }
  // Never POST a scheduled rule through the legacy contract. Soft-cleanup DELETE
  // requires versioned retraction support so incompatible remotes are not bare-deleted.
  try {
    const result = await deliverRecoverableDelete(
      node,
      rule.id,
      retractionFor('recoverable', rule),
      `Scheduled rule ${rule.id} not applied`,
    );
    if (result === 'applied') {
      console.warn(
        `[SuppressionSync] Scheduled rule ${rule.id} not applied on node "${node.name}" (id=${node.id}): ` +
          `schedule unsupported-or-unreachable; recoverable DELETE applied`,
      );
    }
  } catch (err) {
    console.error(
      `[SuppressionSync] Scheduled rule ${rule.id}: cleanup pending on node "${node.name}" (id=${node.id}); ` +
        `recoverable DELETE failed (${getErrorMessage(err, String(err))})`,
    );
  }
}

async function cleanupInvalidScheduleReplica(node: Node, rule: NotificationSuppressionRule): Promise<void> {
  try {
    const result = await deliverRecoverableDelete(
      node,
      rule.id,
      retractionFor('recoverable', rule),
      `Corrupt schedule on rule ${rule.id}`,
    );
    if (result === 'applied') {
      console.warn(
        `[SuppressionSync] Corrupt schedule on rule ${rule.id}: recoverable DELETE applied on node "${node.name}" (id=${node.id}); not posting`,
      );
    }
  } catch (err) {
    console.error(
      `[SuppressionSync] Corrupt schedule on rule ${rule.id}: cleanup pending on node "${node.name}" (id=${node.id}); ` +
        `DELETE failed (${getErrorMessage(err, String(err))})`,
    );
  }
}

async function syncRuleToNode(node: Node, rule: NotificationSuppressionRule): Promise<void> {
  if (rule.scheduleInvalid) {
    await cleanupInvalidScheduleReplica(node, rule);
    return;
  }
  if (rule.schedule != null) {
    await pushOrCleanupScheduled(node, rule);
    return;
  }
  await pushRuleToNode(node, rule);
}

/** Best-effort push of a suppression rule to fleet nodes that should evaluate it. */
export function syncSuppressionRuleToFleet(rule: NotificationSuppressionRule): void {
  const targets = replicationTargets(rule);
  if (targets.length === 0) return;
  void Promise.allSettled(
    targets.map(async (node) => {
      try {
        await syncRuleToNode(node, rule);
      } catch (err) {
        console.error(
          `[SuppressionSync] Failed to push rule ${rule.id} to node "${node.name}":`,
          getErrorMessage(err, String(err)),
        );
      }
    }),
  );
}

/**
 * After an update, DELETE replicas on targets that left the set, then refresh
 * remaining / new targets. previous is the pre-update rule (for target diff).
 */
export function syncSuppressionRuleUpdateToFleet(
  previous: NotificationSuppressionRule,
  updated: NotificationSuppressionRule,
): void {
  const oldIds = new Set(replicationTargetIds(previous));
  const newIds = new Set(replicationTargetIds(updated));
  const db = DatabaseService.getInstance();
  const staleIds = [...oldIds].filter((id) => !newIds.has(id));
  const staleRetraction = retractionFor('recoverable', updated);

  void Promise.allSettled([
    ...staleIds.map(async (id) => {
      const node = db.getNode(id);
      if (!node || node.type !== 'remote') return;
      try {
        await deliverRecoverableDelete(
          node,
          previous.id,
          staleRetraction,
          `Stale-target retract for rule ${previous.id}`,
        );
      } catch (err) {
        console.error(
          `[SuppressionSync] Failed to delete stale rule ${previous.id} on node "${node.name}":`,
          getErrorMessage(err, String(err)),
        );
      }
    }),
    ...replicationTargets(updated).map(async (node) => {
      try {
        await syncRuleToNode(node, updated);
      } catch (err) {
        console.error(
          `[SuppressionSync] Failed to push rule ${updated.id} to node "${node.name}":`,
          getErrorMessage(err, String(err)),
        );
      }
    }),
  ]);
}

/**
 * Authoritative delete: fan out permanent retraction to every known remote
 * (not only current scope), and durable-queue failures for retry.
 */
export function deleteSuppressionRuleFromFleet(rule: NotificationSuppressionRule): void {
  const targets = allRemoteNodes();
  if (targets.length === 0) return;
  const retraction = retractionFor('permanent', rule);
  void Promise.allSettled(
    targets.map(async (node) => {
      try {
        await deleteRuleOnNode(node, rule.id, retraction);
      } catch (err) {
        console.error(
          `[SuppressionSync] Failed to delete rule ${rule.id} on node "${node.name}":`,
          getErrorMessage(err, String(err)),
        );
      }
    }),
  );
}

/**
 * Retry durable pending retractions for one node (tunnel-up / reconnect) or all.
 * Recoverable rows still require the remote to advertise retraction support.
 */
export async function flushPendingSuppressionRetractions(nodeId?: number): Promise<void> {
  const db = DatabaseService.getInstance();
  const pending = db.listNotificationSuppressionPendingRetractions(nodeId);
  for (const row of pending) {
    const node = db.getNode(row.node_id);
    if (!node || node.type !== 'remote') {
      db.deleteNotificationSuppressionPendingRetraction(row.rule_id, row.node_id);
      continue;
    }
    const retraction: NotificationSuppressionRetraction = {
      kind: row.kind,
      source_updated_at: row.source_updated_at,
    };
    try {
      if (retraction.kind === 'recoverable') {
        await deliverRecoverableDelete(
          node,
          row.rule_id,
          retraction,
          `Pending recoverable retract for rule ${row.rule_id}`,
        );
      } else {
        await deleteRuleOnNode(node, row.rule_id, retraction);
      }
    } catch (err) {
      console.error(
        `[SuppressionSync] Pending retract retry failed rule=${row.rule_id} node=${node.name}:`,
        getErrorMessage(err, String(err)),
      );
    }
  }
}
