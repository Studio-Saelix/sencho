import { Router, type Request, type Response } from 'express';
import { getActiveCapabilities, getSenchoVersion } from '../services/CapabilityRegistry';
import { MeshService } from '../services/MeshService';
import SelfUpdateService from '../services/SelfUpdateService';

// Captured at boot. Exposed via /api/health and /api/meta so the Fleet update
// overlay can distinguish a brand-new process from the old one still mid-pull.
const processStartedAt = Date.now();

export const metaRouter = Router();

// Public health endpoint (no auth). Used by Docker HEALTHCHECK and uptime monitors.
// The `mesh.dataPlane` block reports whether `MeshService.setupMeshNetwork`
// completed successfully; an `ok: false` value means cross-node mesh routing
// is disabled on this node and the operator should consult the activity log
// or set `SENCHO_MESH_SUBNET` to a free /24 and restart the container.
metaRouter.get('/health', (_req: Request, res: Response): void => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    startedAt: processStartedAt,
    mesh: {
      dataPlane: MeshService.getInstance().getDataPlaneStatus(),
    },
  });
});

// Public meta endpoint. Returns this instance's version and supported
// capabilities. No auth required (like /health). Used by remote nodes during
// connection tests.
metaRouter.get('/meta', (_req: Request, res: Response): void => {
  const updateError = SelfUpdateService.getInstance().getLastError();
  res.json({
    version: getSenchoVersion(),
    capabilities: getActiveCapabilities(),
    startedAt: processStartedAt,
    experimental: process.env.SENCHO_EXPERIMENTAL === 'true',
    ...(updateError ? { updateError } : {}),
  });
});
