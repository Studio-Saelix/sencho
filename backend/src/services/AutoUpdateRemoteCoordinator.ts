import { NodeRegistry } from './NodeRegistry';
import { ImageUpdateService, type ImageCheckResult } from './ImageUpdateService';
import type { ImageUpdateStackFacts } from './imageUpdateFacts';
import { IMAGE_UPDATE_FACTS_IMAGE_LIMIT, IMAGE_UPDATE_FACTS_STACK_LIMIT } from './imageUpdateFacts';
import { isValidStackName } from '../utils/validation';
import { safeRemoteFetch } from '../utils/outboundTarget';
import { LicenseService } from './LicenseService';
import { PROXY_TIER_HEADER } from './license-headers';
import { prepareOutboundRegistryDeliveryBody, throwRegistryDeliveryRefusal } from '../helpers/registryDeliveryOutbound';
import { createAutoUpdateDigestGateState, recordAutoUpdateImageCheck, messageWhenNoDigestUpdate, messageWhenDigestApplyBlockedByCheckErrors } from '../helpers/autoUpdateDigestGate';
import { awaitHubPostUpdateVerification, type HubVerificationTransport } from './hubPostUpdateVerification';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';

export interface RemoteAutoUpdateScanner extends HubVerificationTransport {
  inspectRemoteStack(nodeId: number, stack: string, signal: AbortSignal): Promise<{
    facts: ImageUpdateStackFacts;
    imageResults: Map<string, ImageCheckResult>;
  }>;
  getRemoteRoster(nodeId: number, signal: AbortSignal): Promise<string[]>;
}

export interface RemoteAutoUpdateInput {
  nodeId: number;
  selection: { target: string } | { targets: string[] };
  caller: {
    kind: 'interactive' | 'scheduled';
    authorizeAll: (nodeId: number, stacks: readonly string[]) => Promise<void> | void;
    headers?: Record<string, string>;
  };
  scanner: RemoteAutoUpdateScanner;
}

interface CheckedResult {
  contractVersion: 1;
  stack: string;
  applied: boolean;
  result: 'applied' | 'rejected' | 'policy_blocked' | 'stale_observation';
  healthGateId: string | null;
}

function checkedResult(value: unknown, stack: string): CheckedResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.contractVersion !== 1 || body.stack !== stack || typeof body.applied !== 'boolean'
    || !['applied', 'rejected', 'policy_blocked', 'stale_observation'].includes(String(body.result))
    || (body.healthGateId !== null && typeof body.healthGateId !== 'string')
    || body.applied !== (body.result === 'applied')) return null;
  return { contractVersion: 1, stack, applied: body.applied, result: body.result as CheckedResult['result'], healthGateId: body.healthGateId };
}

/** Uses checked execution only when both machine contracts are live on the target. */
export class AutoUpdateRemoteCoordinator {
  async execute(input: RemoteAutoUpdateInput): Promise<{ handled: false } | { handled: true; result: string }> {
    const meta = await NodeRegistry.getInstance().probeRemoteMeta(input.nodeId, AbortSignal.timeout(10_000));
    if (meta.kind !== 'ok' || !meta.meta.capabilities.includes('remote-image-inspect-v1')
      || !meta.meta.capabilities.includes('remote-auto-update-checked-v1')) return { handled: false };
    const selected = 'targets' in input.selection ? input.selection.targets
      : input.selection.target === '*' ? await input.scanner.getRemoteRoster(input.nodeId, AbortSignal.timeout(90_000))
        : [input.selection.target];
    if (selected.length > IMAGE_UPDATE_FACTS_STACK_LIMIT || selected.some(stack => !isValidStackName(stack))) {
      throw new Error('Invalid automatic update stack roster');
    }
    const stacks = [...new Set(selected)];
    await input.caller.authorizeAll(input.nodeId, stacks);
    if (!ImageUpdateService.isChecksEnabled()) return { handled: true, result: 'Image update detection is disabled for this node; skipped.' };
    const results: string[] = [];
    for (const stack of stacks) {
      try {
        results.push(await this.executeStack(input, stack));
      } catch (error) {
        console.error(
          `[AutoUpdateCoordinator] Remote stack update failed for ${sanitizeForLog(stack)}:`,
          sanitizeForLog(getErrorMessage(error, 'unknown')),
        );
        results.push(`Stack "${stack}" failed: Remote automatic update did not complete.`);
      }
    }
    return { handled: true, result: results.length ? results.join('\n') : 'No stacks found on node; skipped.' };
  }

  private async executeStack(input: RemoteAutoUpdateInput, stack: string): Promise<string> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const prepared = await this.prepare(input, stack);
      if ('message' in prepared) return prepared.message;
      const target = NodeRegistry.getInstance().getProxyTarget(input.nodeId);
      if (!target) throw new Error('Remote target is unavailable');
      const response = await safeRemoteFetch(`${target.apiUrl.replace(/\/$/, '')}/api/auto-update/execute-checked`, {
        method: 'POST',
        headers: {
          ...input.caller.headers,
          'Content-Type': 'application/json', Authorization: `Bearer ${target.apiToken}`,
          [PROXY_TIER_HEADER]: LicenseService.getInstance().getProxyHeaders().tier,
        },
        body: JSON.stringify(prepared.body), signal: AbortSignal.timeout(300_000),
      }, target.trustedLoopback);
      const raw: unknown = await response.json();
      const result = checkedResult(raw, stack);
      if (!result) throw new Error('Unconfirmed remote automatic update outcome');
      if (response.status === 409 && result.result === 'stale_observation' && !result.applied) {
        if (attempt === 0) continue;
        return `Stack "${stack}": observation changed twice; skipped auto-update.`;
      }
      if (!response.ok || !result.applied) return `Stack "${stack}": ${result.result}; skipped auto-update.`;
      const verification = await awaitHubPostUpdateVerification({
        nodeId: input.nodeId, stack, targetResponse: { status: response.status, body: result }, caller: 'coordinator', transport: input.scanner,
      });
      const message = `Stack "${stack}": updated (${prepared.images.join(', ')}).`;
      return verification.detail ? `${message} ${verification.detail}` : message;
    }
    throw new Error('Automatic update observation retry exhausted');
  }

  private async prepare(input: RemoteAutoUpdateInput, stack: string): Promise<{ message: string } | { body: Record<string, unknown>; images: string[] }> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Automatic update preparation timed out')); }, 90_000);
    });
    const work = async (): Promise<{ message: string } | { body: Record<string, unknown>; images: string[] }> => {
      const { facts, imageResults } = await input.scanner.inspectRemoteStack(input.nodeId, stack, controller.signal);
      if (controller.signal.aborted) throw new Error('Automatic update preparation aborted');
      if (!facts.model.renderable || facts.name !== stack || facts.images.length > IMAGE_UPDATE_FACTS_IMAGE_LIMIT) {
        return { message: `Stack "${stack}": image facts are incomplete; skipped auto-update.` };
      }
      const gate = createAutoUpdateDigestGateState();
      for (const image of facts.images) {
        const result = imageResults.get(image.ref);
        if (!result) gate.checkErrors.push('Update check incomplete');
        else recordAutoUpdateImageCheck(gate, image.ref, result);
      }
      if (!gate.hasDigestUpdate) return { message: messageWhenNoDigestUpdate(stack, gate, facts.images.length) };
      const blocked = messageWhenDigestApplyBlockedByCheckErrors(stack, gate);
      if (blocked) return { message: blocked };
      const augmented = await prepareOutboundRegistryDeliveryBody({
        method: 'POST', apiPath: '/api/auto-update/execute-checked', nodeId: input.nodeId,
        body: { contractVersion: 1, stack, digestUpdateImages: gate.updatedImages, observationToken: facts.observationToken },
        abortSignal: controller.signal,
      });
      if (!augmented.ok) throwRegistryDeliveryRefusal(augmented);
      if (controller.signal.aborted) throw new Error('Automatic update preparation aborted');
      return { body: augmented.body, images: gate.updatedImages };
    };
    try { return await Promise.race([work(), deadline]); }
    finally { clearTimeout(timer); }
  }
}
