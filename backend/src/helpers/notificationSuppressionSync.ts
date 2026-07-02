import { DatabaseService, type NotificationSuppressionRule, type Node } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';
import { LicenseService } from '../services/LicenseService';
import { PROXY_TIER_HEADER } from '../services/license-headers';
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

function replicationTargets(rule: NotificationSuppressionRule): Node[] {
  const db = DatabaseService.getInstance();
  const remotes = db.getNodes().filter((n) => n.type === 'remote');
  if (rule.node_id != null) {
    const target = remotes.find((n) => n.id === rule.node_id);
    return target ? [target] : [];
  }
  return remotes;
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
    body: JSON.stringify({ rule }),
    signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
}

async function deleteRuleOnNode(node: Node, ruleId: number): Promise<void> {
  const target = NodeRegistry.getInstance().getProxyTarget(node.id);
  if (!target?.apiUrl) {
    console.warn(`[SuppressionSync] Skipping node "${node.name}": no proxy target`);
    return;
  }
  const baseUrl = target.apiUrl.replace(/\/$/, '');
  const res = await fetch(`${baseUrl}/api/notification-suppression-rules/replica/${ruleId}`, {
    method: 'DELETE',
    headers: buildRemoteHeaders(target.apiToken),
    signal: AbortSignal.timeout(SYNC_TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
}

/** Best-effort push of a suppression rule to fleet nodes that should evaluate it. */
export function syncSuppressionRuleToFleet(rule: NotificationSuppressionRule): void {
  const targets = replicationTargets(rule);
  if (targets.length === 0) return;
  void Promise.allSettled(
    targets.map(async (node) => {
      try {
        await pushRuleToNode(node, rule);
      } catch (err) {
        console.error(
          `[SuppressionSync] Failed to push rule ${rule.id} to node "${node.name}":`,
          getErrorMessage(err, String(err)),
        );
      }
    }),
  );
}

/** Best-effort delete of a replicated rule on fleet nodes. */
export function deleteSuppressionRuleFromFleet(rule: NotificationSuppressionRule): void {
  const targets = replicationTargets(rule);
  if (targets.length === 0) return;
  void Promise.allSettled(
    targets.map(async (node) => {
      try {
        await deleteRuleOnNode(node, rule.id);
      } catch (err) {
        console.error(
          `[SuppressionSync] Failed to delete rule ${rule.id} on node "${node.name}":`,
          getErrorMessage(err, String(err)),
        );
      }
    }),
  );
}
