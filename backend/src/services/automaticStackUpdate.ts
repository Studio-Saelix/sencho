import { enforcePolicyPreDeploy, type PolicyEnforcementOptions } from './PolicyEnforcement';
import { StackOpLockService, stackOpSkipMessage } from './StackOpLockService';
import { StackUpdateOrchestrator } from './StackUpdateOrchestrator';
import { HealthGateService } from './HealthGateService';
import { StackUpdateRecoveryService } from './StackUpdateRecoveryService';
import { ImageUpdateService, UPDATE_VERIFICATION_INCOMPLETE_WARNING } from './ImageUpdateService';
import { NotificationService } from './NotificationService';
import { invalidateNodeCaches } from '../helpers/cacheInvalidation';
import { getRegistryDeliveryLockContext } from '../helpers/registryDeliveryContext';
import { summarizeBlockReasons } from '../utils/policy-risk';
import { sanitizeForLog } from '../utils/safeLog';

export interface AutomaticStackUpdateInput {
  nodeId: number;
  stackName: string;
  updatedImages: string[];
  policyOptions: PolicyEnforcementOptions;
  verificationOwner: 'hub_authority' | 'target_local';
  observation?: { verify: () => Promise<void>; consume: () => Promise<void> };
}

export interface AutomaticStackUpdateResult {
  result: 'applied' | 'rejected' | 'policy_blocked';
  applied: boolean;
  healthGateId: string | null;
  message: string;
  recheckWarning?: string;
}

/** Shared automatic mutation pipeline. Checked observations are validated under its exact stack lock. */
export async function applyAutomaticStackUpdate(input: AutomaticStackUpdateInput): Promise<AutomaticStackUpdateResult> {
  const { nodeId, stackName } = input;
  const lock = await StackOpLockService.getInstance().runExclusive(
    nodeId, stackName, 'update', 'system', async () => {
      await input.observation?.verify();
      const policy = await enforcePolicyPreDeploy(stackName, nodeId, { ...input.policyOptions, bypass: false });
      if (!policy.ok) {
        const images = policy.violations.map(v => v.imageRef).join(', ');
        const message = `Policy "${policy.policy?.name}" blocked auto-update: ${policy.violations.length} image(s) matched ${summarizeBlockReasons(policy.violations)}${images ? ` (${images})` : ''}`;
        NotificationService.getInstance().dispatchAlert('warning', 'scan_finding', message, { stackName, actor: 'system:image-update' });
        return { result: 'policy_blocked' as const, applied: false, healthGateId: null, message: `Stack "${stackName}": ${message}` };
      }
      await input.observation?.consume();
      const mutation = await StackUpdateOrchestrator.getInstance().execute(
        { nodeId, stackName, target: { scope: 'stack' }, trigger: 'automatic', actor: input.policyOptions.actor },
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
