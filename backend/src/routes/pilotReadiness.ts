import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { readPersistedToken } from '../pilot/agent';
import {
  PILOT_DATA_MOUNT,
  PILOT_DATA_VOLUME,
  PILOT_PROJECT_NAME,
  READINESS_CONTRACT_VERSION,
  REPORTED_CHECK_IDS,
  type PilotReadinessReport,
  type ReportedCheck,
} from '../pilot/readinessContract';
import DockerController from '../services/DockerController';
import { buildRealProbes, collectEnvironmentReport, type EnvironmentProbes } from '../services/EnvironmentCheckService';
import { PROXY_ROLE_HEADER } from '../services/license-headers';
import { getSenchoVersion } from '../services/CapabilityRegistry';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';
import { withTimeout } from '../utils/withTimeout';

/**
 * The Pilot agent's readiness report (see `pilot/readinessContract.ts`).
 *
 * Read-only and narrow: it answers the hub's question "can this agent run
 * deployments" with facts about this agent, and nothing else. It is not the
 * environment diagnostics route and takes no input but the hub's nonce.
 *
 * Only the hub's own call reaches it: the request must arrive through the
 * Pilot tunnel (the agent re-signs every tunnelled request as `pilot_tunnel`)
 * and carry no forwarded user role, which the hub's proxy adds to every
 * request it relays for a signed-in user. Outside Pilot mode the route does
 * not exist.
 */
export const pilotReadinessRouter = Router();

const DOCKER_TIMEOUT_MS = 5000;
const NONCE_PATTERN = /^[a-f0-9]{32,64}$/;

export interface ReadinessProbes {
  environment: () => EnvironmentProbes;
  dockerVersion: () => Promise<{ Version?: string; ApiVersion?: string }>;
  listContainers: () => Promise<Array<{ State?: string; Labels?: Record<string, string>; Mounts?: Array<{ Type?: string; Name?: string; Destination?: string }> }>>;
  persistedToken: () => string | null;
  now: () => number;
}

function realProbes(): ReadinessProbes {
  return {
    // The TLS row reflects how a browser reached a dashboard, which an agent has none of; the hub judges the tunnel's own transport.
    environment: () => buildRealProbes({ proto: 'https', host: 'pilot' }),
    dockerVersion: () => withTimeout(DockerController.getInstance().getDocker().version(), DOCKER_TIMEOUT_MS, 'docker-version'),
    listContainers: () => withTimeout(DockerController.getInstance().getDocker().listContainers({ all: true }), DOCKER_TIMEOUT_MS, 'docker-list'),
    persistedToken: readPersistedToken,
    now: () => Date.now(),
  };
}

let probesOverride: ReadinessProbes | null = null;

/** Test hook: replace the host probes. Pass null to restore the real ones. */
export function setReadinessProbesForTest(probes: ReadinessProbes | null): void {
  probesOverride = probes;
}

/** The node id inside the hub-signed tunnel credential. Only the claim is read; the token never leaves this function. */
function enrolledNodeId(token: string | null): number | null {
  if (!token) return null;
  const decoded = jwt.decode(token);
  if (!decoded || typeof decoded !== 'object') return null;
  const nodeId = (decoded as { nodeId?: unknown }).nodeId;
  return typeof nodeId === 'number' && Number.isSafeInteger(nodeId) ? nodeId : null;
}

export async function buildReadinessReport(nonce: string, probes: ReadinessProbes): Promise<PilotReadinessReport> {
  const environment = probes.environment();
  const [report, version, containers] = await Promise.all([
    collectEnvironmentReport(environment),
    probes.dockerVersion().then((value) => value, (error: unknown) => {
      console.warn('[PilotReadiness] Docker version read failed:', sanitizeForLog(getErrorMessage(error, 'unknown')));
      return null;
    }),
    probes.listContainers().then((value) => value, (error: unknown) => {
      console.warn('[PilotReadiness] Container listing failed:', sanitizeForLog(getErrorMessage(error, 'unknown')));
      return null;
    }),
  ]);
  const checks: ReportedCheck[] = report.checks
    .filter((check): check is typeof check & { id: ReportedCheck['id'] } => (REPORTED_CHECK_IDS as readonly string[]).includes(check.id))
    .map((check) => ({
      id: check.id,
      status: check.status,
      detail: check.detail,
      remediation: check.status === 'pass' ? null : check.remediation,
    }));
  // A stopped leftover of the project does not count: the answering agent must be the running Pilot.
  const agent = containers?.find((container) => container.State === 'running'
    && container.Labels?.['com.docker.compose.project'] === PILOT_PROJECT_NAME) ?? null;
  const dataVolume = agent
    ? (agent.Mounts ?? []).some((mount) => mount.Type === 'volume'
      && mount.Destination === PILOT_DATA_MOUNT
      && typeof mount.Name === 'string'
      && (mount.Name === PILOT_DATA_VOLUME || mount.Name === `${PILOT_PROJECT_NAME}_${PILOT_DATA_VOLUME}`))
    : null;
  return {
    contract: READINESS_CONTRACT_VERSION,
    nonce,
    generatedAt: probes.now(),
    agent: {
      version: getSenchoVersion() || '0.0.0',
      enrolledNodeId: enrolledNodeId(probes.persistedToken()),
      primaryUrl: process.env.SENCHO_PRIMARY_URL ?? null,
      caBundle: Boolean(process.env.SENCHO_PILOT_CA_FILE),
    },
    docker: {
      serverVersion: typeof version?.Version === 'string' ? version.Version : null,
      apiVersion: typeof version?.ApiVersion === 'string' ? version.ApiVersion : null,
    },
    composeDir: environment.composeDir,
    checks,
    inventory: {
      listed: containers !== null,
      containers: containers?.length ?? null,
      agentContainer: containers === null ? null : agent !== null,
      agentDataVolume: dataVolume,
    },
  };
}

pilotReadinessRouter.get('/readiness', async (req: Request, res: Response): Promise<void> => {
  if (process.env.SENCHO_MODE !== 'pilot') {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (req.machineAuthScope !== 'pilot_tunnel' || req.headers[PROXY_ROLE_HEADER] !== undefined) {
    res.status(403).json({ error: 'Only the hub can read this agent\'s readiness.', code: 'READINESS_HUB_ONLY' });
    return;
  }
  const nonce = typeof req.query.nonce === 'string' ? req.query.nonce : '';
  if (!NONCE_PATTERN.test(nonce)) {
    res.status(400).json({ error: 'A readiness request needs a nonce.', code: 'READINESS_NONCE_INVALID' });
    return;
  }
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await buildReadinessReport(nonce, probesOverride ?? realProbes()));
  } catch (error: unknown) {
    console.error('[PilotReadiness] Report failed:', sanitizeForLog(getErrorMessage(error, 'unknown')));
    res.status(500).json({ error: 'The agent could not build its readiness report.' });
  }
});
