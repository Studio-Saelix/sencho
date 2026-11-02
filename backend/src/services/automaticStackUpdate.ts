import { enforcePolicyPreDeploy, type PolicyEnforcementOptions } from './PolicyEnforcement';
import { describePolicyBlock } from '../helpers/policyGate';
import { StackOpLockService, stackOpSkipMessage } from './StackOpLockService';
import { StackUpdateOrchestrator } from './StackUpdateOrchestrator';
import { ComposeService } from './ComposeService';
import { HealthGateService } from './HealthGateService';
import { StackUpdateRecoveryService } from './StackUpdateRecoveryService';
import { ImageUpdateService, UPDATE_VERIFICATION_INCOMPLETE_WARNING } from './ImageUpdateService';
import { NotificationService } from './NotificationService';
import { invalidateNodeCaches } from '../helpers/cacheInvalidation';
import { getRegistryDeliveryLockContext } from '../helpers/registryDeliveryContext';
import { sanitizeForLog } from '../utils/safeLog';
import {
  describePolicySkip,
  recordUpdatePolicyDecision,
  resolveUpdatePolicy,
  toUpdatePolicyWire,
  type RemoteUpdatePolicy,
} from './updatePolicy';

/** How an automatic update was asked for, so a remote run records the same trigger as a local one. */
export type AutomaticUpdateTrigger = 'scheduled' | 'automatic';

export interface AutomaticStackUpdateInput {
  nodeId: number;
  stackName: string;
  updatedImages: string[];
  policyOptions: PolicyEnforcementOptions;
  verificationOwner: 'hub_authority' | 'target_local';
  observation?: { verify: () => Promise<void>; consume: () => Promise<void> };
  /** Defaults to `automatic`; a scheduled run carries `scheduled` so the two never blur. */
  trigger?: AutomaticUpdateTrigger;
}

export interface AutomaticStackUpdateResult {
  result: 'applied' | 'rejected' | 'policy_blocked' | 'update_policy_skipped';
  applied: boolean;
  healthGateId: string | null;
  message: string;
  recheckWarning?: string;
  /** Why the Docker endpoint guard refused the update, so a remote caller can report it. */
  endpointRefusal?: string;
  /** The decision behind an `update_policy_skipped`, for a remote caller to re-validate. */
  updatePolicy?: RemoteUpdatePolicy;
}

/** Shared automatic mutation pipeline. Checked observations are validated under its exact stack lock. */
export async function applyAutomaticStackUpdate(input: AutomaticStackUpdateInput): Promise<AutomaticStackUpdateResult> {
  const { nodeId, stackName } = input;
  const trigger = input.trigger ?? 'automatic';
  const lock = await StackOpLockService.getInstance().runExclusive(
    nodeId, stackName, 'update', 'system', async () => {
      // Update policy first: it is cheap, deterministic, and refuses before the
      // gate writes evidence or the observation is spent, so a skipped stack
      // never burns a checked observation or records a scan it did not act on.
      const updatePolicy = await resolveUpdatePolicy(nodeId, {
        stack: stackName, target: { scope: 'stack' }, trigger,
      });
      if (updatePolicy.decision !== 'allow') {
        recordUpdatePolicyDecision(nodeId, updatePolicy, input.policyOptions.actor ?? null);
        return {
          result: 'update_policy_skipped' as const,
          applied: false,
          healthGateId: null,
          message: `Stack "${stackName}": ${describePolicySkip(updatePolicy)}.`,
          updatePolicy: toUpdatePolicyWire(updatePolicy),
        };
      }
      await input.observation?.verify();
      const policy = await enforcePolicyPreDeploy(stackName, nodeId, { ...input.policyOptions, bypass: false });
      if (!policy.ok) {
        // Same wording as every other path, so a scanner outage is not reported
        // as a matched finding on an unattended update.
        const message = describePolicyBlock(policy.policy, policy.violations, 'update', policy.evidence);
        // Prefixed with the action and stack, as the scheduler's copy of this
        // same sentence is. Dispatching it bare made one operator-visible message
        // have two shapes depending on which path blocked, so an alert filter
        // written against the prefixed form silently missed these.
        NotificationService.getInstance().dispatchAlert(
            'warning',
            'scan_finding',
            `Auto-update blocked for "${stackName}": ${message}`,
            { stackName, actor: 'system:image-update' },
        );
        return { result: 'policy_blocked' as const, applied: false, healthGateId: null, message: `Stack "${stackName}": ${message}` };
      }
      // Before the observation is spent: a refused update leaves it usable for a
      // later attempt, and the caller is told why instead of seeing a failure.
      const endpointRefusal = await ComposeService.getInstance(nodeId).evaluateDockerEndpoint(stackName, { kind: 'update' });
      if (endpointRefusal) {
        return {
          result: 'rejected' as const, applied: false, healthGateId: null,
          message: `Stack "${stackName}": ${endpointRefusal.message}`, endpointRefusal: endpointRefusal.message,
        };
      }
      await input.observation?.consume();
      const mutation = await StackUpdateOrchestrator.getInstance().execute(
        { nodeId, stackName, target: { scope: 'stack' }, trigger, actor: input.policyOptions.actor, policy: updatePolicy },
        { atomic: true, terminalWs: null },
      );
      const healthGateId = HealthGateService.getInstance().beginStack(nodeId, stackName, 'update', input.policyOptions.actor, {
        deployedGenerationId: mutation && mutation.kind === 'stack_compose_done' ? mutation.deployedGenerationId : null,
      });
      if (mutation && mutation.kind === 'stack_compose_done' && mutation.recoveryId) {
        StackUpdateRecoveryService.getInstance().linkGateOrRetain(mutation.recoveryId, healthGateId);
      }
      return finishAutomaticUpdate(input, healthGateId);
    }, getRegistryDeliveryLockContext(),
  );
  return lock.ran ? lock.result : {
    result: 'rejected', applied: false, healthGateId: null,
    message: stackOpSkipMessage(stackName, lock.existing.action),
  };
}

async function finishAutomaticUpdate(input: AutomaticStackUpdateInput, healthGateId: string | null): Promise<AutomaticStackUpdateResult> {
  const { nodeId, stackName } = input;
  let recheckWarning: string | undefined;
  if (input.verificationOwner === 'target_local') {
    try {
      const recheck = await ImageUpdateService.getInstance().recheckStack(nodeId, stackName);
      recheckWarning = recheck.warning ?? undefined;
    } catch (error) {
      console.warn('[AutoUpdate] Post-update verification failed for %s:', sanitizeForLog(stackName), error);
      recheckWarning = UPDATE_VERIFICATION_INCOMPLETE_WARNING;
    }
  }
  invalidateNodeCaches(nodeId);
  NotificationService.getInstance().broadcastEvent({
    type: 'state-invalidate', scope: 'image-updates', nodeId, stackName, action: 'stack-updated', ts: Date.now(),
  });
  NotificationService.getInstance().dispatchAlert('info', 'image_update_applied',
    `Auto-update: stack "${stackName}" updated with new images`, { stackName, actor: 'system:image-update' });
  const message = `Stack "${stackName}": updated (${input.updatedImages.join(', ')}).`;
  return { result: 'applied', applied: true, healthGateId, recheckWarning, message: recheckWarning ? `${message} ${recheckWarning}` : message };
}
