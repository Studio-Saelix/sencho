import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, waitFor } from '@testing-library/react';
import { NodeProvider, useNodes } from '../NodeContext';

const apiFetch = vi.fn();
vi.mock('@/lib/api', () => ({
  apiFetch: (path: string, opts?: unknown) => apiFetch(path, opts),
}));

const LOCAL_NODE = {
  id: 1,
  name: 'local',
  type: 'local' as const,
  compose_dir: '/compose',
  is_default: true,
  status: 'online' as const,
  created_at: 0,
};

function wrapper({ children }: { children: ReactNode }) {
  return <NodeProvider>{children}</NodeProvider>;
}

describe('NodeContext meta fetch error handling', () => {
  beforeEach(() => {
    localStorage.clear();
    apiFetch.mockReset();
  });

  it('records an offline meta on a non-OK meta response so gates fail closed', async () => {
    // The meta endpoint resolves with a non-OK status (proxy error / 5xx).
    // Previously this wrote no record and hasCapability stayed optimistically
    // true forever; now it must write an offline record so gates lock.
    apiFetch.mockImplementation((path: string) => {
      if (path === '/nodes') {
        return Promise.resolve({ ok: true, json: async () => [LOCAL_NODE] });
      }
      if (path.startsWith('/nodes/1/meta')) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    const { result } = renderHook(() => useNodes(), { wrapper });

    await waitFor(() => expect(result.current.activeNode?.id).toBe(1));
    // After the failed meta resolves, the offline record drives hasCapability to false.
    await waitFor(() => expect(result.current.hasCapability('stacks')).toBe(false));
    expect(result.current.activeNodeMeta).toEqual({
      version: null,
      capabilities: [],
      fetchedAt: expect.any(Number),
    });
  });

  it('records advertised capabilities on an OK meta response', async () => {
    apiFetch.mockImplementation((path: string) => {
      if (path === '/nodes') {
        return Promise.resolve({ ok: true, json: async () => [LOCAL_NODE] });
      }
      if (path.startsWith('/nodes/1/meta')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ version: '0.86.6', capabilities: ['stacks', 'fleet'] }),
        });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    const { result } = renderHook(() => useNodes(), { wrapper });

    await waitFor(() => expect(result.current.activeNode?.id).toBe(1));
    await waitFor(() => expect(result.current.hasCapability('fleet')).toBe(true));
    expect(result.current.hasCapability('vulnerability-scanning')).toBe(false);
  });
});
