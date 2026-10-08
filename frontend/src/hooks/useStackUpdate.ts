import { useCallback } from 'react';
import { toast } from '@/components/ui/toast-store';
import { useDeployFeedback } from '@/context/DeployFeedbackContext';
import { SENCHO_OPEN_STACK_EVENT, type SenchoOpenStackDetail } from '@/lib/events';
import { postStackUpdate } from '@/lib/stackUpdate';

interface StackUpdateRequest {
  nodeId: number;
  stackName: string;
}

export interface StackUpdateResult {
  ok: boolean;
  /** Why a digest rebuild is still detected after Compose, when the backend says so. */
  recheckWarning?: string;
}

/**
 * Update a stack on a given node from anywhere that is not the editor: the
 * request, the deploy-feedback session and the way each outcome is told to the
 * operator. The editor runs the same request (`postStackUpdate`) inside its own
 * state handling, so there is one update path with two presentations.
 *
 * A policy block cannot open the editor's policy dialog from here, so the toast
 * carries the way to the editor, where the dialog and its bypass live.
 */
export function useStackUpdate() {
  const { runWithLog } = useDeployFeedback();

  return useCallback(async ({ nodeId, stackName }: StackUpdateRequest): Promise<StackUpdateResult> => {
    let recheckWarning: string | undefined;
    const openEditor = {
      label: 'Open stack editor',
      onClick: () => window.dispatchEvent(new CustomEvent<SenchoOpenStackDetail>(SENCHO_OPEN_STACK_EVENT, {
        detail: { nodeId, stackName, destination: 'editor' },
      })),
    };
    try {
      const result = await runWithLog({ stackName, action: 'update', nodeId }, async (started, deploySessionId) => {
        await started;
        const outcome = await postStackUpdate({ nodeId, stackName, deploySessionId });
        switch (outcome.kind) {
          case 'ok':
            recheckWarning = outcome.recheckWarning;
            // With a health gate observing, finishing is not the final verdict, so
            // success is not claimed twice.
            if (outcome.healthGateId) toast.info(`${stackName} updated. Verifying health...`);
            else toast.success(`${stackName} updated successfully`);
            if (outcome.recheckWarning) toast.info(outcome.recheckWarning);
            return { ok: true as const, healthGateId: outcome.healthGateId };
          case 'self-stack': {
            const message = `${stackName} is the running Sencho instance, so it is protected here.`;
            toast.error(message, { action: openEditor });
            return { ok: false as const, errorMessage: message };
          }
          case 'busy':
            toast.error(outcome.message);
            return { ok: false as const, errorMessage: outcome.message };
          case 'policy-blocked': {
            const message = `Update blocked by policy "${outcome.policyName}"`;
            toast.error(message, { action: openEditor });
            return { ok: false as const, errorMessage: message };
          }
          case 'failed':
            toast.error(outcome.error.message);
            return { ok: false as const, errorMessage: outcome.error.message };
        }
      });
      return { ok: result.ok, recheckWarning };
    } catch (error) {
      console.error('Stack update failed:', error);
      toast.error(error instanceof Error ? error.message : 'Update failed');
      return { ok: false };
    }
  }, [runWithLog]);
}
