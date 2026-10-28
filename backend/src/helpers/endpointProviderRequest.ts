import type { Request, Response } from 'express';
import type { ClaimResult } from '../services/ImageOperationService';

/** Advertised in /api/meta by a node that can replace its Docker endpoint during Update and Reapply. */
export const ENDPOINT_PROVIDER_CAPABILITY = 'endpoint-provider-replace';
/**
 * Advertised by a node that can replace only the endpoint and leave Sencho
 * running. A node without it (an older build) would treat the request as the
 * stack-scope replacement and restart Sencho, so the hub never sends it one.
 */
export const ENDPOINT_PROVIDER_ONLY_CAPABILITY = 'endpoint-provider-only';

export const ENDPOINT_PROVIDER_UNAVAILABLE_CODE = 'endpoint_provider_unavailable';

export const HARDENED_ENDPOINT_PROVIDER_REASON =
  'A hardened image update cannot also recreate the Docker endpoint. Update first, then use Reapply with the Docker endpoint option.';

/** What an Update or Reapply body asked for around the Docker endpoint container. */
export interface EndpointProviderChoice {
  /** Also recreate the container carrying this node's Docker API. */
  replace: boolean;
  /** Recreate only that container and leave Sencho running (Reapply only). */
  only: boolean;
}

/**
 * Parse the optional `replaceEndpointProvider` / `endpointProviderOnly` flags of
 * an Update or Reapply request. Omitted means false. Anything other than a
 * boolean is a 400 and returns null so the caller early-returns: the flags opt
 * into recreating the container carrying the Docker API, so a malformed value
 * is never guessed. `endpointProviderOnly` requires the other flag, and only
 * Reapply can leave Sencho running (an image update has to recreate it).
 */
export function parseEndpointProviderChoice(
  req: Request,
  res: Response,
  options: { allowOnly?: boolean } = {},
): EndpointProviderChoice | null {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const replace = body.replaceEndpointProvider;
  const only = body.endpointProviderOnly;
  if (replace !== undefined && replace !== null && typeof replace !== 'boolean') {
    res.status(400).json({ error: 'replaceEndpointProvider must be a boolean' });
    return null;
  }
  if (only !== undefined && only !== null && typeof only !== 'boolean') {
    res.status(400).json({ error: 'endpointProviderOnly must be a boolean' });
    return null;
  }
  if (only === true && replace !== true) {
    res.status(400).json({ error: 'endpointProviderOnly requires replaceEndpointProvider' });
    return null;
  }
  if (only === true && options.allowOnly === false) {
    res.status(400).json({ error: 'Only Reapply can recreate just the Docker endpoint; an image update also recreates Sencho.' });
    return null;
  }
  return { replace: replace === true, only: only === true };
}

/** Answers a refused claim with 409. Returns true when it did. */
export function respondClaimRefused(res: Response, claim: ClaimResult): boolean {
  if (claim.ok) return false;
  if (claim.failureCode === ENDPOINT_PROVIDER_UNAVAILABLE_CODE) {
    res.status(409).json({ error: claim.reason, code: claim.failureCode });
  } else {
    res.status(409).json({ error: 'An image operation is already in progress.', code: claim.failureCode });
  }
  return true;
}

/**
 * Turns the bounded update error code a remote reports in its public meta
 * into the text Fleet shows. Unknown codes pass through.
 */
export function describeRemoteUpdateError(code: string): string {
  switch (code) {
    case 'endpoint_provider_restored':
      return 'Replacing the Docker endpoint failed. The node restored its previous Docker endpoint container and reaches Docker again; fix that service\'s Compose configuration, then run Reapply again.';
    case 'endpoint_provider_recovery_required':
      return 'Replacing the Docker endpoint failed and the node could not confirm Sencho reaches Docker through the Docker endpoint or that the previous container was restored. On that host, check that the Docker endpoint service runs, then run Reapply again or bring it up with "docker compose up -d" in Sencho\'s Compose project directory.';
    case 'update_failed':
      return 'The node reported that the operation failed. Check Fleet on that node for details.';
    default:
      return code;
  }
}
