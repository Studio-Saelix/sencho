import type { MetricPoint } from './types';

/**
 * How far behind the freshest sample a container's latest point may be and
 * still count toward current usage. Metrics are collected on a ~30s cadence,
 * so 90s comfortably includes live containers while dropping the lingering
 * final reading of one that stopped a couple of cycles ago.
 */
export const CURRENT_USAGE_STALE_WINDOW_MS = 90_000;

export interface StackUsage {
  mem: number;
  cpu: number;
}

/**
 * Sum the latest CPU/memory sample per container into a per-stack total,
 * ignoring containers whose most recent sample is stale. A stopped container
 * stops producing samples, so its last reading would otherwise persist in the
 * total until it aged out of the metrics window; gating on recency relative to
 * the freshest sample (not wall-clock, so overall fetch lag does not matter)
 * drops it once live containers report newer points.
 */
export function aggregateCurrentUsage(
  metrics: MetricPoint[],
  staleWindowMs: number = CURRENT_USAGE_STALE_WINDOW_MS,
): Record<string, StackUsage> {
  if (metrics.length === 0) return {};

  let freshest = -Infinity;
  const latestPerContainer: Record<string, Record<string, MetricPoint>> = {};
  for (const m of metrics) {
    if (m.timestamp > freshest) freshest = m.timestamp;
    if (!m.stack_name) continue;
    if (!latestPerContainer[m.stack_name]) latestPerContainer[m.stack_name] = {};
    const existing = latestPerContainer[m.stack_name][m.container_id];
    if (!existing || m.timestamp > existing.timestamp) {
      latestPerContainer[m.stack_name][m.container_id] = m;
    }
  }

  const cutoff = freshest - staleWindowMs;
  const result: Record<string, StackUsage> = {};
  for (const [stack, containers] of Object.entries(latestPerContainer)) {
    let mem = 0;
    let cpu = 0;
    let fresh = false;
    for (const m of Object.values(containers)) {
      if (m.timestamp < cutoff) continue;
      mem += m.memory_mb;
      cpu += m.cpu_percent;
      fresh = true;
    }
    if (fresh) result[stack] = { mem, cpu };
  }
  return result;
}
