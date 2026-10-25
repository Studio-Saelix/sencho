import type { Request, Response } from 'express';
import { ComposeService } from '../services/ComposeService';
import { DOCKER_ENDPOINT_PROTECTED_CODE, type EndpointMutation } from './dockerEndpointGuard';

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
