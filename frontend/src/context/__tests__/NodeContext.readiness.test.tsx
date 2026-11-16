import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor, act } from '@testing-library/react';
import { announceNotificationsConnection } from '@/lib/notificationsConnection';
import { NodeProvider, useNodes } from '../NodeContext';

const apiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (path: string, opts?: unknown) => apiFetch(path, opts),
}));

const LOCAL_NODE = { id: 1, name: 'local', type: 'local' as const, compose_dir: '/compose', is_default: true, status: 'online' as const, created_at: 0, readiness: null };

function bootstrapped(state: 'provisional' | 'ready') {
  return { id: 2, name: 'media', type: 'remote' as const, compose_dir: '/opt/docker/sencho', is_default: false, status: 'online' as const, created_at: 0,
    readiness: { state, checkedAt: null, operationId: 'op-1', operationState: 'enrolled' as const } };
}

function wrapper({ children }: { children: ReactNode }) {
  return <NodeProvider>{children}</NodeProvider>;
}

describe('NodeContext readiness refresh', () => {
  beforeEach(() => {
    // The socket's last announced state outlives a test; start each one with it up.
    announceNotificationsConnection(true);
    localStorage.clear();
    apiFetch.mockReset();
  });

  it('refetches the node list when the hub announces a changed readiness verdict, and only then', async () => {
    let state: 'provisional' | 'ready' = 'provisional';
    apiFetch.mockImplementation((path: string) => {
      if (path === '/nodes') return Promise.resolve({ ok: true, json: async () => [{ ...LOCAL_NODE }, bootstrapped(state)] });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    const { result } = renderHook(() => useNodes(), { wrapper });
    await waitFor(() => expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('provisional'));
    const listCalls = () => apiFetch.mock.calls.filter(([path]) => path === '/nodes').length;
    const before = listCalls();

    act(() => { window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'gitops' } })); });
    expect(listCalls()).toBe(before);

    const activeBefore = result.current.activeNode;
    state = 'ready';
    // Two announcements inside one window: one refetch.
    act(() => {
      window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'node-readiness', nodeId: 2 } }));
      window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'node-readiness', nodeId: 2 } }));
    });
    await waitFor(() => expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('ready'), { timeout: 3000 });
    expect(listCalls()).toBe(before + 1);
    // Another node's readiness changed; the active local node is the same object, so its effects do not rerun.
    expect(result.current.activeNode).toBe(activeBefore);

    // A later announcement, after the window closed, refetches again.
    state = 'provisional';
    act(() => { window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'node-readiness', nodeId: 2 } })); });
    await waitFor(() => expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('provisional'), { timeout: 3000 });
    expect(listCalls()).toBe(before + 2);
  });

  it('ignores a node list that arrives after a newer one, so a replaced verdict does not come back', async () => {
    const pending: Array<(state: 'provisional' | 'ready') => void> = [];
    let first = true;
    apiFetch.mockImplementation((path: string) => {
      if (path !== '/nodes') return Promise.resolve({ ok: true, json: async () => ({}) });
      if (first) {
        first = false;
        return Promise.resolve({ ok: true, json: async () => [{ ...LOCAL_NODE }, bootstrapped('provisional')] });
      }
      return new Promise((resolve) => {
        pending.push((state) => resolve({ ok: true, json: async () => [{ ...LOCAL_NODE }, bootstrapped(state)] }));
      });
    });
    const { result } = renderHook(() => useNodes(), { wrapper });
    await waitFor(() => expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('provisional'));

    // Two refetches start; the older one answers last with a verdict the newer one already replaced.
    act(() => { window.dispatchEvent(new Event('node-not-found')); });
    act(() => { window.dispatchEvent(new Event('node-not-found')); });
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => { pending[1]('provisional'); });
    await act(async () => { pending[0]('ready'); });
    expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('provisional');
  });
  it('still applies an older node list when the newer request fails', async () => {
    const pending: Array<{ resolve: (state: 'provisional' | 'ready') => void; reject: () => void }> = [];
    let first = true;
    apiFetch.mockImplementation((path: string) => {
      if (path !== '/nodes') return Promise.resolve({ ok: true, json: async () => ({}) });
      if (first) {
        first = false;
        return Promise.resolve({ ok: true, json: async () => [{ ...LOCAL_NODE }, bootstrapped('provisional')] });
      }
      return new Promise((resolve, reject) => {
        pending.push({
          resolve: (state) => resolve({ ok: true, json: async () => [{ ...LOCAL_NODE }, bootstrapped(state)] }),
          reject: () => reject(new Error('network down')),
        });
      });
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { result } = renderHook(() => useNodes(), { wrapper });
      await waitFor(() => expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('provisional'));

      act(() => { window.dispatchEvent(new Event('node-not-found')); });
      act(() => { window.dispatchEvent(new Event('node-not-found')); });
      await waitFor(() => expect(pending).toHaveLength(2));
      await act(async () => { pending[1].reject(); });
      await act(async () => { pending[0].resolve('ready'); });
      expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('ready');
    } finally {
      error.mockRestore();
    }
  });

  describe('a catch-up read that does not apply', () => {
    type Failure = 'rejected fetch' | 'non-OK HTTP' | 'undecodable JSON';
    const FAILURES: Failure[] = ['rejected fetch', 'non-OK HTTP', 'undecodable JSON'];
    const TRIGGERS = [
      { name: 'a readiness announcement', fire: () => window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'node-readiness', nodeId: 2 } })) },
      { name: 'the notification socket returning', fire: () => { announceNotificationsConnection(false); announceNotificationsConnection(true); } },
    ];
    const lists = () => apiFetch.mock.calls.filter(([path]) => path === '/nodes').length;
    const advance = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
    const failing = (failure: Failure) => {
      if (failure === 'rejected fetch') return Promise.reject(new Error('network down'));
      if (failure === 'non-OK HTTP') return Promise.resolve({ ok: false, status: 502, json: async () => ({}) });
      return Promise.resolve({ ok: true, json: async () => { throw new SyntaxError('Unexpected token <'); } });
    };

    /** A hub whose node 2 is ready, then provisional; its next `failures` list reads fail the given way. */
    function demotedHub(failure: Failure, failures: number) {
      let state: 'provisional' | 'ready' = 'ready';
      let remaining = 0;
      apiFetch.mockImplementation((path: string) => {
        if (path === '/nodes') {
          if (remaining > 0) { remaining -= 1; return failing(failure); }
          return Promise.resolve({ ok: true, json: async () => [{ ...LOCAL_NODE }, bootstrapped(state)] });
        }
        if (path === '/nodes/2/meta') return Promise.resolve({ ok: true, json: async () => ({ version: '1.0.0', capabilities: ['stacks'], online: true }) });
        return Promise.resolve({ ok: true, json: async () => ({}) });
      });
      return { demote: () => { state = 'provisional'; remaining = failures; }, promote: () => { state = 'ready'; } };
    }

    for (const trigger of TRIGGERS) {
      for (const failure of FAILURES) {
        it(`reads the list again, without another event, after ${trigger.name} met a ${failure}`, async () => {
          vi.useFakeTimers();
          const error = vi.spyOn(console, 'error').mockImplementation(() => {});
          try {
            const hubState = demotedHub(failure, 1);
            const { result } = renderHook(() => useNodes(), { wrapper });
            await advance(0);
            expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('ready');
            const before = lists();
            hubState.demote();
            act(() => { trigger.fire(); });
            await advance(1000);
            // The catch-up failed: the old verdict is still on screen, and a read is owed.
            expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('ready');
            await advance(60_000);
            expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('provisional');
            const used = lists() - before;
            expect(used).toBe(2);
            // Once one read applied the signal is answered, and nothing keeps reading.
            await advance(120_000);
            expect(lists() - before).toBe(used);
          } finally {
            error.mockRestore();
            vi.useRealTimers();
          }
        });
      }
    }

    it('backs off while reads keep failing, and recovers the capabilities of a node that became ready', async () => {
      vi.useFakeTimers();
      localStorage.setItem('sencho-active-node', '2');
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        let state: 'provisional' | 'ready' = 'provisional';
        let failuresLeft = 0;
        let metaCalls = 0;
        apiFetch.mockImplementation((path: string) => {
          if (path === '/nodes') {
            if (failuresLeft > 0) { failuresLeft -= 1; return failing('rejected fetch'); }
            return Promise.resolve({ ok: true, json: async () => [{ ...LOCAL_NODE }, bootstrapped(state)] });
          }
          if (path === '/nodes/2/meta') {
            metaCalls += 1;
            return Promise.resolve(metaCalls === 1 ? { ok: false, json: async () => ({}) } : { ok: true, json: async () => ({ version: '1.0.0', capabilities: ['stacks'], online: true }) });
          }
          return Promise.resolve({ ok: true, json: async () => ({}) });
        });
        const { result } = renderHook(() => useNodes(), { wrapper });
        await advance(0);
        expect(result.current.hasCapability('stacks')).toBe(false);
        const before = lists();
        state = 'ready';
        failuresLeft = 3;
        act(() => { window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'node-readiness', nodeId: 2 } })); });
        await advance(500);
        expect(lists() - before).toBe(1);
        // Retries wait 5s, then 10s, then 20s: bounded, not a tight loop.
        await advance(4_900);
        expect(lists() - before).toBe(1);
        await advance(200);
        expect(lists() - before).toBe(2);
        await advance(10_100);
        expect(lists() - before).toBe(3);
        await advance(20_100);
        expect(lists() - before).toBe(4);
        expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('ready');
        expect(result.current.hasCapability('stacks')).toBe(true);
        expect(metaCalls).toBe(2);
      } finally {
        error.mockRestore();
        vi.useRealTimers();
      }
    });

    it('caps the wait between retries at 30 seconds', async () => {
      vi.useFakeTimers();
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const hubState = demotedHub('rejected fetch', 99);
        renderHook(() => useNodes(), { wrapper });
        await advance(0);
        const before = lists();
        hubState.demote();
        act(() => { TRIGGERS[0].fire(); });
        // Attempts at 0.5s, then waits of 5, 10, 20 and 30 seconds, and 30 seconds again: the cap holds.
        await advance(500 + 5_000 + 10_000 + 20_000 + 30_000 + 100);
        expect(lists() - before).toBe(5);
        await advance(30_000);
        expect(lists() - before).toBe(6);
        await advance(30_000);
        expect(lists() - before).toBe(7);
      } finally {
        error.mockRestore();
        vi.useRealTimers();
      }
    });

    it('does not read again for a signal that another read already answered while the retry waited', async () => {
      vi.useFakeTimers();
      try {
        const answers: Array<() => void> = [];
        let state: 'provisional' | 'ready' = 'ready';
        let held = false;
        apiFetch.mockImplementation((path: string) => {
          if (path !== '/nodes') return Promise.resolve({ ok: true, json: async () => ({}) });
          if (!held) return Promise.resolve({ ok: true, json: async () => [{ ...LOCAL_NODE }, bootstrapped(state)] });
          return new Promise((resolve) => { answers.push(() => resolve({ ok: true, json: async () => [{ ...LOCAL_NODE }, bootstrapped(state)] })); });
        });
        renderHook(() => useNodes(), { wrapper });
        await advance(0);
        const before = lists();
        held = true;
        state = 'provisional';
        const announce = () => window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'node-readiness', nodeId: 2 } }));
        // The first announcement's read is out when a second one arrives, so a second read starts behind it.
        act(() => { announce(); });
        await advance(500);
        act(() => { announce(); });
        await advance(500);
        expect(answers).toHaveLength(2);
        // The first answers (it began before the second signal, so one is still owed), then the second answers for both.
        await act(async () => { answers[0](); });
        await act(async () => { answers[1](); });
        await advance(60_000);
        expect(lists() - before).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops retrying when the provider unmounts', async () => {
      vi.useFakeTimers();
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const hubState = demotedHub('rejected fetch', 5);
        const { unmount } = renderHook(() => useNodes(), { wrapper });
        await advance(0);
        hubState.demote();
        act(() => { TRIGGERS[0].fire(); });
        await advance(1000);
        const used = lists();
        unmount();
        await advance(120_000);
        expect(lists()).toBe(used);
      } finally {
        error.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  describe('capabilities after readiness', () => {
    const ANNOUNCE = () => window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'node-readiness', nodeId: 2 } }));

    /** A hub whose node 2 is provisional until `becomeReady`, and whose metadata read follows `meta`. */
    function hub(meta: (call: number) => Promise<unknown>) {
      let state: 'provisional' | 'ready' = 'provisional';
      let metaCalls = 0;
      apiFetch.mockImplementation((path: string) => {
        if (path === '/nodes') return Promise.resolve({ ok: true, json: async () => [{ ...LOCAL_NODE }, bootstrapped(state)] });
        if (path === '/nodes/2/meta') { metaCalls += 1; return meta(metaCalls); }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      });
      return { becomeReady: () => { state = 'ready'; }, metaCalls: () => metaCalls };
    }
    const offline = () => Promise.resolve({ ok: false, json: async () => ({}) });
    const online = () => Promise.resolve({ ok: true, json: async () => ({ version: '1.0.0', capabilities: ['stacks', 'containers'], online: true }) });

    it('recovers the capabilities of a selected node whose first metadata read failed once it becomes ready', async () => {
      localStorage.setItem('sencho-active-node', '2');
      const h = hub((call) => (call === 1 ? offline() : online()));
      const { result } = renderHook(() => useNodes(), { wrapper });
      await waitFor(() => expect(result.current.activeNodeMeta?.capabilities).toEqual([]));
      expect(result.current.hasCapability('stacks')).toBe(false);

      h.becomeReady();
      act(() => { ANNOUNCE(); });
      // Not switching nodes and not testing the connection: the readiness announcement alone brings the capabilities back.
      await waitFor(() => expect(result.current.hasCapability('stacks')).toBe(true), { timeout: 3000 });
      expect(result.current.activeNodeMeta?.version).toBe('1.0.0');
    });

    it('reads the metadata of a node that became ready once for a burst of announcements, and not for a list that changed nothing', async () => {
      localStorage.setItem('sencho-active-node', '2');
      const h = hub((call) => (call === 1 ? offline() : online()));
      const { result } = renderHook(() => useNodes(), { wrapper });
      await waitFor(() => expect(result.current.activeNodeMeta).not.toBeNull());
      h.becomeReady();
      act(() => { ANNOUNCE(); ANNOUNCE(); });
      await waitFor(() => expect(result.current.hasCapability('stacks')).toBe(true), { timeout: 3000 });
      expect(h.metaCalls()).toBe(2);

      // Ready stays ready: the list is read again and the cached metadata is left alone.
      act(() => { ANNOUNCE(); });
      await waitFor(() => expect(apiFetch.mock.calls.filter(([path]) => path === '/nodes').length).toBeGreaterThanOrEqual(3), { timeout: 3000 });
      expect(h.metaCalls()).toBe(2);
    });

    it('does not let an older metadata read that answers last put the stale reading back', async () => {
      localStorage.setItem('sencho-active-node', '2');
      let releaseFirst: (() => void) | null = null;
      const h = hub((call) => (call === 1
        ? new Promise((resolve) => { releaseFirst = () => resolve({ ok: false, json: async () => ({}) }); })
        : online()));
      const { result } = renderHook(() => useNodes(), { wrapper });
      await waitFor(() => expect(h.metaCalls()).toBe(1));
      h.becomeReady();
      act(() => { ANNOUNCE(); });
      // No metadata is cached yet, so hasCapability is optimistic; wait for the forced read to land.
      await waitFor(() => expect(result.current.activeNodeMeta?.capabilities).toEqual(['stacks', 'containers']), { timeout: 3000 });
      expect(h.metaCalls()).toBe(2);
      await act(async () => { releaseFirst?.(); });
      expect(result.current.activeNodeMeta?.capabilities).toEqual(['stacks', 'containers']);
      expect(result.current.hasCapability('stacks')).toBe(true);
    });

    it('reads the metadata of an already ready selected node once on the first load, and the list again when the socket comes back', async () => {
      localStorage.setItem('sencho-active-node', '2');
      let state: 'provisional' | 'ready' = 'ready';
      let metaCalls = 0;
      apiFetch.mockImplementation((path: string) => {
        if (path === '/nodes') return Promise.resolve({ ok: true, json: async () => [{ ...LOCAL_NODE }, bootstrapped(state)] });
        if (path === '/nodes/2/meta') { metaCalls += 1; return online(); }
        return Promise.resolve({ ok: true, json: async () => ({}) });
      });
      const { result } = renderHook(() => useNodes(), { wrapper });
      await waitFor(() => expect(result.current.activeNodeMeta?.capabilities).toEqual(['stacks', 'containers']));
      expect(metaCalls).toBe(1);

      const connection = (connected: boolean) => act(() => { announceNotificationsConnection(connected); });
      const lists = () => apiFetch.mock.calls.filter(([path]) => path === '/nodes').length;
      const before = lists();
      connection(true);
      expect(lists()).toBe(before);
      // Announcements sent while the socket was down are lost; its return reads the list, so a verdict that changed shows.
      state = 'provisional';
      connection(false);
      connection(true);
      await waitFor(() => expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('provisional'));
      expect(lists()).toBe(before + 1);
    });

    it('reads the list when the socket returns from a drop that began before the provider mounted', async () => {
      localStorage.setItem('sencho-active-node', '2');
      let state: 'provisional' | 'ready' = 'ready';
      apiFetch.mockImplementation((path: string) => {
        if (path === '/nodes') return Promise.resolve({ ok: true, json: async () => [{ ...LOCAL_NODE }, bootstrapped(state)] });
        if (path === '/nodes/2/meta') return online();
        return Promise.resolve({ ok: true, json: async () => ({}) });
      });
      act(() => { announceNotificationsConnection(false); });
      const { result } = renderHook(() => useNodes(), { wrapper });
      await waitFor(() => expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('ready'));
      const lists = () => apiFetch.mock.calls.filter(([path]) => path === '/nodes').length;
      const before = lists();
      state = 'provisional';
      act(() => { announceNotificationsConnection(true); });
      await waitFor(() => expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('provisional'));
      expect(lists()).toBe(before + 1);
    });

    it('leaves the metadata of a node that has none cached and is not selected alone', async () => {
      const h = hub(() => online());
      const { result } = renderHook(() => useNodes(), { wrapper });
      await waitFor(() => expect(result.current.nodes).toHaveLength(2));
      h.becomeReady();
      act(() => { ANNOUNCE(); });
      await waitFor(() => expect(result.current.nodes.find((node) => node.id === 2)?.readiness?.state).toBe('ready'), { timeout: 3000 });
      expect(h.metaCalls()).toBe(0);
    });
  });
});
