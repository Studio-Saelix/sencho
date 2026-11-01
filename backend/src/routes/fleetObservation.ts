import { Router, type Request, type Response } from 'express';
import { CacheService } from '../services/CacheService';
import { DatabaseService } from '../services/DatabaseService';
import { requirePermission } from '../middleware/permissions';
import { errorMessageForLog } from '../utils/safeLog';
import { buildFleetReadiness } from '../services/readiness/readinessAggregator';
import { READINESS_DOMAINS, type FleetReadinessResponse } from '../services/readiness/types';
import {
  observationEnvelope,
  projectFleetHealth,
  projectNode,
  type ObservationEnvelope,
  type ObservedFleetHealthData,
} from '../services/observation/projections';

/**
 * Hub-served projections for an AI observer: the node registry and the fleet
 * health aggregate.
 *
 * Mounted under `/api/fleet/`, which `helpers/proxyExemptPaths.ts` already
 * exempts from the remote proxy, so these two are always answered by the hub
 * the caller is signed into. That prefix could not carry the per-node
 * observation routes: a request naming a remote node would be answered by this
 * instance's own copy.
 *
 * `node:read` is a global permission, so both routes answer the same payload
 * for every caller that may read them.
 */
export const fleetObservationRouter = Router();

/**
 * One shared cache entry for the whole fleet, not one per caller.
 *
 * Fleet health is the most expensive read in this surface (a live probe of
 * every node), and an agent polls it on a timer. Fifteen seconds keeps the
 * aggregate fresh enough to explain an incident while collapsing a burst of
 * clients onto one fan-out.
 */
export const OBSERVATION_FLEET_HEALTH_CACHE_KEY = 'observation:fleet-health';
export const OBSERVATION_FLEET_HEALTH_TTL_MS = 15_000;
/**
 * Ceiling on one shared computation.
 *
 * Deliberately NOT wired to any caller's `res.close`: with an in-flight join, a
 * single client that disconnects would abort the shared read and cache an
 * all-unreachable fleet for every waiter, which is the worst possible answer
 * for a surface whose job is to say what is wrong. A caller that goes away
 * stops waiting; the computation finishes and is cached on its own budget.
 */
export const OBSERVATION_FLEET_HEALTH_BUDGET_MS = 20_000;

async function computeFleetHealth(): Promise<FleetReadinessResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OBSERVATION_FLEET_HEALTH_BUDGET_MS);
  try {
    return await buildFleetReadiness({
      domains: READINESS_DOMAINS,
      nodeIds: null,
      // Control is derived from the admin-only sync rows; withholding it by
      // absence keeps the observer credential out of that boundary entirely.
      includeControl: false,
      signal: controller.signal,
      // Attaching dismissals reads AND retires stored rows. A read must not
      // mutate, so an observation never carries them; the consequence (a
      // dismissed finding still appears here) is documented on the page.
      withDismissals: false,
    });
  } finally {
    clearTimeout(timer);
  }
}

fleetObservationRouter.get('/nodes', (req: Request, res: Response): void => {
  if (!requirePermission(req, res, 'node:read')) return;
  try {
    const nodes = DatabaseService.getInstance().getNodes();
    res.json(observationEnvelope(Date.now(), nodes.map(projectNode)));
  } catch (error) {
    console.error('[FleetObservation] Failed to read nodes:', errorMessageForLog(error));
    res.status(500).json({ error: 'Failed to read nodes' });
  }
});

fleetObservationRouter.get('/health', async (req: Request, res: Response): Promise<void> => {
  if (!requirePermission(req, res, 'node:read')) return;
  try {
    const { value, outcome } = await CacheService.getInstance().getOrFetchWithMeta(
      OBSERVATION_FLEET_HEALTH_CACHE_KEY,
      OBSERVATION_FLEET_HEALTH_TTL_MS,
      computeFleetHealth,
    );
    // Stale means the evidence behind the answer is older than this cache's
    // window. `outcome === 'stale'` names that for the caller that ran the
    // failed refresh, but a caller that joined that refresh is told `inflight`
    // on the same expired bytes, so the age has to be part of the test too.
    // `generatedAt` is stamped when the evidence was produced, which is the
    // same clock the cache's TTL runs on.
    const stale = outcome === 'stale'
      || Date.now() - value.generatedAt >= OBSERVATION_FLEET_HEALTH_TTL_MS;
    const payload: ObservationEnvelope<ObservedFleetHealthData> = observationEnvelope(
      value.generatedAt,
      projectFleetHealth(value, stale),
    );
    res.json(payload);
  } catch (error) {
    console.error('[FleetObservation] Failed to read fleet health:', errorMessageForLog(error));
    res.status(500).json({ error: 'Failed to read fleet health' });
  }
});
