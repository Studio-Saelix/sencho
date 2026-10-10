import { useCallback, useMemo, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { useNodes } from '@/context/NodeContext';
import { REMOTE_IMAGE_INSPECT_V1_CAPABILITY } from '@/lib/capabilities';
import { toast } from '@/components/ui/toast-store';
import type { DismissedItem } from '@/components/ui/dismissed-section';
import { describeDismissal } from '@/components/fleet/readiness/describeDismissal';
import { useNow } from '@/components/fleet/readiness/useNow';
import { useNodeDismissals } from '@/hooks/useNodeDismissals';
import { useNodeScan } from '@/hooks/useNodeScan';
import { partitionPostureReasons, securityDismissalKey } from '@/lib/securityDismissals';
import type { SecurityTab } from '@/lib/events';
import type { ImageFilterValue } from '@/lib/severityStyles';
import type { PostureReason, SecurityOverview } from '@/types/security';
import { defaultReasonActionLabel, reasonImageFilter } from './postureNavigation';
import { targetingFromTargets, type ImagesTargetingInput } from './imagesTargeting';
import { triggerNodeImageUpdateCheck } from './imageUpdateRecheck';
import { resolveReasonVerb, type ReasonVerb, type ReasonVerbContext } from './securityVerbs';
import type { SecurityReasonControls } from './SecurityReasonActions';

type NavigateFn = (tab: SecurityTab, filter?: ImageFilterValue, targeting?: ImagesTargetingInput) => void;

interface UseSecurityReasonsOptions {
  overview: SecurityOverview | null;
  isReplica: boolean;
  onNavigate: NavigateFn;
  /** Re-read the overview. */
  reload: () => void;
}

export function reasonNavLabel(reason: PostureReason): string {
  return reason.actionLabel ?? defaultReasonActionLabel(reason.targetTab);
}

/**
 * Everything the Overview and the masthead need to act on posture reasons: one
 * verb per reason, the one handler that runs it, and the team's dismissals. The
 * posture word is never derived from the partition: a dismissal only moves a
 * reason from the queue to the dismissed list.
 */
export function useSecurityReasons({ overview, isReplica, onNavigate, reload }: UseSecurityReasonsOptions) {
  const { can } = useAuth();
  const { activeNode, activeNodeMeta } = useNodes();
  const nodeId = activeNode?.id;
  const now = useNow(60_000);
  const [checkAgainBusy, setCheckAgainBusy] = useState(false);
  const { running: scanRunning, scan } = useNodeScan(reload);
  // The target-local scanner backs Security rechecks, so inspect-v1 remotes
  // address it directly; hub overlay evidence is not a recheck target.
  const targetScannerRefresh = activeNode?.type === 'remote'
    && (activeNodeMeta?.capabilities.includes(REMOTE_IMAGE_INSPECT_V1_CAPABILITY) ?? false);
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => {
    setReloadKey(value => value + 1);
    reload();
  }, [reload]);
  const canReadNode = nodeId !== undefined && can('node:read', 'node', String(nodeId));
  const { dismissals, dismiss, restore, isPending } = useNodeDismissals('security', nodeId, reloadKey, refresh, canReadNode);

  const canManageNode = nodeId !== undefined && can('node:manage', 'node', String(nodeId));
  const verbContext: ReasonVerbContext = useMemo(() => ({
    canManageNode,
    canScanNode: can('node:manage'),
    canDeployStack: stack => nodeId !== undefined && can('stack:deploy', 'stack', stack, nodeId),
    canEditStack: stack => nodeId !== undefined && can('stack:edit', 'stack', stack, nodeId),
    scannerAvailable: overview?.scanner.available === true,
    updateChecksDisabled: overview?.updateChecksDisabled === true,
    isReplica,
  }), [can, canManageNode, nodeId, overview, isReplica]);

  const verbFor = useCallback(
    (reason: PostureReason): ReasonVerb | null => resolveReasonVerb(reason, verbContext, reasonNavLabel(reason)),
    [verbContext],
  );

  const navigate = useCallback((reason: PostureReason): void => {
    const targeting = targetingFromTargets(
      reason.kind,
      reason.label,
      reason.targets,
      reason.drivers,
      { driverCount: reason.driverCount, driversTruncated: reason.driversTruncated },
    );
    // Prefer precise targets; severity filter is only the older-node fallback.
    onNavigate(reason.targetTab, targeting ? undefined : reasonImageFilter(reason.kind), targeting);
  }, [onNavigate]);

  const run = useCallback(async (reason: PostureReason, verb: ReasonVerb): Promise<void> => {
    switch (verb.kind) {
      case 'navigate':
        navigate(reason);
        return;
      case 'check-again':
        if (checkAgainBusy) return;
        setCheckAgainBusy(true);
        try {
          await triggerNodeImageUpdateCheck(targetScannerRefresh);
          refresh();
        } catch (err) {
          toast.error((err as Error)?.message || 'Failed to start image update check');
        } finally {
          setCheckAgainBusy(false);
        }
        return;
      case 'rescan-node':
        if (!scanRunning) await scan();
        return;
      default:
        return;
    }
  }, [navigate, checkAgainBusy, targetScannerRefresh, refresh, scanRunning, scan]);

  const partition = useMemo(
    () => (nodeId === undefined
      ? { active: overview?.postureReasons ?? [], dismissed: [] }
      : partitionPostureReasons(overview?.postureReasons ?? [], dismissals, nodeId, now)),
    [overview, dismissals, nodeId, now],
  );

  const keyOf = (reason: PostureReason): string | null =>
    (nodeId !== undefined && reason.key !== undefined ? securityDismissalKey(nodeId, reason.key) : null);

  const controls: SecurityReasonControls = {
    nodeId,
    run,
    navLabel: reasonNavLabel,
    busy: verb => (verb.kind === 'check-again' ? checkAgainBusy : verb.kind === 'rescan-node' ? scanRunning : false),
    onResolved: refresh,
    canDismiss: canManageNode,
    isDismissing: reason => {
      const key = keyOf(reason);
      return key !== null && isPending(key);
    },
    onDismiss: (reason, mode, days) => {
      const key = keyOf(reason);
      if (key === null || reason.fingerprint === undefined) return;
      void dismiss({ id: key, fingerprint: reason.fingerprint, count: reason.count, severity: reason.severity }, mode, days);
    },
  };

  const dismissedItems: DismissedItem[] = partition.dismissed.map(({ reason, dismissal }) => ({
    id: dismissal.id,
    title: reason.label,
    meta: describeDismissal(dismissal, now),
    onRestore: canManageNode ? () => void restore(dismissal.id) : undefined,
    restoring: isPending(dismissal.id),
  }));

  return { controls, verbFor, active: partition.active, dismissedItems };
}

export type SecurityReasons = ReturnType<typeof useSecurityReasons>;
