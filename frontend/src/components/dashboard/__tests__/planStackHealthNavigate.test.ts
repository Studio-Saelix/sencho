import { describe, expect, it, vi } from 'vitest';
import { applyStackHealthNavigate } from '../planStackHealthNavigate';
import { LOCAL_NODE } from './stackHealthTableTestUtils';
import type { Node } from '@/context/NodeContext';

const REMOTE_NODE: Node = {
  ...LOCAL_NODE,
  id: 2,
  name: 'edge-1',
  type: 'remote',
};

describe('applyStackHealthNavigate', () => {
  it('loads on the active node without switching', () => {
    const loadFileOnNode = vi.fn();
    const pendingStackLoadRef = { current: null as string | null };
    const setActiveNode = vi.fn();
    applyStackHealthNavigate(
      { node: LOCAL_NODE, file: 'web.yml' },
      LOCAL_NODE.id,
      { loadFileOnNode, pendingStackLoadRef, setActiveNode },
    );
    expect(loadFileOnNode).toHaveBeenCalledOnce();
    expect(loadFileOnNode).toHaveBeenCalledWith(LOCAL_NODE, 'web.yml');
    expect(pendingStackLoadRef.current).toBeNull();
    expect(setActiveNode).not.toHaveBeenCalled();
  });

  it('stashes the file before switching to a remote node', () => {
    const loadFileOnNode = vi.fn();
    const pendingStackLoadRef = { current: null as string | null };
    const setActiveNode = vi.fn(() => {
      expect(pendingStackLoadRef.current).toBe('api.yml');
    });
    applyStackHealthNavigate(
      { node: REMOTE_NODE, file: 'api.yml' },
      LOCAL_NODE.id,
      { loadFileOnNode, pendingStackLoadRef, setActiveNode },
    );
    expect(loadFileOnNode).not.toHaveBeenCalled();
    expect(pendingStackLoadRef.current).toBe('api.yml');
    expect(setActiveNode).toHaveBeenCalledOnce();
    expect(setActiveNode).toHaveBeenCalledWith(REMOTE_NODE);
  });

  it('stashes and switches when there is no active node', () => {
    const loadFileOnNode = vi.fn();
    const pendingStackLoadRef = { current: null as string | null };
    const setActiveNode = vi.fn();
    applyStackHealthNavigate(
      { node: REMOTE_NODE, file: 'api.yml' },
      null,
      { loadFileOnNode, pendingStackLoadRef, setActiveNode },
    );
    expect(loadFileOnNode).not.toHaveBeenCalled();
    expect(pendingStackLoadRef.current).toBe('api.yml');
    expect(setActiveNode).toHaveBeenCalledWith(REMOTE_NODE);
  });
});
