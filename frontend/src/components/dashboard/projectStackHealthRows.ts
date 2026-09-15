import type { Node } from '@/context/NodeContext';
import type { StackUpdateInfo } from '@/types/imageUpdates';
import { isConfirmedImageUpdate, isConfirmedServiceUpdate } from '@/types/imageUpdates';
import { aggregateCurrentUsage } from './aggregateCurrentUsage';
import { classifyRow } from './classifyRow';
import type { GitOpsSourceStateMap } from './useGitOpsSourceStates';
import type { MetricPoint, StackCpuSeries, StackStatusEntry } from './types';
import type { StackHealthFreshness, StackHealthRow } from './stackHealthTypes';

export function projectStackHealthRows(args: {
  node: Node;
  statuses: Record<string, StackStatusEntry>;
  metrics: MetricPoint[];
  series: Record<string, StackCpuSeries>;
  gitops: GitOpsSourceStateMap;
  stackUpdates?: Record<string, StackUpdateInfo>;
  freshness: StackHealthFreshness;
  includeUpdates: boolean;
}): StackHealthRow[] {
  const {
    node,
    statuses,
    metrics,
    series,
    gitops,
    stackUpdates = {},
    freshness,
    includeUpdates,
  } = args;
  const aggregates = aggregateCurrentUsage(metrics);
  return Object.entries(statuses).map(([file, entry]) => {
    const name = file.replace(/\.(yml|yaml)$/, '');
    const agg = aggregates[name];
    const cpuSeries = series[name];
    const peakCpu = cpuSeries?.peakValue ?? agg?.cpu ?? 0;
    const updateInfo = includeUpdates ? stackUpdates[file] : undefined;
    return {
      key: `${node.id}:${file}`,
      node,
      file,
      name,
      status: entry.status,
      networks: entry.networks,
      memory: agg?.mem ?? null,
      cpu: agg?.cpu ?? null,
      peakCpu,
      series: cpuSeries?.points ?? [],
      peakIndex: cpuSeries?.peakIndex ?? -1,
      state: classifyRow(entry.status, peakCpu),
      runningSince: entry.runningSince ?? null,
      source: entry.source ?? 'local',
      mainPort: entry.mainPort ?? null,
      hasUpdate: updateInfo != null && isConfirmedImageUpdate(updateInfo),
      outdatedServices: (updateInfo?.services ?? [])
        .filter((s) => isConfirmedServiceUpdate(s))
        .map((s) => s.service),
      gitopsSourceState: gitops[name],
      freshness,
    };
  });
}

const SPARK_WINDOW_MS = 10 * 60 * 1000;
const SPARK_BUCKETS = 20;

export function buildStackCpuSeries(metrics: MetricPoint[]): Record<string, StackCpuSeries> {
  if (metrics.length === 0) return {};
  const grouped = new Map<string, MetricPoint[]>();
  for (const point of metrics) {
    if (!point.stack_name) continue;
    const bucket = grouped.get(point.stack_name) ?? [];
    bucket.push(point);
    grouped.set(point.stack_name, bucket);
  }

  const out: Record<string, StackCpuSeries> = {};
  const now = Date.now();
  for (const [stackName, rows] of grouped) {
    const points = bucketCpu(rows, now, SPARK_WINDOW_MS, SPARK_BUCKETS);
    let peakValue = -Infinity;
    let peakIndex = 0;
    for (let i = 0; i < points.length; i += 1) {
      if (points[i] > peakValue) {
        peakValue = points[i];
        peakIndex = i;
      }
    }
    out[stackName] = {
      stackName,
      points,
      peakValue: Number.isFinite(peakValue) ? peakValue : 0,
      peakIndex,
      latestValue: points[points.length - 1] ?? 0,
    };
  }
  return out;
}

function bucketCpu(
  points: MetricPoint[],
  now: number,
  windowMs: number,
  buckets: number,
): number[] {
  if (points.length === 0) return Array(buckets).fill(0);
  const start = now - windowMs;
  const bucketMs = windowMs / buckets;
  const sums = Array<number>(buckets).fill(0);
  const counts = Array<number>(buckets).fill(0);
  for (const p of points) {
    if (p.timestamp < start) continue;
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor((p.timestamp - start) / bucketMs)));
    sums[idx] += p.cpu_percent;
    counts[idx] += 1;
  }
  const out = Array<number>(buckets).fill(0);
  let last = 0;
  for (let i = 0; i < buckets; i += 1) {
    if (counts[i] > 0) {
      last = sums[i] / counts[i];
    }
    out[i] = last;
  }
  return out;
}
