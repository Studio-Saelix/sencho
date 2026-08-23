/**
 * Short-TTL memo for the per-node networking aggregate. Read endpoints share one
 * computation per window instead of re-rendering every stack per request;
 * mutations invalidate eagerly so deletes and creates never serve a stale view
 * beyond the request that performed them. Kept as a leaf module so mutation
 * helpers and services can invalidate without importing the aggregate pipeline
 * back into themselves.
 *
 * The cache key encodes the requested variant (topology / includeSystem) as
 * well as the node: a plain overview read must never satisfy a topology
 * request, whose aggregate additionally carries the topology graph.
 */
import { CacheService, type CacheFetchOutcome } from '../CacheService';
import type { NodeNetworkingAggregate } from './networkingTypes';

const NAMESPACE = 'networking-aggregate';

export const NETWORKING_AGGREGATE_TTL_MS = 8_000;

export type NetworkingAggregateOptions = { includeTopology?: boolean; includeSystem?: boolean };

export function networkingAggregateCacheKey(nodeId: number, options: NetworkingAggregateOptions): string {
  if (options.includeTopology === true) {
    return `${NAMESPACE}:${nodeId}:topology:${options.includeSystem === true}`;
  }
  return `${NAMESPACE}:${nodeId}:base`;
}

export async function fetchNodeNetworkingAggregateWithMeta(
  nodeId: number,
  options: NetworkingAggregateOptions,
  compute: () => Promise<NodeNetworkingAggregate>,
): Promise<{ value: NodeNetworkingAggregate; outcome: CacheFetchOutcome }> {
  return CacheService.getInstance().getOrFetchWithMeta(networkingAggregateCacheKey(nodeId, options), NETWORKING_AGGREGATE_TTL_MS, compute);
}

export function invalidateNodeNetworkingAggregate(nodeId: number): void {
  CacheService.getInstance().invalidateNamespace(`${NAMESPACE}:${nodeId}`);
}