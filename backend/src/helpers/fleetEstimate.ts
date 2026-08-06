/**
 * Live fleet prune-estimate folding: accumulate per-target byte results into
 * one per-node estimate without discarding successes when a later target fails.
 */

export type FleetEstimateTargetResult = {
  bytes: number;
  error?: string;
};

export type FleetNodeEstimate = {
  nodeId: number;
  nodeName: string;
  reclaimableBytes: number;
  reachable: boolean;
  error?: string;
  partial?: true;
};

export function foldNodeEstimate(
  node: { nodeId: number; nodeName: string },
  perTarget: ReadonlyArray<FleetEstimateTargetResult>,
): FleetNodeEstimate {
  let reclaimableBytes = 0;
  let successCount = 0;
  let firstError: string | undefined;
  for (const entry of perTarget) {
    if (entry.error) {
      if (firstError === undefined) firstError = entry.error;
      continue;
    }
    reclaimableBytes += entry.bytes;
    successCount += 1;
  }
  const failCount = perTarget.length - successCount;
  if (successCount === 0) {
    return {
      nodeId: node.nodeId,
      nodeName: node.nodeName,
      reclaimableBytes: 0,
      reachable: false,
      error: firstError,
    };
  }
  if (failCount > 0) {
    return {
      nodeId: node.nodeId,
      nodeName: node.nodeName,
      reclaimableBytes,
      reachable: true,
      partial: true,
      error: firstError,
    };
  }
  return {
    nodeId: node.nodeId,
    nodeName: node.nodeName,
    reclaimableBytes,
    reachable: true,
  };
}
