import type { Node } from '@/context/NodeContext';
import type { StackHealthNavTarget } from './stackHealthTypes';

export function applyStackHealthNavigate(
  target: StackHealthNavTarget,
  activeNodeId: number | null | undefined,
  deps: {
    loadFileOnNode: (node: Node, file: string) => void;
    pendingStackLoadRef: { current: string | null };
    setActiveNode: (node: Node) => void;
  },
): void {
  if (target.node.id === activeNodeId) {
    deps.loadFileOnNode(target.node, target.file);
    return;
  }
  // Stash first: setActiveNode can flush the node-switch effect in this tick,
  // and that effect only loads a stack when pendingStackLoadRef is already set.
  deps.pendingStackLoadRef.current = target.file;
  deps.setActiveNode(target.node);
}
