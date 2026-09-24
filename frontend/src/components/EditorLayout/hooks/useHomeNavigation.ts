import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import type { Node } from '@/context/NodeContext';
import type { SectionId } from '@/components/settings/types';
import type { PermissionAction } from '@/context/AuthContext';
import type { FleetUpdatesTab, SecurityTab, SenchoOpenStackDetail } from '@/lib/events';
import type { ActiveView } from '@/lib/router/routeTypes';
import type { NotificationItem } from '@/components/dashboard/types';
import type { HomeNavigation } from '@/components/HomeDashboard';
import type { StackHealthNavTarget } from '@/components/dashboard/useStackHealthScope';
import type { ConfigTarget } from '@/components/dashboard/ConfigurationSummary';
import { resolveAlertDestination, type AlertDestination } from '@/lib/alertDestination';
import {
  isSettingsSectionHidden,
  isViewCapabilityLocked,
  isViewHidden,
  type ReachabilityContext,
} from '@/lib/routing/reachability';
import { toast } from '@/components/ui/toast-store';

/**
 * How long an armed cross-node intent stays valid. A switch that the unsaved-
 * changes guard cancels never settles on the target node, so without an expiry
 * the intent would fire on some later, unrelated switch to that node.
 */
export const PENDING_NODE_INTENT_TTL_MS = 10_000;

interface PendingNodeIntent {
  nodeId: number;
  run: () => void;
  armedAt: number;
}

interface UseHomeNavigationArgs {
  nodes: Node[];
  activeNode: Node | null;
  setActiveNode: (node: Node) => void;
  reachCtx: ReachabilityContext;
  can: (action: PermissionAction, resourceType?: string, resourceId?: string, nodeId?: number | null) => boolean;
  isMobile: boolean;
  navigateMobileAware: (view: string) => void;
  handleNavigate: (view: string) => void;
  setActiveView: (view: ActiveView) => void;
  setSecurityTab: (tab: SecurityTab) => void;
  openSettings: (section: SectionId) => void;
  toStack: (target: StackHealthNavTarget) => void;
  /** The Fleet "Open in Editor" path: loads a stack on its node, switching nodes first if needed. */
  openStackOnNode: (nodeId: number, stackName: string, destination: SenchoOpenStackDetail['destination']) => void;
  pendingLogsRef: MutableRefObject<{ stackName: string; containerName: string } | null>;
  openNotifications: () => void;
}

/**
 * Every hand-off out of the Home dashboard, plus the Fleet deep-link intents
 * those hand-offs arm.
 *
 * A destination on another node is reached the way every cross-node hop in the
 * shell is: set the active node first, then act once the node-settled effect
 * sees the switch land. Stack rows go through `openStackOnNode` and its pending
 * stack load; Fleet and Security destinations through `takePendingNodeIntent`.
 * The destination therefore never mounts against the previous node, and the
 * switch is a real context change that Home reflects afterwards, not a
 * temporary excursion.
 *
 * Fleet is hub-scoped. From a remote node, a Fleet destination switches back to
 * the hub first instead of dead-ending in an error.
 */
export function useHomeNavigation(args: UseHomeNavigationArgs) {
  const {
    nodes, activeNode, setActiveNode, reachCtx, can, isMobile, navigateMobileAware,
    handleNavigate, setActiveView, setSecurityTab, openSettings, toStack,
    openStackOnNode, pendingLogsRef, openNotifications,
  } = args;

  const [fleetNodeIntent, setFleetNodeIntent] = useState<number | null>(null);
  const [fleetUpdatesIntent, setFleetUpdatesIntent] = useState<{ tab: FleetUpdatesTab } | null>(null);
  const onFleetNodeIntentConsumed = useCallback(() => setFleetNodeIntent(null), []);
  const onFleetUpdatesIntentConsumed = useCallback(() => setFleetUpdatesIntent(null), []);

  const pendingNodeIntentRef = useRef<PendingNodeIntent | null>(null);
  // A queued intent runs after the switch lands, so anything it reads about the
  // active node must come from that later render, not from the click.
  const reachCtxRef = useRef(reachCtx);
  reachCtxRef.current = reachCtx;

  /** Called by the node-settled effect: the intent armed for this node, if any. */
  const takePendingNodeIntent = useCallback((settledNodeId: number): (() => void) | null => {
    const pending = pendingNodeIntentRef.current;
    pendingNodeIntentRef.current = null;
    if (!pending || pending.nodeId !== settledNodeId) return null;
    return Date.now() - pending.armedAt <= PENDING_NODE_INTENT_TTL_MS ? pending.run : null;
  }, []);

  const runOnNode = (nodeId: number, run: () => void) => {
    const node = nodes.find(n => n.id === nodeId);
    if (!node) {
      // The roster is live, so a node can disappear between render and click.
      console.warn('[Home] navigation target node is no longer registered:', nodeId);
      toast.error('That node is no longer registered.');
      return;
    }
    if (activeNode?.id === nodeId) {
      pendingNodeIntentRef.current = null;
      run();
      return;
    }
    pendingNodeIntentRef.current = { nodeId, run, armedAt: Date.now() };
    setActiveNode(node);
  };

  const hub = nodes.find(n => n.type === 'local');
  // Fleet is judged as the hub would see it: from a remote node the view is
  // hidden only because it lives on the hub, which a switch resolves.
  const fleetReachable = hub !== undefined && !isViewHidden('fleet', { ...reachCtx, isRemote: false });

  /**
   * Switch to the hub if needed, then open Fleet. `arm` sets a deep-link intent
   * for the Fleet view to consume; the phone Fleet screen has no sheet to open,
   * so it only navigates there.
   */
  const openFleet = (arm: () => void) => {
    if (!hub) {
      toast.error('Fleet is unavailable until the node list finishes loading.');
      return;
    }
    if (!fleetReachable) {
      toast.error('Fleet is not available to your role.');
      return;
    }
    runOnNode(hub.id, () => {
      if (isMobile) {
        navigateMobileAware('fleet');
        return;
      }
      // A capability-locked Fleet renders its lock card in place of FleetView,
      // so a deep link would sit unconsumed until some later visit; drop it.
      if (!isViewCapabilityLocked('fleet', reachCtxRef.current)) arm();
      handleNavigate('fleet');
    });
  };

  const openFleetNode = (nodeId: number) => openFleet(() => setFleetNodeIntent(nodeId));

  const openFleetUpdates = (tab: FleetUpdatesTab) => openFleet(() => setFleetUpdatesIntent({ tab }));

  const openSecurityTab = (tab: SecurityTab) => {
    setSecurityTab(tab);
    setActiveView('security');
  };

  const knownNodeIds = new Set(nodes.map(n => n.id));

  const alertDestinationFor = (n: NotificationItem): AlertDestination | null => {
    const destination = resolveAlertDestination(n, knownNodeIds);
    if (destination === null) return null;
    switch (destination.kind) {
      case 'stack':
        return can('stack:read', 'stack', destination.stackName, destination.nodeId) ? destination : null;
      case 'fleet-updates':
        return fleetReachable ? destination : null;
      case 'security':
        return isViewHidden('security', reachCtx) ? null : destination;
      default: {
        const exhaustive: never = destination;
        return exhaustive;
      }
    }
  };

  const openAlertDestination = (destination: AlertDestination) => {
    switch (destination.kind) {
      case 'stack':
        // Always overwrite: a stale target from an earlier click on the same
        // stack must not open logs for a row that names no container.
        pendingLogsRef.current = destination.containerName
          ? { stackName: destination.stackName, containerName: destination.containerName }
          : null;
        openStackOnNode(destination.nodeId, destination.stackName, destination.tab);
        return;
      case 'fleet-updates':
        openFleetUpdates(destination.tab);
        return;
      case 'security':
        runOnNode(destination.nodeId, () => openSecurityTab(destination.tab));
        return;
      default: {
        const exhaustive: never = destination;
        return exhaustive;
      }
    }
  };

  const canOpenConfigTarget = (target: ConfigTarget): boolean => {
    switch (target.kind) {
      case 'settings': return !isSettingsSectionHidden(target.section, reachCtx);
      case 'security': return !isViewHidden('security', reachCtx);
      case 'view': return !isViewHidden(target.view, reachCtx);
      default: {
        const exhaustive: never = target;
        return exhaustive;
      }
    }
  };

  const openConfigTarget = (target: ConfigTarget) => {
    switch (target.kind) {
      case 'settings': openSettings(target.section); return;
      case 'security': openSecurityTab(target.tab); return;
      case 'view': handleNavigate(target.view); return;
      default: {
        const exhaustive: never = target;
        return exhaustive;
      }
    }
  };

  const homeNavigation: HomeNavigation = {
    toStack,
    toFleetNode: openFleetNode,
    alerts: { destinationFor: alertDestinationFor, open: openAlertDestination, viewAll: openNotifications },
    config: { open: openConfigTarget, canOpen: canOpenConfigTarget },
  };

  return {
    homeNavigation,
    openFleetUpdates,
    fleetNodeIntent,
    onFleetNodeIntentConsumed,
    fleetUpdatesIntent,
    onFleetUpdatesIntentConsumed,
    takePendingNodeIntent,
  };
}
