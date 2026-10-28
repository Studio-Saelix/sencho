/**
 * The block dialog's settings link across a dirty-editor node switch.
 *
 * Opening the Policies tab on the blocked node is a node switch followed by a
 * view. When the editor holds unsaved edits the switch waits on a discard
 * confirmation, and the destination has to survive that wait: confirming lands
 * on the blocked node's Policies tab, cancelling leaves nothing behind that
 * could fire on a later visit. The tests drive the same sequence the shell's
 * node-switch effect runs (queue, park on the dirty guard, confirm or cancel,
 * settle) with the real queue, the real settle resolver and the real link function.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { SENCHO_NAVIGATE_EVENT, type SenchoNavigateDetail } from '@/lib/events';
import type { Node } from '@/context/NodeContext';
import { useNodeViewQueue } from '../useNodeViewQueue';
import { openPolicySettings } from '../../openPolicySettings';
import { resolveNodeSettleAction } from '../../resolveNodeSettleAction';

const node = (id: number): Node => ({ id, name: `node-${id}`, type: id === 1 ? 'local' : 'remote' }) as Node;
const NODES = [node(1), node(2), node(3)];

const navigations: SenchoNavigateDetail[] = [];
const onNavigate = (e: Event) => navigations.push((e as CustomEvent<SenchoNavigateDetail>).detail);
window.addEventListener(SENCHO_NAVIGATE_EVENT, onNavigate);

afterEach(() => {
  navigations.length = 0;
});

/** The operator is on node 2 with unsaved edits; the block was recorded on node 1. */
function setup() {
  const setActiveNode = vi.fn();
  const hook = renderHook(() => useNodeViewQueue({ nodes: NODES, activeNode: node(2), setActiveNode }));
  const clickSettingsLink = () => openPolicySettings({
    nodeId: 1,
    nodes: NODES,
    openViewOnNode: hook.result.current.openViewOnNode,
    onNodeMissing: vi.fn(),
  });
  /** What the node-settled effect does for a landed switch to `settledNodeId`. */
  const settle = (settledNodeId: number) => {
    const queued = hook.result.current.takeQueuedView();
    const action = resolveNodeSettleAction({
      settledNodeId,
      isRealSwitch: true,
      pendingStack: null,
      pendingNodeIntent: null,
      pendingNodeView: queued,
    });
    if (action.kind === 'open-node-view') action.open();
    return action.kind;
  };
  return { hook, setActiveNode, clickSettingsLink, settle };
}

describe('the settings link across a dirty-editor node switch', () => {
  it('reaches the blocked node\'s Policies tab once the discard is confirmed', () => {
    const { hook, setActiveNode, clickSettingsLink, settle } = setup();

    clickSettingsLink();
    expect(setActiveNode).toHaveBeenLastCalledWith(NODES[0]);

    // The dirty guard reverts the switch and holds it for the dialog.
    let confirm: (() => void) | null = null;
    act(() => { confirm = hook.result.current.parkForConfirmation(NODES[0]); });
    expect(confirm).toBeTypeOf('function');
    expect(navigations).toEqual([]);

    // Confirming discards the edits and finishes the switch...
    act(() => confirm!());
    expect(setActiveNode).toHaveBeenLastCalledWith(NODES[0]);
    // ...and the settle that follows opens the destination, not the dashboard.
    expect(settle(1)).toBe('open-node-view');
    expect(navigations).toEqual([{ view: 'security', tab: 'policies' }]);
  });

  it('leaves no destination behind when the operator cancels', () => {
    const { hook, clickSettingsLink, settle } = setup();

    clickSettingsLink();
    act(() => { hook.result.current.parkForConfirmation(NODES[0]); });
    // Cancel: the held step is never run. Later, the operator reaches node 1 by hand.
    expect(settle(1)).toBe('go-home');
    expect(navigations).toEqual([]);
  });

  it('does not let a request for another node ride along on this switch', () => {
    const { hook, clickSettingsLink } = setup();

    clickSettingsLink();
    // The dirty guard is holding a switch to node 3, not the node the view was queued for.
    let confirm: (() => void) | null = null;
    act(() => { confirm = hook.result.current.parkForConfirmation(NODES[2]); });
    expect(confirm).toBeNull();
    expect(hook.result.current.takeQueuedView()).toBeNull();
  });

  it('keeps the first request when a second link is clicked while the dialog is open', () => {
    const { hook, setActiveNode, clickSettingsLink, settle } = setup();

    clickSettingsLink();
    let confirm: (() => void) | null = null;
    act(() => { confirm = hook.result.current.parkForConfirmation(NODES[0]); });

    // A second request while the dialog is up: the shell reverts that switch and drops its view.
    act(() => hook.result.current.openViewOnNode(3, () => navigations.push({ view: 'networking' } as SenchoNavigateDetail)));
    let dropped = false;
    act(() => { dropped = hook.result.current.dropQueuedView(); });
    // The shell tells the operator about a dropped link only when there was one to drop.
    expect(dropped).toBe(true);
    act(() => { dropped = hook.result.current.dropQueuedView(); });
    expect(dropped).toBe(false);
    expect(setActiveNode).toHaveBeenLastCalledWith(NODES[2]);

    act(() => confirm!());
    expect(settle(1)).toBe('open-node-view');
    expect(navigations).toEqual([{ view: 'security', tab: 'policies' }]);
  });

  it('parks nothing for a plain switch with no queued view', () => {
    const { hook } = setup();
    let confirm: (() => void) | null = () => {};
    act(() => { confirm = hook.result.current.parkForConfirmation(NODES[0]); });
    expect(confirm).toBeNull();
  });

  it('opens at once on the active node and for a clean editor takes the ordinary path', () => {
    const { hook, setActiveNode, settle } = setup();

    // Active node: no switch, no queue.
    act(() => hook.result.current.openViewOnNode(2, () => navigations.push({ view: 'networking' } as SenchoNavigateDetail)));
    expect(setActiveNode).not.toHaveBeenCalled();
    expect(navigations).toHaveLength(1);

    // Other node, nothing parked: the settle opens the queued view.
    navigations.length = 0;
    act(() => hook.result.current.openViewOnNode(1, () => navigations.push({ view: 'security', tab: 'policies' })));
    expect(settle(1)).toBe('open-node-view');
    expect(navigations).toEqual([{ view: 'security', tab: 'policies' }]);
  });
});
