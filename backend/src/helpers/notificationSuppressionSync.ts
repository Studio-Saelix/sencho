import { DatabaseService, type NotificationSuppressionRule, type NotificationSuppressionRetraction, type NotificationSuppressionRetractionKind, type Node } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';
import { LicenseService } from '../services/LicenseService';
import { PROXY_TIER_HEADER } from '../services/license-headers';
import {
  NOTIFICATION_SUPPRESSION_SCHEDULE_CAPABILITY,
} from '../services/CapabilityRegistry';
import { remoteAdvertisesCapability } from './remoteCapabilities';
import { getErrorMessage } from '../utils/errors';

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
  rule: NotificationSuppressionRule,
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

function replicaPayload(rule: NotificationSuppressionRule): NotificationSuppressionRule {
  return { ...rule, node_id: null };
}

async function pushRuleToNode(node: Node, rule: NotificationSuppressionRule): Promise<void> {
  const target = NodeRegistry.getInstance().getProxyTarget(node.id);
  if (!target?.apiUrl) {
    console.warn(`[SuppressionSync] Skipping node "${node.name}": no proxy target`);
    return;
  }
  const baseUrl = target.apiUrl.replace(/\/$/, '');
  const res = await fetch(`${baseUrl}/api/notification-suppression-rules/replica`, {
    method: 'POST',
    headers: buildRemoteHeaders(target.apiToken),
    body: JSON.stringify({ rule: replicaPayload(rule) }),
    signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
}

async function deleteRuleOnNode(
  node: Node,
  ruleId: number,
  retraction: NotificationSuppressionRetraction,
): Promise<void> {
  const target = NodeRegistry.getInstance().getProxyTarget(node.id);
  if (!target?.apiUrl) {
    throw new Error(`no proxy target for node "${node.name}" (id=${node.id})`);
  }
  const baseUrl = target.apiUrl.replace(/\/$/, '');
  const res = await fetch(`${baseUrl}/api/notification-suppression-rules/replica/${ruleId}`, {
    method: 'DELETE',
    headers: buildRemoteHeaders(target.apiToken),
    body: JSON.stringify(retraction),
    signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
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
  // Probe false means unsupported OR unreachable. Never POST a scheduled rule
  // through the legacy contract (older remotes would mute all day). Attempt DELETE;
  // only claim cleanup when DELETE succeeds.
  try {
    await deleteRuleOnNode(node, rule.id, retractionFor('recoverable', rule));
    console.warn(
      `[SuppressionSync] Scheduled rule ${rule.id} not applied on node "${node.name}" (id=${node.id}): ` +
        `capability unsupported-or-unreachable; DELETE succeeded and replica was removed`,
    );
  } catch (err) {
    console.error(
      `[SuppressionSync] Scheduled rule ${rule.id}: cleanup pending on node "${node.name}" (id=${node.id}); ` +
        `capability unsupported-or-unreachable and DELETE failed (${getErrorMessage(err, String(err))}). ` +
        `Prior replica may remain until connectivity returns and the rule is re-saved`,
    );
  }
}

async function cleanupInvalidScheduleReplica(node: Node, rule: NotificationSuppressionRule): Promise<void> {
  // Never POST an invalid schedule (would mute all day on remotes that ignore the field).
  // Attempt DELETE so a prior valid/unscheduled replica cannot keep muting.
  try {
    await deleteRuleOnNode(node, rule.id, retractionFor('recoverable', rule));
    console.warn(
      `[SuppressionSync] Corrupt schedule on rule ${rule.id}: replica removed on node "${node.name}" (id=${node.id}); not posting`,
    );
  } catch (err) {
    console.error(
      `[SuppressionSync] Corrupt schedule on rule ${rule.id}: cleanup pending on node "${node.name}" (id=${node.id}); ` +
        `DELETE failed (${getErrorMessage(err, String(err))}). Prior replica may remain until connectivity returns`,
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
        await deleteRuleOnNode(node, previous.id, staleRetraction);
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

/** Best-effort delete of a replicated rule on fleet nodes. */
export function deleteSuppressionRuleFromFleet(rule: NotificationSuppressionRule): void {
  const targets = replicationTargets(rule);
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
