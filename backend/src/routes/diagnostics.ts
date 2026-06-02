import { Router, type Request, type Response } from 'express';
import { requireAdmin, requireUserSession } from '../middleware/tierGates';
import { collectDiagnostics } from '../services/DiagnosticsService';
import DockerController from '../services/DockerController';
import { withTimeout } from '../utils/withTimeout';

export const diagnosticsRouter = Router();

const DOCKER_PING_TIMEOUT_MS = 2000;

// Recovery diagnostics for the local control plane. Restricted to a genuine
// signed-in admin session: requireUserSession rejects API tokens and
// node_proxy / pilot_tunnel machine credentials so a long-lived machine token
// cannot read the control plane's configuration inventory. Read-only and
// secret-free (see DiagnosticsService for the redaction allowlist). The Docker
// probe is bounded and wrapped so a down or hung daemon yields
// `docker.reachable: false` instead of failing the whole request, which is the
// exact condition an operator opens this surface to diagnose.
diagnosticsRouter.get('/', async (req: Request, res: Response): Promise<void> => {
    if (!requireUserSession(req, res)) return;
    if (!requireAdmin(req, res)) return;
    try {
        const report = await collectDiagnostics({
            checkDocker: async () => {
                await withTimeout(
                    DockerController.getInstance().getDocker().ping(),
                    DOCKER_PING_TIMEOUT_MS,
                    'docker-ping',
                );
                return true;
            },
        });
        res.json(report);
    } catch (err) {
        console.error('[diagnostics] failed to collect report:', (err as Error).message);
        res.status(500).json({ error: 'Failed to collect diagnostics.' });
    }
});
