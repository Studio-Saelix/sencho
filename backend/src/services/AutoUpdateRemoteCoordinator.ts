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
import { SENCHO_LABEL_POLICY_CAPABILITY, SENCHO_UPDATE_LABEL } from '../helpers/senchoLabels';
import { buildSystemPolicyGateOptions, remoteCandidateGateRefusal } from '../helpers/policyGate';
import {
  describePolicySkip,
  readRemoteUpdatePolicy,
  unsupportedNodeMessage,
  type RemoteUpdatePolicy,
} from './updatePolicy';

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
  result: 'applied' | 'rejected' | 'policy_blocked' | 'stale_observation' | 'update_policy_skipped';
  healthGateId: string | null;
  /** Why the target's Docker endpoint guard refused the update, on a `rejected` result. */
  endpointRefusal?: string;
  /** The target's decision, on an `update_policy_skipped` result. Re-validated, never trusted raw. */
  updatePolicy?: RemoteUpdatePolicy;
}

const ENDPOINT_REFUSAL_MAX_LENGTH = 1000;

function checkedResult(value: unknown, stack: string): CheckedResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.contractVersion !== 1 || body.stack !== stack || typeof body.applied !== 'boolean'
    || !['applied', 'rejected', 'policy_blocked', 'stale_observation', 'update_policy_skipped'].includes(String(body.result))
    || (body.healthGateId !== null && typeof body.healthGateId !== 'string')
    || body.applied !== (body.result === 'applied')) return null;
  const endpointRefusal = body.result === 'rejected' && typeof body.endpointRefusal === 'string'
    ? body.endpointRefusal.replace(/\s+/g, ' ').trim().slice(0, ENDPOINT_REFUSAL_MAX_LENGTH)
    : '';
  // The target's decision is rebuilt field by field. A skip that cannot be read
  // is an unconfirmed outcome, so the whole envelope is refused.
  const updatePolicy = body.updatePolicy === undefined ? undefined : readRemoteUpdatePolicy(body.updatePolicy);
  if (updatePolicy === null) return null;
  if (body.result === 'update_policy_skipped' && !updatePolicy) return null;
  if (updatePolicy && updatePolicy.stack !== stack) return null;
  return {
    contractVersion: 1, stack, applied: body.applied, result: body.result as CheckedResult['result'], healthGateId: body.healthGateId,
    ...(endpointRefusal ? { endpointRefusal } : {}),
    ...(updatePolicy ? { updatePolicy } : {}),
  };
}

/** Uses checked execution only when both machine contracts are live on the target. */
export class AutoUpdateRemoteCoordinator {
  async execute(input: RemoteAutoUpdateInput): Promise<{ handled: false } | { handled: true; result: string; failed?: boolean }> {
    const meta = await NodeRegistry.getInstance().probeRemoteMeta(input.nodeId, AbortSignal.timeout(10_000));
    const nodeName = NodeRegistry.getInstance().getNode(input.nodeId)?.name ?? `node ${input.nodeId}`;
    // A node that did not answer is an unreachable failure, handled here rather
    // than handed to a legacy endpoint that could mutate images without ever
    // evaluating io.sencho.update.
    if (meta.kind !== 'ok') {
      return { handled: true, failed: true, result: this.unansweredLines(input, nodeName) };
    }
    // An unattended update on a node that cannot evaluate io.sencho.update is a
    // failure with a stated reason, never a green skip: the hub cannot know
    // whether that node's stacks declare `disabled`.
    if (!meta.meta.capabilities.includes(SENCHO_LABEL_POLICY_CAPABILITY)) {
      return { handled: true, failed: true, result: this.unsupportedLines(input, nodeName) };
    }
    // A node that advertises the label policy but not the older checked-update
    // contracts cannot be trusted with an unattended update either: it is a
    // node-level failure, not a per-stack skip, and its reason must say what
    // is actually missing rather than claim it does not read the label.
    if (!meta.meta.capabilities.includes('remote-image-inspect-v1')
      || !meta.meta.capabilities.includes('remote-auto-update-checked-v1')) {
      return { handled: true, failed: true, result: this.incompleteContractLines(input, nodeName) };
    }
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

  /** The failure lines for a node that answered nothing: unreachable, never "too old". */
  private unansweredLines(input: RemoteAutoUpdateInput, nodeName: string): string {
    const stacks = 'targets' in input.selection
      ? input.selection.targets
      : input.selection.target === '*' ? [null] : [input.selection.target];
    return stacks
      .map(stack => stack === null
        ? `Node "${nodeName}" failed: it did not answer, so the update could not be checked against ${SENCHO_UPDATE_LABEL}.`
        : `Stack "${stack}" failed: node "${nodeName}" did not answer, so the update could not be checked against ${SENCHO_UPDATE_LABEL}.`)
      .join('\n');
  }

  /** One failure line per requested stack, or one node-level line for a wildcard with no roster. */
  private unsupportedLines(input: RemoteAutoUpdateInput, nodeName: string): string {
    const stacks = 'targets' in input.selection
      ? input.selection.targets
      : input.selection.target === '*' ? [null] : [input.selection.target];
    return stacks.map(stack => unsupportedNodeMessage(nodeName, stack)).join('\n');
  }

  /**
   * The failure lines for a node that advertises the label policy but not the
   * checked remote-update contracts. It reads the label, so "does not evaluate
   * io.sencho.update" would be false; the update still cannot be confirmed, so
   * it fails the run like any other node-level capability failure.
   */
  private incompleteContractLines(input: RemoteAutoUpdateInput, nodeName: string): string {
    const stacks = 'targets' in input.selection
      ? input.selection.targets
      : input.selection.target === '*' ? [null] : [input.selection.target];
    const reason = `node "${nodeName}" advertises the label policy but does not support checked remote updates; update Sencho on that node.`;
    return stacks
      .map(stack => stack === null
        ? `Node "${nodeName}" failed: it advertises the label policy but does not support checked remote updates; update Sencho on that node.`
        : `Stack "${stack}" failed: ${reason}`)
      .join('\n');
  }

  private async executeStack(input: RemoteAutoUpdateInput, stack: string): Promise<string> {
    // The target's own gate decides the candidate when its build can see one. A
    // build that cannot is a different decision, and it is the hub's to make:
    // there is nobody on the target to ask. Checking here, before the forward,
    // keeps the refusal on the side that has the policy.
    const candidateRefusal = await remoteCandidateGateRefusal(
      input.nodeId,
      stack,
      buildSystemPolicyGateOptions(
        input.caller.kind === 'scheduled' ? 'system:scheduler' : 'system:image-update',
        { auditPath: '/api/auto-update/execute-checked' },
      ),
    );
    if (candidateRefusal) return `Stack "${stack}": ${candidateRefusal}`;
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
      // A refusal fails the run for this stack, with the target's reason, so it is not mistaken for a skipped update.
      if (result.endpointRefusal) return `Stack "${stack}" failed: ${result.endpointRefusal}`;
      // A declared policy is an outcome, not a failure, and the target's own
      // reason is relayed so a local and a remote run read the same.
      if (result.result === 'update_policy_skipped') {
        return `Stack "${stack}": ${describePolicySkip(result.updatePolicy!)}.`;
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
        body: {
          contractVersion: 1,
          stack,
          digestUpdateImages: gate.updatedImages,
          observationToken: facts.observationToken,
          // The trigger travels with the request so a remote run is recorded as
          // the scheduled or automatic run it actually was.
          trigger: input.caller.kind === 'scheduled' ? 'scheduled' : 'automatic',
        },
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
