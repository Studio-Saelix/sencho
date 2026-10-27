import { describe, it, expect, vi } from 'vitest';
import { SENCHO_NAVIGATE_EVENT } from '@/lib/events';
import { openPolicySettings } from '../openPolicySettings';

function listen() {
  const seen = vi.fn();
  window.addEventListener(SENCHO_NAVIGATE_EVENT, seen);
  return { seen, stop: () => window.removeEventListener(SENCHO_NAVIGATE_EVENT, seen) };
}

const nodes = [{ id: 1 }, { id: 2 }];

describe('openPolicySettings', () => {
  it('switches to the node the block came from before it opens the Policies tab', () => {
    const { seen, stop } = listen();
    // Stands in for the shell: a switch lands first, then the queued view opens.
    let queued: (() => void) | null = null;
    const openViewOnNode = vi.fn((_id: number, open: () => void) => { queued = open; });
    try {
      openPolicySettings({ nodeId: 1, nodes, openViewOnNode, onNodeMissing: vi.fn() });
      expect(openViewOnNode).toHaveBeenCalledWith(1, expect.any(Function));
      // Nothing opened yet: on the node that is active now, the tab would edit the wrong gate.
      expect(seen).not.toHaveBeenCalled();
      queued!();
      expect(seen).toHaveBeenCalledTimes(1);
      expect((seen.mock.calls[0][0] as CustomEvent).detail).toEqual({ view: 'security', tab: 'policies' });
    } finally {
      stop();
    }
  });

  it('opens on the active node when the block recorded none', () => {
    const { seen, stop } = listen();
    const openViewOnNode = vi.fn();
    try {
      openPolicySettings({ nodeId: null, nodes, openViewOnNode, onNodeMissing: vi.fn() });
      expect(openViewOnNode).not.toHaveBeenCalled();
      expect(seen).toHaveBeenCalledTimes(1);
    } finally {
      stop();
    }
  });

  it('says so and opens nothing when the node was removed after the block', () => {
    const { seen, stop } = listen();
    const openViewOnNode = vi.fn();
    const onNodeMissing = vi.fn();
    try {
      openPolicySettings({ nodeId: 99, nodes, openViewOnNode, onNodeMissing });
      expect(onNodeMissing).toHaveBeenCalledTimes(1);
      expect(openViewOnNode).not.toHaveBeenCalled();
      expect(seen).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
