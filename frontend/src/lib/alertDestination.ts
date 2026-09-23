import type { NotificationCategory, NotificationItem } from '@/components/dashboard/types';
import type { FleetUpdatesTab, SecurityTab } from '@/lib/events';

/**
 * Where a Home alert row leads. Every variant names the node that owns the
 * destination, except the Fleet update sheet, which always lives on the hub.
 */
export type AlertDestination =
  | {
      kind: 'stack';
      nodeId: number;
      stackName: string;
      /** Drift rows open the stack's Drift tab; everything else opens the stack. */
      tab: 'stack' | 'drift';
      /** A container-scoped row also opens that container's logs once loaded. */
      containerName: string | null;
    }
  | { kind: 'fleet-updates'; tab: FleetUpdatesTab }
  | { kind: 'security'; nodeId: number; tab: SecurityTab };

/**
 * Update-availability rows have no stack to drill into, so they go to the Fleet
 * update sheet: per-node updates under Nodes, release notes under Changelog.
 */
const FLEET_UPDATE_TAB: Partial<Record<string, FleetUpdatesTab>> = {
  node_update_available: 'nodes',
  dev_build_update_available: 'changelog',
} satisfies Partial<Record<NotificationCategory, FleetUpdatesTab>>;

/**
 * Resolve the one deterministic destination for an alert, or null when the row
 * has nowhere authoritative to go. A node-owned destination requires the row's
 * node to be in the registry: a row stamped with an unknown node must not open
 * a same-named stack on whichever node happens to be active.
 *
 * Categories without a reliable target (host thresholds, system messages, a
 * scan finding with no stack and no node) stay null so the row renders inert
 * rather than navigating somewhere misleading.
 */
export function resolveAlertDestination(
  n: NotificationItem,
  knownNodeIds: ReadonlySet<number>,
): AlertDestination | null {
  const fleetTab = n.category != null ? FLEET_UPDATE_TAB[n.category] : undefined;
  if (fleetTab) return { kind: 'fleet-updates', tab: fleetTab };

  if (n.nodeId == null || !knownNodeIds.has(n.nodeId)) return null;

  if (n.stack_name) {
    return {
      kind: 'stack',
      nodeId: n.nodeId,
      stackName: n.stack_name,
      tab: n.category === 'drift_detected' ? 'drift' : 'stack',
      containerName: n.container_name ?? null,
    };
  }

  // A scan finding that names no stack (a scheduled scan, a policy violation on
  // an image) still has an authoritative home: that node's scan history.
  if (n.category === 'scan_finding') return { kind: 'security', nodeId: n.nodeId, tab: 'history' };

  return null;
}
