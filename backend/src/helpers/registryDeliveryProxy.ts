import type { Request, Response } from 'express';
import type { Node } from '../services/DatabaseService';
import type { ProxyTarget } from '../services/NodeRegistry';
import type { RemoteCapabilityProbe } from './remoteCapabilities';
import {
  augmentJsonBodyForRegistryDelivery,
  REGISTRY_DELIVERY_ABORTED,
  wouldAttemptRegistryDelivery,
} from './registryDeliveryOutbound';

/**
 * Either forward the request unchanged, or respond to the client with the
 * status/error/code instead of forwarding.
 */
export type RegistryDeliveryProxyResult =
  | { forward: true }
  | { forward: false; status: number; error: string; code: string };

/**
 * Run hop-1 discover, then either attach the assembled envelope to the
 * forwarded JSON body or refuse instead of forwarding: 409 for missing
 * credentials or a non-confidential transport, 413 for an oversized envelope
 * or merged body, 499 on client disconnect, 400 for a body that is not valid
 * JSON, 500 on a failed or invalid discover response. Remotes that cannot
 * take delivery (unsupported or unreachable) pass the request through
 * unchanged.
 */
export async function augmentRemoteProxyWithRegistryDelivery(
  req: Request,
  nodeId: number,
  node: Node,
  target: ProxyTarget,
  rawBody: Buffer,
  capabilityProbe: RemoteCapabilityProbe,
): Promise<RegistryDeliveryProxyResult> {
  const apiPath = `/api${req.path}`;

  let parsed: Record<string, unknown> = {};
  if (rawBody.length > 0) {
    try {
      parsed = JSON.parse(rawBody.toString('utf-8')) as Record<string, unknown>;
    } catch {
      return { forward: false, status: 400, error: 'Request body is not valid JSON', code: 'REGISTRY_DELIVERY_INVALID_BODY' };
    }
  }

  const result = await augmentJsonBodyForRegistryDelivery({
    method: req.method,
    apiPath,
    nodeId,
    node,
    target,
    body: parsed,
    capabilityProbe,
    abortSignal: req.registryDeliveryAbortController?.signal,
  });

  if (!result.ok) {
    return { forward: false, status: result.status, error: result.error, code: result.code };
  }

  if (req.registryDeliveryAbortController?.signal.aborted) {
    return { forward: false, status: 499, error: 'Request aborted', code: REGISTRY_DELIVERY_ABORTED };
  }

  if (result.augmented || rawBody.length === 0) {
    req.rawBody = Buffer.from(JSON.stringify(result.body), 'utf-8');
  } else if (rawBody.length > 0) {
    req.rawBody = rawBody;
  }

  return { forward: true };
}

/** Bind hop-1 abort to client disconnect before any async capability work. */
export function ensureRegistryDeliveryHopAbortController(req: Request, res: Response): void {
  if (req.registryDeliveryAbortController) return;
  const abortController = new AbortController();
  req.registryDeliveryAbortController = abortController;
  const onReqAborted = () => {
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  };
  const onResClose = () => {
    if (!res.writableEnded && !abortController.signal.aborted) {
      abortController.abort();
    }
  };
  let detached = false;
  const detach = () => {
    if (detached) return;
    detached = true;
    req.off('aborted', onReqAborted);
    res.off('close', onResClose);
  };
  req.on('aborted', onReqAborted);
  res.on('close', onResClose);
  res.once('finish', detach);
  res.once('close', detach);
}

export type RegistryDeliveryProxyHopDecision =
  | { action: 'attempt'; probe: 'supported' }
  | { action: 'skip' }
  | { action: 'aborted' };

export type RegistryDeliveryProxyGateResult =
  | { outcome: 'continue' }
  | { outcome: 'stop' }
  | { outcome: 'run-delivery'; probe: 'supported' };

/**
 * Register abort listeners, then decide whether hop-1 registry delivery runs.
 * Abort is wired before the capability probe so a client disconnect during the
 * probe still cancels the hop. Aborted is distinct from skip so callers do not
 * forward consequential requests after cancellation.
 */
export async function decideRegistryDeliveryProxyHop(
  req: Request,
  res: Response,
  nodeId: number,
  method: string,
  deliveryApiPath: string,
): Promise<RegistryDeliveryProxyHopDecision> {
  if (req.destroyed || req.aborted) {
    return { action: 'aborted' };
  }
  ensureRegistryDeliveryHopAbortController(req, res);
  if (req.registryDeliveryAbortController?.signal.aborted) {
    return { action: 'aborted' };
  }
  const probe = await wouldAttemptRegistryDelivery(nodeId, method, deliveryApiPath);
  if (
    req.destroyed
    || req.aborted
    || req.registryDeliveryAbortController?.signal.aborted
  ) {
    return { action: 'aborted' };
  }
  return probe === 'supported' ? { action: 'attempt', probe } : { action: 'skip' };
}

/**
 * Map an eligible-route registry delivery decision to proxy gate behavior.
 */
export async function evaluateRegistryDeliveryProxyGate(
  req: Request,
  res: Response,
  nodeId: number,
  method: string,
  deliveryApiPath: string,
): Promise<RegistryDeliveryProxyGateResult> {
  const decision = await decideRegistryDeliveryProxyHop(
    req,
    res,
    nodeId,
    method,
    deliveryApiPath,
  );
  if (decision.action === 'aborted') {
    return { outcome: 'stop' };
  }
  if (decision.action === 'attempt') {
    return { outcome: 'run-delivery', probe: decision.probe };
  }
  return { outcome: 'continue' };
}
