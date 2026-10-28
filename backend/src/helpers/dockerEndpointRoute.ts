import type { Request, Response } from 'express';
import { ComposeService } from '../services/ComposeService';
import {
  DOCKER_ENDPOINT_PROTECTED_CODE,
  isDockerEndpointProtectedError,
  type EndpointMutation,
} from './dockerEndpointGuard';

/**
 * Route-level front of the Docker endpoint guard: when `mutation` would stop or
 * recreate the container carrying this node's Docker API, answer 409 with the
 * reason and return true (the caller returns). If the check itself fails, the
 * request is refused too: the guard exists for the case where Docker is not
 * answering as expected, so an error is not a pass.
 */
export async function refuseIfDockerEndpoint(
  req: Request,
  res: Response,
  stackName: string,
  mutation: EndpointMutation,
): Promise<boolean> {
  try {
    const refusal = await ComposeService.getInstance(req.nodeId).evaluateDockerEndpoint(stackName, mutation);
    if (!refusal) return false;
    res.status(409).json({ error: refusal.message, code: DOCKER_ENDPOINT_PROTECTED_CODE, reason: refusal.reason });
    return true;
  } catch (error) {
    console.error('[DockerEndpointGuard] Check failed; refusing the request:', error);
    res.status(500).json({ error: 'Could not verify that this operation keeps the Docker connection safe.' });
    return true;
  }
}

/**
 * Answers 409 with the guard's code when `error` is a refusal raised inside the
 * operation (the in-lock re-check, or a background path that reached it after
 * the route's own check passed). Returns false for any other error.
 */
export function sendIfDockerEndpointProtected(res: Response, error: unknown): boolean {
  if (!isDockerEndpointProtectedError(error)) return false;
  if (!res.headersSent) {
    // A restore through this node (the hub rolling a rollout back) needs to know
    // whether anything moved before the refusal.
    res.status(409).json({
      error: error.message,
      code: DOCKER_ENDPOINT_PROTECTED_CODE,
      reason: error.reason,
      ...(error.failureClass ? { failureClass: error.failureClass } : {}),
    });
  }
  return true;
}
