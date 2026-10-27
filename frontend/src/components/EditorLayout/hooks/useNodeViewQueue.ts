import { useRef } from 'react';
import type { Node } from '@/context/NodeContext';

/** A view to open on a node once the switch to that node has landed. */
export interface QueuedNodeView {
  nodeId: number;
  open: () => void;
}

interface UseNodeViewQueueArgs {
  nodes: ReadonlyArray<Node>;
  activeNode: Node | null;
  setActiveNode: (node: Node) => void;
}

/**
 * The hand-off for "open this node's <view>" requests (a Fleet networking
 * signal, a Readiness security finding, the block dialog's settings link).
 *
 * The node is switched first and the view opens once the node-settled effect
 * sees the switch land, so the view never mounts and fetches against the
 * previous node. A switch away from a dirty editor does not land until the
 * operator confirms discarding the edits, so the queued view has to survive
 * that wait: `parkForConfirmation` takes it out of the queue and hands back the
 * step that puts it back and finishes the switch. Cancelling the dialog never
 * runs that step, so a cancelled request leaves nothing behind to fire on some
 * later arrival at the node.
 */
export function useNodeViewQueue({ nodes, activeNode, setActiveNode }: UseNodeViewQueueArgs) {
  const queuedRef = useRef<QueuedNodeView | null>(null);

  /** Open the view now when the node is already active, otherwise switch and queue it. */
  const openViewOnNode = (nodeId: number, open: () => void) => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    if (activeNode?.id === nodeId) {
      open();
      return;
    }
    queuedRef.current = { nodeId, open };
    setActiveNode(node);
  };

  /** The queued view, removed from the queue; the node-settled effect calls this once per switch. */
  const takeQueuedView = (): QueuedNodeView | null => {
    const queued = queuedRef.current;
    queuedRef.current = null;
    return queued;
  };

  /** Forget the queued view: its switch was reverted and will not land. Returns whether there was one. */
  const dropQueuedView = (): boolean => takeQueuedView() !== null;

  /**
   * The switch to `target` is waiting on a confirmation. Returns the step to run
   * on confirmation (re-queue the view, then switch), or null when nothing is
   * queued (a plain switch) or the queued view is not for `target`; that view is
   * dropped, since its switch is not the one being confirmed.
   */
  const parkForConfirmation = (target: Node): (() => void) | null => {
    const queued = takeQueuedView();
    if (!queued || queued.nodeId !== target.id) return null;
    return () => {
      queuedRef.current = queued;
      setActiveNode(target);
    };
  };

  return { openViewOnNode, takeQueuedView, dropQueuedView, parkForConfirmation };
}
