import { useCallback } from 'react';
import { toast } from '@/components/ui/toast-store';
import { useDeployFeedback } from '@/context/DeployFeedbackContext';
import { openEndpointRefusalInEditor } from '@/lib/endpointRefusalHandoff';
import { SENCHO_OPEN_STACK_EVENT, type SenchoOpenStackDetail } from '@/lib/events';
import { postStackUpdate, type StackUpdateOutcome } from '@/lib/stackUpdate';
import { toastUpdatePolicyRefusal } from '@/lib/updatePolicyRefusal';

interface StackUpdateRequest {
  nodeId: number;
  stackName: string;
}

export type StackUpdateResult =
  /** `recheckWarning` is why a digest rebuild is still detected after Compose, when the backend says so. */
  | { ok: true; recheckWarning?: string }
  | { ok: false };

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
        let outcome: StackUpdateOutcome;
        try {
          outcome = await postStackUpdate({ nodeId, stackName, deploySessionId });
        } catch (error) {
          // The request never got an answer (dropped connection, aborted). The
          // deploy panel records the failure, but it can be hidden, so say it here.
          console.error('Stack update request failed:', error);
          const message = error instanceof Error ? error.message : 'Update failed';
          toast.error(message);
          return { ok: false as const, errorMessage: message };
        }
        switch (outcome.kind) {
          case 'ok':
            recheckWarning = outcome.recheckWarning;
            // A recheck warning replaces the success line: it says the update ran
            // and what is still detected, so the two are not stacked.
            if (outcome.recheckWarning) toast.info(outcome.recheckWarning);
            // With a health gate observing, finishing is not the final verdict, so
            // success is not claimed twice.
            else if (outcome.healthGateId) toast.info(`${stackName} updated. Verifying health...`);
            else toast.success(`${stackName} updated successfully`);
            return { ok: true as const, healthGateId: outcome.healthGateId };
          case 'self-stack': {
            const message = `${stackName} is the running Sencho instance, so it is protected here.`;
            toast.error(message, { action: openEditor });
            return { ok: false as const, errorMessage: message };
          }
          case 'docker-endpoint':
            // This view has no endpoint-preview surface; hand the actual
            // refusal to the editor so the same node, stack and provider are
            // offered the safe replacement, not a generic navigation.
            toast.error(outcome.refusal.message, {
              action: {
                label: 'Open stack editor',
                onClick: () => { openEndpointRefusalInEditor(nodeId, stackName, outcome.refusal); },
              },
            });
            return { ok: false as const, errorMessage: outcome.refusal.message };
          case 'busy':
            toast.error(outcome.message);
            return { ok: false as const, errorMessage: outcome.message };
          case 'policy-blocked': {
            const message = `Update blocked by policy "${outcome.policyName}"`;
            toast.error(message, { action: openEditor });
            return { ok: false as const, errorMessage: message };
          }
          case 'update-policy-blocked':
            // The label is the only place this decision can change, so the toast
            // names the editor and the Compose file rather than a settings page.
            toastUpdatePolicyRefusal(outcome.refusal, { nodeId, stackName, inEditor: false });
            return { ok: false as const, errorMessage: outcome.refusal.message };
          case 'failed': {
            // The classification names the cause and the next step; a rollback means
            // the stack is back on its old version.
            const { failure, rolledBack } = outcome.error;
            const message = [
              outcome.error.message,
              rolledBack ? 'The stack was rolled back to its previous version.' : null,
              failure ? `${failure.label}. ${failure.suggestion}` : null,
            ].filter(Boolean).join(' ');
            toast.error(message);
            return { ok: false as const, errorMessage: message };
          }
        }
      });
      return result.ok ? { ok: true, recheckWarning } : { ok: false };
    } catch (error) {
      console.error('Stack update failed:', error);
      toast.error(error instanceof Error ? error.message : 'Update failed');
      return { ok: false };
    }
  }, [runWithLog]);
}
