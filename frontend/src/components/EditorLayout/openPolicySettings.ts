import { SENCHO_NAVIGATE_EVENT, type SenchoNavigateDetail } from '@/lib/events';

interface OpenPolicySettingsArgs {
  /** The node the blocked operation was sent to; null when the block recorded none. */
  nodeId: number | null;
  nodes: ReadonlyArray<{ id: number }>;
  /** Switches to the node if needed and runs the callback once the switch lands. */
  openViewOnNode: (nodeId: number, open: () => void) => void;
  onNodeMissing: () => void;
}

/**
 * The block dialog's link to the Evidence availability settings.
 *
 * The setting belongs to the node the operation was sent to, which is not always
 * the active node: the operator can switch while a deploy runs. The Policies tab
 * therefore opens on that node. The destination goes through the shared navigate
 * event so a phone reaches its content surface the same way every other link does.
 *
 * Returns whether the navigation was started. It is false only when the node was
 * removed after the block, so the caller can keep the block explanation on screen.
 */
export function openPolicySettings({ nodeId, nodes, openViewOnNode, onNodeMissing }: OpenPolicySettingsArgs): boolean {
  const open = () => window.dispatchEvent(new CustomEvent<SenchoNavigateDetail>(SENCHO_NAVIGATE_EVENT, {
    detail: { view: 'security', tab: 'policies' },
  }));
  if (nodeId === null) {
    open();
    return true;
  }
  if (!nodes.some((n) => n.id === nodeId)) {
    onNodeMissing();
    return false;
  }
  openViewOnNode(nodeId, open);
  return true;
}
