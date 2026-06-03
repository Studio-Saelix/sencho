import { Router, type Request, type Response } from 'express';
import { requireAdmin, requireUserSession } from '../middleware/tierGates';
import { collectDiagnostics } from '../services/DiagnosticsService';
import { collectEnvironmentReport, buildRealProbes } from '../services/EnvironmentCheckService';
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

// First-run / preflight environment checks (Docker engine + Compose, the
// compose directory and its host path mapping, TLS, disk headroom). Same admin
// session gate as the recovery report. proto / host come from the request so
// the TLS verdict reflects how this browser reached the dashboard; behind a
// reverse proxy that terminates TLS, x-forwarded-proto carries the real scheme.
diagnosticsRouter.get('/environment', async (req: Request, res: Response): Promise<void> => {
    if (!requireUserSession(req, res)) return;
    if (!requireAdmin(req, res)) return;
    try {
        const proto = (req.get('x-forwarded-proto')?.split(',')[0].trim()) || req.protocol;
        const host = req.get('host') || '';
        const report = await collectEnvironmentReport(buildRealProbes({ proto, host }));
        res.json(report);
    } catch (err) {
        console.error('[diagnostics] failed to collect environment report:', (err as Error).message);
        res.status(500).json({ error: 'Failed to collect environment checks.' });
    }
});
