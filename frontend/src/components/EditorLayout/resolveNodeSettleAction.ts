/**
 * What the shell does once an active-node switch lands. Several surfaces queue
 * work behind a switch (a stack to open, a Home destination, a node's
 * Networking page); at most one runs, in this priority order, and a real switch
 * with nothing queued returns to Home. Every queue is drained before this is
 * called, so a loser never survives to fire on a later switch.
 */
export type NodeSettleAction =
  | { kind: 'load-stack'; stackName: string }
  | { kind: 'run-intent'; run: () => void }
  | { kind: 'open-networking' }
  | { kind: 'go-home' }
  | { kind: 'none' };

export function resolveNodeSettleAction(input: {
  settledNodeId: number;
  isRealSwitch: boolean;
  pendingStack: string | null;
  pendingNodeIntent: (() => void) | null;
  pendingNetworkingNodeId: number | null;
}): NodeSettleAction {
  if (input.pendingStack) return { kind: 'load-stack', stackName: input.pendingStack };
  if (input.pendingNodeIntent) return { kind: 'run-intent', run: input.pendingNodeIntent };
  if (input.pendingNetworkingNodeId === input.settledNodeId) return { kind: 'open-networking' };
  if (input.isRealSwitch) return { kind: 'go-home' };
  return { kind: 'none' };
}
