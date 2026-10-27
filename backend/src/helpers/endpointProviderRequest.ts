import type { Request, Response } from 'express';
import type { ClaimResult } from '../services/ImageOperationService';

/** Advertised in /api/meta by a node that can replace its Docker endpoint during Update and Reapply. */
export const ENDPOINT_PROVIDER_CAPABILITY = 'endpoint-provider-replace';

export const ENDPOINT_PROVIDER_UNAVAILABLE_CODE = 'endpoint_provider_unavailable';

export const HARDENED_ENDPOINT_PROVIDER_REASON =
  'A hardened image update cannot also recreate the Docker endpoint. Update first, then use Reapply with the Docker endpoint option.';

/**
 * Parse the optional `replaceEndpointProvider` flag of an Update or Reapply
 * request. Omitted means false. Anything other than a boolean is a 400 and
 * returns null so the caller early-returns: the flag opts into recreating the
 * container carrying the Docker API, so a malformed value is never guessed.
 */
export function parseReplaceEndpointProvider(req: Request, res: Response): boolean | null {
  const raw = (req.body ?? {})?.replaceEndpointProvider;
  if (raw === undefined || raw === null) return false;
  if (typeof raw !== 'boolean') {
    res.status(400).json({ error: 'replaceEndpointProvider must be a boolean' });
    return null;
  }
  return raw;
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
      return 'Replacing the Docker endpoint failed and the node could not restore the previous container. On that host, run "docker compose up -d" for the Docker endpoint service in Sencho\'s Compose project directory, then check Fleet.';
    default:
      return code;
  }
}
