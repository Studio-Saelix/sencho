import axios from 'axios';
import type { Node } from '../services/DatabaseService';
import { DatabaseService } from '../services/DatabaseService';
import { NodeRegistry } from '../services/NodeRegistry';
import { PilotTunnelManager } from '../services/PilotTunnelManager';
import { RegistryDeliveryService } from '../services/RegistryDeliveryService';
import type { RegistryDeliveryDiscoverResponse } from '../services/RegistryDeliveryService';
import { REMOTE_REGISTRY_CREDENTIALS_CAPABILITY } from '../services/CapabilityRegistry';
import { remoteAdvertisesCapability } from './remoteCapabilities';
import {
  classifyRegistryDeliveryRouteClass,
  getRegistryDeliveryTotalBodyLimit,
  REGISTRY_DELIVERY_BODY_FIELD,
  REGISTRY_DELIVERY_FIELD_LIMIT_BYTES,
} from './registryDeliveryBodyLimits';
import { classifyRegistryDeliveryOp } from './registryOpClassifier';
import { buildRegistryDiscoverPayload } from './registryDeliveryDiscoverPayload';
import { getErrorMessage } from '../utils/errors';

export type RegistryDeliveryAugmentResult =
  | { ok: true; body: Record<string, unknown>; augmented: boolean }
  | { ok: false; status: number; error: string };

export interface AugmentRegistryDeliveryInput {
  method: string;
  apiPath: string;
  nodeId: number;
  node: Node;
  target: { apiUrl: string; apiToken: string };
  body: Record<string, unknown>;
  sourceKind?: string;
  prepId?: string;
  abortSignal?: AbortSignal;
}

function isTransportConfidential(nodeId: number, node: Node): boolean {
  const delivery = RegistryDeliveryService.getInstance();
  if (node.mode === 'pilot_agent') {
    return PilotTunnelManager.getInstance().isTunnelConfidential(nodeId);
  }
  return delivery.isProxyTransportConfidential(nodeId);
}

export async function wouldAttemptRegistryDelivery(
  nodeId: number,
  node: Node,
  method: string,
  apiPath: string,
): Promise<boolean> {
  const classification = classifyRegistryDeliveryOp(method, apiPath);
  if (!classification.eligible || !classification.stage) {
    return false;
  }
  if (!isTransportConfidential(nodeId, node)) {
    return false;
  }
  if (!await remoteAdvertisesCapability(nodeId, REMOTE_REGISTRY_CREDENTIALS_CAPABILITY)) {
    return false;
  }
  return classifyRegistryDeliveryRouteClass(method, apiPath) != null;
}

async function callTargetDiscover(
  target: { apiUrl: string; apiToken: string },
  body: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<RegistryDeliveryDiscoverResponse> {
  if (abortSignal?.aborted) {
    throw Object.assign(new Error('Registry delivery aborted'), { status: 499, code: 'ABORTED' });
  }
  const base = target.apiUrl.replace(/\/$/, '');
  const res = await axios.post(`${base}/api/registry-delivery/discover`, body, {
    headers: { Authorization: `Bearer ${target.apiToken}` },
    timeout: 30_000,
    maxBodyLength: REGISTRY_DELIVERY_FIELD_LIMIT_BYTES,
    signal: abortSignal,
    validateStatus: () => true,
  });
  if (abortSignal?.aborted) {
    throw Object.assign(new Error('Registry delivery aborted'), { status: 499, code: 'ABORTED' });
  }
  if (res.status < 200 || res.status >= 300) {
    const message = typeof res.data?.error === 'string'
      ? res.data.error
      : 'Registry delivery discovery failed on target';
    throw Object.assign(new Error(message), { status: res.status });
  }
  return res.data as RegistryDeliveryDiscoverResponse;
}

/**
 * Run hop-1 discover, assemble the delivery envelope, and merge it into a JSON
 * body for direct hub-to-remote fetch callers. When capability or confidentiality
 * is absent, returns the input body unchanged (AUD-30).
 */
export async function augmentJsonBodyForRegistryDelivery(
  input: AugmentRegistryDeliveryInput,
): Promise<RegistryDeliveryAugmentResult> {
  const classification = classifyRegistryDeliveryOp(input.method, input.apiPath);
  if (!classification.eligible || !classification.stage) {
    return { ok: true, body: input.body, augmented: false };
  }

  if (input.abortSignal?.aborted) {
    return { ok: false, status: 499, error: 'Request aborted' };
  }

  const confidential = isTransportConfidential(input.nodeId, input.node);
  const capable = await remoteAdvertisesCapability(input.nodeId, REMOTE_REGISTRY_CREDENTIALS_CAPABILITY);
  if (!confidential || !capable) {
    return { ok: true, body: input.body, augmented: false };
  }

  const routeClass = classifyRegistryDeliveryRouteClass(input.method, input.apiPath);
  if (!routeClass) {
    return { ok: true, body: input.body, augmented: false };
  }

  try {
    const discoverBody = buildRegistryDiscoverPayload({
      method: input.method,
      apiPath: input.apiPath,
      body: input.body,
    });
    if (!discoverBody) {
      return { ok: true, body: input.body, augmented: false };
    }

    const discover = await callTargetDiscover(input.target, discoverBody, input.abortSignal);
    if (input.abortSignal?.aborted) {
      return { ok: false, status: 499, error: 'Request aborted' };
    }
    const envelope = await RegistryDeliveryService.getInstance().buildHubEnvelope(input.nodeId, discover);
    if (!envelope) {
      return { ok: true, body: input.body, augmented: false };
    }

    const envelopeJson = JSON.stringify(envelope);
    if (Buffer.byteLength(envelopeJson, 'utf8') > REGISTRY_DELIVERY_FIELD_LIMIT_BYTES) {
      return {
        ok: false,
        status: 413,
        error: 'Registry delivery envelope too large',
      };
    }

    const parsed = { ...input.body };
    parsed[REGISTRY_DELIVERY_BODY_FIELD] = envelope;
    const augmented = Buffer.from(JSON.stringify(parsed), 'utf-8');
    const totalLimit = getRegistryDeliveryTotalBodyLimit(routeClass);
    if (augmented.length > totalLimit) {
      return {
        ok: false,
        status: 413,
        error: 'Request body exceeds registry delivery limit',
      };
    }

    return { ok: true, body: parsed, augmented: true };
  } catch (error) {
    if (input.abortSignal?.aborted || (error as { code?: string }).code === 'ABORTED') {
      return { ok: false, status: 499, error: 'Request aborted' };
    }
    if (axios.isCancel(error)) {
      return { ok: false, status: 499, error: 'Request aborted' };
    }
    const status = Number((error as { status?: number }).status) || 500;
    console.error(
      '[registryDeliveryOutbound] hop-1 failed:',
      getErrorMessage(error, 'unknown'),
    );
    return {
      ok: false,
      status,
      error: status >= 500 ? 'Registry delivery failed' : getErrorMessage(error, 'Registry delivery failed'),
    };
  }
}

/**
 * Convenience wrapper for services that already validated the remote target.
 * Loads node + proxy target from the registry.
 */
export async function prepareOutboundRegistryDeliveryBody(options: {
  method: string;
  apiPath: string;
  nodeId: number;
  body?: Record<string, unknown> | null;
  sourceKind?: string;
  prepId?: string;
  abortSignal?: AbortSignal;
}): Promise<RegistryDeliveryAugmentResult> {
  const body = options.body ?? {};
  const node = DatabaseService.getInstance().getNode(options.nodeId);
  const target = NodeRegistry.getInstance().getProxyTarget(options.nodeId);
  if (!node || !target) {
    return { ok: true, body, augmented: false };
  }
  return augmentJsonBodyForRegistryDelivery({
    method: options.method,
    apiPath: options.apiPath,
    nodeId: options.nodeId,
    node,
    target,
    body,
    sourceKind: options.sourceKind,
    prepId: options.prepId,
    abortSignal: options.abortSignal,
  });
}
