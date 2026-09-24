/**
 * What the shell does once an active-node switch lands. Several surfaces queue
 * work behind a switch (a stack to open, a Home destination, a node-scoped
 * view such as Networking or Security); at most one runs, in this priority order, and a real switch
 * with nothing queued returns to Home. Every queue is drained before this is
 * called, so a loser never survives to fire on a later switch.
 */
export type NodeSettleAction =
  | { kind: 'load-stack'; stackName: string }
  | { kind: 'run-intent'; run: () => void }
  | { kind: 'open-node-view'; open: () => void }
  | { kind: 'go-home' }
  | { kind: 'none' };

export function resolveNodeSettleAction(input: {
  settledNodeId: number;
  isRealSwitch: boolean;
  pendingStack: string | null;
  pendingNodeIntent: (() => void) | null;
  pendingNodeView: { nodeId: number; open: () => void } | null;
}): NodeSettleAction {
  if (input.pendingStack) return { kind: 'load-stack', stackName: input.pendingStack };
  if (input.pendingNodeIntent) return { kind: 'run-intent', run: input.pendingNodeIntent };
  if (input.pendingNodeView?.nodeId === input.settledNodeId) return { kind: 'open-node-view', open: input.pendingNodeView.open };
  if (input.isRealSwitch) return { kind: 'go-home' };
  return { kind: 'none' };
}
