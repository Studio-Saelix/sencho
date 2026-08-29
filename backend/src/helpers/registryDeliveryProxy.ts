import type { Request, Response } from 'express';
import type { Node } from '../services/DatabaseService';
import { augmentJsonBodyForRegistryDelivery, wouldAttemptRegistryDelivery } from './registryDeliveryOutbound';

export interface RegistryDeliveryProxyResult {
  /** When false, respond to the client with status/error instead of forwarding. */
  forward: boolean;
  status?: number;
  error?: string;
}

/**
 * When delivery can be negotiated, run hop-1 discover, assemble the envelope,
 * and buffer an augmented JSON body on req.rawBody. When capability or
 * confidentiality is absent, leaves the request unchanged (AUD-30).
 */
export async function augmentRemoteProxyWithRegistryDelivery(
  req: Request,
  nodeId: number,
  node: Node,
  target: { apiUrl: string; apiToken: string },
  rawBody: Buffer,
): Promise<RegistryDeliveryProxyResult> {
  const apiPath = `/api${req.path}`;

  let parsed: Record<string, unknown> = {};
  if (rawBody.length > 0) {
    try {
      parsed = JSON.parse(rawBody.toString('utf-8')) as Record<string, unknown>;
    } catch {
      return { forward: false, status: 400, error: 'Request body is not valid JSON' };
    }
  }

  const result = await augmentJsonBodyForRegistryDelivery({
    method: req.method,
    apiPath,
    nodeId,
    node,
    target,
    body: parsed,
    abortSignal: req.registryDeliveryAbortController?.signal,
  });

  if (!result.ok) {
    return { forward: false, status: result.status, error: result.error };
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

/**
 * Register abort listeners, then decide whether hop-1 registry delivery runs.
 * Abort is wired before the capability probe so a client disconnect during the
 * probe still cancels the hop.
 */
export async function shouldAttemptRegistryDeliveryProxyHop(
  req: Request,
  res: Response,
  nodeId: number,
  node: Node,
  method: string,
  deliveryApiPath: string,
): Promise<boolean> {
  ensureRegistryDeliveryHopAbortController(req, res);
  if (req.registryDeliveryAbortController?.signal.aborted) {
    return false;
  }
  const wouldAttempt = await wouldAttemptRegistryDelivery(nodeId, node, method, deliveryApiPath);
  if (req.registryDeliveryAbortController?.signal.aborted) {
    return false;
  }
  return wouldAttempt;
}
