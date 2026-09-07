import { Router, type Request, type Response } from 'express';
import { requireUserSession } from '../middleware/tierGates';
import { classifyImageChannel, type ImageChannel } from '../helpers/imageChannel';
import type { BuildChannel } from '../helpers/selfUpdateCompose';
import SelfIdentityService from '../services/SelfIdentityService';

export const buildInfoRouter = Router();

/** Wire shape of GET /api/build-info. `restricted: true` implies `imageRef` and
 *  `revision` are nulled for a hardened image viewed by a non-admin. */
interface BuildInfoResponse {
  version: string | null;
  channel: BuildChannel;
  imageChannel: ImageChannel;
  imageRef: string | null;
  imageId: string | null;
  revision: string | null;
  restricted: boolean;
}

// Canonical runtime build identity of the control instance. Proxy-exempt (see
// helpers/proxyExemptPaths.ts) so it is always served by the local hub, never
// forwarded to a remote node. The running image reference can carry a private
// registry/repository name, so the endpoint requires a human session and
// redacts hardened-image references to non-admins via `restricted: true` (the
// UI shows "Restricted", never "Unknown", when set).
buildInfoRouter.get('/', async (req: Request, res: Response): Promise<void> => {
  if (!requireUserSession(req, res)) return;
  const service = SelfIdentityService.getInstance();
  // Await the detached revision enrichment so a transient null is never the
  // settled value of a successful response. Bounded by the inspect timeout and
  // never rejects, so this adds at most a short wait on the first read.
  await service.whenRevisionResolved();
  const identity = service.getBuildInfo();
  const isAdmin = req.user?.role === 'admin';
  const imageChannel = identity.imageRef ? classifyImageChannel(identity.imageRef) : 'unknown';
  const restricted = !isAdmin && imageChannel === 'hardened';
  res.json({
    version: identity.version,
    channel: identity.channel,
    imageChannel,
    imageRef: restricted ? null : identity.imageRef,
    imageId: identity.imageId,
    revision: restricted ? null : identity.revision,
    restricted,
  } satisfies BuildInfoResponse);
});