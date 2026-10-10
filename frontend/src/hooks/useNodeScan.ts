import { useCallback, useState } from 'react';
import { apiFetch, withDeploySession } from '@/lib/api';
import { useDeployFeedback } from '@/context/DeployFeedbackContext';
import { useNodes } from '@/context/NodeContext';
import { toast } from '@/components/ui/toast-store';

export interface NodeScanTypes {
  vulns: boolean;
  secrets: boolean;
  misconfig: boolean;
}

const ALL_TYPES: NodeScanTypes = { vulns: true, secrets: true, misconfig: true };

/**
 * Runs the node-wide scan with live progress in the deploy-feedback modal. The
 * node is captured once so the request and the progress stream stay bound to it
 * even if the active node changes mid-scan. The scan launcher and the Overview's
 * "Rescan node" verb run the same request.
 */
export function useNodeScan(onComplete?: () => void) {
  const { runWithLog } = useDeployFeedback();
  const { activeNode } = useNodes();
  const [running, setRunning] = useState(false);

  const scan = useCallback(async (types: NodeScanTypes = ALL_TYPES): Promise<void> => {
    setRunning(true);
    const opNodeId = activeNode?.id ?? null;
    const nodeLabel = activeNode?.name ?? 'this node';
    try {
      await runWithLog(
        { stackName: nodeLabel, action: 'scan', nodeId: opNodeId },
        async (started, sessionId) => {
          if (started) await started;
          const res = await apiFetch('/security/scan-node', withDeploySession(sessionId, {
            method: 'POST',
            nodeId: opNodeId,
            body: JSON.stringify({ vulns: types.vulns, secrets: types.secrets, misconfig: types.misconfig }),
          }));
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            const message = err?.error || 'Node scan failed';
            toast.error(message);
            return { ok: false, errorMessage: message };
          }
          // A 200 can still carry per-image/stack failures (the batch is
          // failure-tolerant); surface them so a partial scan does not read as clean.
          const result = await res.json().catch(() => null);
          if (result === null) {
            toast.warning('The scan finished, but its result could not be read.');
          } else {
            const failed = (result?.images?.failed ?? 0) + (result?.stacks?.failed ?? 0);
            if (failed > 0) toast.warning(`Scan completed with ${failed} failure${failed === 1 ? '' : 's'}.`);
          }
          return { ok: true };
        },
      );
      onComplete?.();
    } catch (error) {
      console.error('[Security] node scan failed:', error);
      toast.error('The node scan could not be started.');
    } finally {
      setRunning(false);
    }
  }, [runWithLog, activeNode, onComplete]);

  return { running, scan };
}
