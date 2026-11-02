import { ComposeService } from './ComposeService';
import { NodeRegistry } from './NodeRegistry';
import { resolveSenchoLabels, type SenchoLabelResolution } from '../helpers/senchoLabels';
import {
  readRouteKeyCache,
  routeKeyCacheEpoch,
  writeRouteKeyCache,
  type ServiceRouteKeys,
} from './senchoRouteKeyCache';
import { getErrorMessage } from '../utils/errors';
import { sanitizeForLog } from '../utils/safeLog';

/**
 * The notification routing keys a stack's services declare through
 * `io.sencho.notify.route`.
 *
 * Twenty containers go unhealthy at once and every one of them dispatches an
 * alert. Rendering the Compose model once per alert would turn a bad minute into
 * twenty renders, so one render is cached per node and stack with a short TTL,
 * and concurrent callers share the in-flight render.
 *
 * A failed render keeps the last known keys for that stack (stale while error):
 * an invalid Compose file is exactly when a deploy-failure alert is raised, and
 * losing its routing then would send the alert to the wrong destination. With no
 * previous answer the alert carries no keys, which matches no key filter.
 */

/** How long a resolved key map is trusted. Writers invalidate through `invalidateNodeCaches`. */
const CACHE_TTL_MS = 30_000;

const inFlight = new Map<string, Promise<ServiceRouteKeys | null>>();

function perServiceKeys(resolution: Extract<SenchoLabelResolution, { renderable: true }>): ServiceRouteKeys {
  const out: ServiceRouteKeys = {};
  for (const [service, labels] of Object.entries(resolution.services)) {
    out[service] = labels.notifyRoute;
  }
  return out;
}

/** Render once and read every service's routing key. */
async function renderServiceKeys(nodeId: number, stackName: string): Promise<ServiceRouteKeys | null> {
  try {
    const rendered = await ComposeService.getInstance(nodeId).renderConfig(stackName);
    if (rendered.timedOut || rendered.code !== 0 || !rendered.rendered) return null;
    const resolution = resolveSenchoLabels(JSON.parse(rendered.rendered));
    return resolution.renderable ? perServiceKeys(resolution) : null;
  } catch (error) {
    console.warn(
      '[RouteKeys] Could not resolve routing keys for %s on node %s: %s',
      sanitizeForLog(stackName),
      sanitizeForLog(nodeId),
      sanitizeForLog(getErrorMessage(error, 'unknown')),
    );
    return null;
  }
}

/**
 * A remote node's stack is rendered on that node, so this process cannot read
 * its labels. Reporting none is honest: the alert matches no key filter rather
 * than matching a local stack that happens to share the name.
 */
function isLocalNode(nodeId: number): boolean {
  try {
    const node = NodeRegistry.getInstance().getNode(nodeId);
    return node === undefined || node.type === 'local';
  } catch {
    // Unknown is treated as local: the render fails closed on its own, and a
    // registry that cannot answer must not silently drop every key.
    return true;
  }
}

/** The last answer this process resolved for a stack, expired or not. */
export function peekRouteKeys(nodeId: number, stackName: string, serviceName?: string): string[] {
  const cached = readRouteKeyCache(nodeId, stackName);
  if (!cached) return [];
  if (serviceName === undefined) {
    const keys = new Set<string>();
    for (const key of Object.values(cached.services)) {
      if (key) keys.add(key);
    }
    return [...keys].sort();
  }
  const own = Object.prototype.hasOwnProperty.call(cached.services, serviceName)
    ? cached.services[serviceName]
    : null;
  return own ? [own] : [];
}

async function currentServiceKeys(nodeId: number, stackName: string): Promise<ServiceRouteKeys | null> {
  if (!isLocalNode(nodeId)) return null;

  const cached = readRouteKeyCache(nodeId, stackName);
  if (cached && cached.expiresAt > Date.now()) return cached.services;

  const pendingKey = `${nodeId}\u0000${stackName}`;
  const pending = inFlight.get(pendingKey);
  if (pending) return pending;

  const epochAtStart = routeKeyCacheEpoch(nodeId);
  const work = (async (): Promise<ServiceRouteKeys | null> => {
    const rendered = await renderServiceKeys(nodeId, stackName);
    if (rendered && routeKeyCacheEpoch(nodeId) === epochAtStart) {
      // Only a successful render is cached. Extending the TTL from a failed
      // render would keep pre-break keys alive for as long as Compose stays
      // broken, which is exactly when a deploy-failure alert is raised.
      writeRouteKeyCache(nodeId, stackName, { expiresAt: Date.now() + CACHE_TTL_MS, services: rendered });
      return rendered;
    }
    // Stale while error, without refreshing the entry it falls back to.
    return rendered ?? cached?.services ?? null;
  })();

  inFlight.set(pendingKey, work);
  try {
    return await work;
  } finally {
    inFlight.delete(pendingKey);
  }
}

/**
 * The keys a stack-level alert carries: the sorted, deduplicated union of every
 * service's key. Every routing rule whose keys intersect fires, so a stack with a
 * `production` service and a `database` service reaches both rules.
 */
export async function stackRouteKeys(nodeId: number, stackName: string): Promise<string[]> {
  const services = await currentServiceKeys(nodeId, stackName);
  if (!services) return [];
  const keys = new Set<string>();
  for (const key of Object.values(services)) {
    if (key) keys.add(key);
  }
  return [...keys].sort();
}

/**
 * The key one service's alert carries. A service the model does not know (an
 * orphan, or a one-off container) carries none, so its alert does not fan out
 * to every route a key filter would reach.
 */
export async function serviceRouteKeys(
  nodeId: number,
  stackName: string,
  serviceName: string,
): Promise<string[]> {
  const services = await currentServiceKeys(nodeId, stackName);
  if (!services) return [];
  const own = Object.prototype.hasOwnProperty.call(services, serviceName) ? services[serviceName] : null;
  return own ? [own] : [];
}
