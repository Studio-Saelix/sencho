import type { Request } from 'express';
import type { Node } from '../services/DatabaseService';
import { augmentJsonBodyForRegistryDelivery } from './registryDeliveryOutbound';

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
