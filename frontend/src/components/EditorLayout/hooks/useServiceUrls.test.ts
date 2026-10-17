import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serviceUrlSaveBlockedMessage } from '@/lib/serviceUrlResolve';
import { useServiceUrls } from './useServiceUrls';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '@/lib/api';

const fetchMock = vi.mocked(apiFetch);

function anatomy(url: string): Response {
  return {
    ok: true,
    json: async () => ({
      renderable: true,
      serviceUrls: { web: url },
      ports: { web: [{ host: '8080', proto: 'tcp' }] },
    }),
  } as Response;
}

describe('useServiceUrls', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  it('replaces the cached URL when the same stack is reloaded', async () => {
    fetchMock
      .mockResolvedValueOnce(anatomy('https://a.example.com'))
      .mockResolvedValueOnce(anatomy('https://b.example.com'));
    const { result } = renderHook(() => useServiceUrls(1, 'web.yaml'));
    await waitFor(() => expect(result.current.entry?.serviceUrls.web).toBe('https://a.example.com'));

    fetchMock.mockResolvedValueOnce(anatomy('https://b.example.com'));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.entry?.serviceUrls.web).toBe('https://b.example.com');
  });

  it('discards a delayed response after a newer reload', async () => {
    let releaseFirst: (response: Response) => void = () => {};
    const first = new Promise<Response>(resolve => {
      releaseFirst = resolve;
    });
    fetchMock.mockImplementationOnce(() => first);
    const { result } = renderHook(() => useServiceUrls(1, 'web.yaml'));
    await act(async () => {
      await Promise.resolve();
    });

    fetchMock.mockResolvedValueOnce(anatomy('https://b.example.com'));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.entry?.serviceUrls.web).toBe('https://b.example.com');

    await act(async () => {
      releaseFirst(anatomy('https://a.example.com'));
      await first;
    });
    expect(result.current.entry?.serviceUrls.web).toBe('https://b.example.com');
  });

  it('keeps the previous URL while a reload is in flight', async () => {
    fetchMock.mockResolvedValueOnce(anatomy('https://a.example.com'));
    const { result } = renderHook(() => useServiceUrls(1, 'web.yaml'));
    await waitFor(() => expect(result.current.entry?.status).toBe('ready'));

    let release: (response: Response) => void = () => {};
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.refresh();
    });
    expect(result.current.entry?.status).toBe('ready');
    expect(result.current.entry?.serviceUrls.web).toBe('https://a.example.com');
    await act(async () => {
      release(anatomy('https://b.example.com'));
      await pending;
    });
    expect(result.current.entry?.serviceUrls.web).toBe('https://b.example.com');
  });

  it('keeps the last URL when a refresh request fails and returns the failure to the caller', async () => {
    fetchMock.mockResolvedValueOnce(anatomy('https://a.example.com'));
    const { result } = renderHook(() => useServiceUrls(1, 'web.yaml'));
    await waitFor(() => expect(result.current.entry?.status).toBe('ready'));

    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'down' }) } as Response);
    const returned: { status?: string; blocked?: string | null } = {};
    await act(async () => {
      const next = await result.current.refresh();
      returned.status = next?.status;
      returned.blocked = serviceUrlSaveBlockedMessage(next, 'web', 'https://new.example.com');
    });
    expect(returned.status).toBe('unavailable');
    expect(returned.blocked).toBeTruthy();
    expect(result.current.entry).toMatchObject({
      status: 'ready',
      refreshFailed: true,
      serviceUrls: { web: 'https://a.example.com' },
    });

    fetchMock.mockRejectedValueOnce(new Error('network'));
    await act(async () => {
      const next = await result.current.refresh();
      returned.status = next?.status;
      returned.blocked = serviceUrlSaveBlockedMessage(next, 'web', null);
    });
    expect(returned.status).toBe('unavailable');
    expect(returned.blocked).toBeTruthy();
    expect(result.current.entry?.serviceUrls.web).toBe('https://a.example.com');

    fetchMock.mockResolvedValueOnce(anatomy('https://b.example.com'));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.entry).toMatchObject({
      status: 'ready',
      serviceUrls: { web: 'https://b.example.com' },
    });
    expect(result.current.entry?.refreshFailed).toBeUndefined();
  });

  it('does not keep a model when the first load fails', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'down' }) } as Response);
    const { result } = renderHook(() => useServiceUrls(1, 'web.yaml'));
    await waitFor(() => expect(result.current.entry?.status).toBe('unavailable'));
    expect(result.current.entry?.refreshFailed).toBeUndefined();
    expect(result.current.entry?.serviceUrls.web).toBeUndefined();
  });

  it('drops the last URL when the compose file no longer renders', async () => {
    fetchMock.mockResolvedValueOnce(anatomy('https://a.example.com'));
    const { result } = renderHook(() => useServiceUrls(1, 'web.yaml'));
    await waitFor(() => expect(result.current.entry?.status).toBe('ready'));

    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ renderable: false, serviceUrls: {}, ports: {} }),
    } as Response);
    let blocked: string | null = null;
    await act(async () => {
      const next = await result.current.refresh();
      blocked = serviceUrlSaveBlockedMessage(next, 'web', 'https://new.example.com');
    });
    expect(blocked).toBeTruthy();
    expect(result.current.entry?.status).toBe('unavailable');
    expect(result.current.entry?.serviceUrls.web).toBeUndefined();
    expect(result.current.entry?.refreshFailed).toBeUndefined();
  });

  it('never returns the previous stack or node URL after the selection changes', async () => {
    const seen: Array<{ nodeId: number | null; stackName: string | null; entryStack: string | null; entryNode: number | null; url: string | undefined }> = [];
    fetchMock.mockImplementation(async (path, options) => {
      const node = (options as { nodeId?: number | null } | undefined)?.nodeId ?? null;
      return anatomy(`https://${String(path).split('/')[2]}-${node}.example.com`);
    });
    const { result, rerender } = renderHook(
      ({ nodeId, stackName }: { nodeId: number | null; stackName: string | null }) => {
        const value = useServiceUrls(nodeId, stackName);
        seen.push({
          nodeId,
          stackName,
          entryStack: value.entry?.stackName ?? null,
          entryNode: value.entry?.nodeId ?? null,
          url: value.entry?.serviceUrls.web,
        });
        return value;
      },
      { initialProps: { nodeId: 1 as number | null, stackName: 'a' as string | null } },
    );
    await waitFor(() => expect(result.current.entry?.serviceUrls.web).toBe('https://a-1.example.com'));

    rerender({ nodeId: 1, stackName: 'b' });
    await waitFor(() => expect(result.current.entry?.serviceUrls.web).toBe('https://b-1.example.com'));
    rerender({ nodeId: 2, stackName: 'b' });
    await waitFor(() => expect(result.current.entry?.serviceUrls.web).toBe('https://b-2.example.com'));
    rerender({ nodeId: 2, stackName: null });
    expect(result.current.entry).toBeNull();

    for (const render of seen) {
      if (render.entryStack === null) continue;
      expect({ stackName: render.entryStack, nodeId: render.entryNode }).toEqual({ stackName: render.stackName, nodeId: render.nodeId });
      if (render.url) expect(render.url).toBe(`https://${render.stackName}-${render.nodeId}.example.com`);
    }
  });
  it('keeps the new stack when the previous stack answers late', async () => {
    let releaseA: (response: Response) => void = () => {};
    const pendingA = new Promise<Response>(resolve => { releaseA = resolve; });
    fetchMock
      .mockImplementationOnce(() => pendingA)
      .mockResolvedValueOnce(anatomy('https://b.example.com'));
    const { result, rerender } = renderHook(
      ({ stackName }: { stackName: string }) => useServiceUrls(1, stackName),
      { initialProps: { stackName: 'a' } },
    );
    await act(async () => {
      await Promise.resolve();
    });
    rerender({ stackName: 'b' });
    await waitFor(() => expect(result.current.entry?.serviceUrls.web).toBe('https://b.example.com'));

    await act(async () => {
      releaseA(anatomy('https://a.example.com'));
      await pendingA;
    });
    expect(result.current.entry).toMatchObject({ stackName: 'b', status: 'ready', serviceUrls: { web: 'https://b.example.com' } });
  });
});
