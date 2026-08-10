import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/api';
import {
  __resetStackStatusesFetchForTests,
  clearStackStatusesFetch,
  fetchStackStatusesShared,
} from '@/lib/stackStatusesFetch';

function jsonResponse(body: unknown, init: { status?: number; proxied?: boolean } = {}): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (init.proxied) headers.set('x-sencho-proxy', '1');
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers,
  });
}

describe('fetchStackStatusesShared', () => {
  let apiFetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    __resetStackStatusesFetchForTests();
    apiFetchSpy = vi.spyOn(api, 'apiFetch');
  });

  afterEach(() => {
    __resetStackStatusesFetchForTests();
    apiFetchSpy.mockRestore();
  });

  it('coalesces concurrent callers for the same nodeId into one apiFetch', async () => {
    let release!: (res: Response) => void;
    const gate = new Promise<Response>((resolve) => { release = resolve; });
    apiFetchSpy.mockReturnValueOnce(gate);

    const a = fetchStackStatusesShared(1);
    const b = fetchStackStatusesShared(1);
    expect(apiFetchSpy).toHaveBeenCalledTimes(1);
    expect(apiFetchSpy).toHaveBeenCalledWith('/stacks/statuses', { nodeId: 1 });

    release(jsonResponse({ 'demo.yml': { status: 'running' } }));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.coalesced).toBe(false);
    expect(rb.coalesced).toBe(true);
    expect(ra.body).toEqual(rb.body);
    expect(ra.ok).toBe(true);
  });

  it('issues a second fetch when the second caller starts after the first resolves', async () => {
    apiFetchSpy
      .mockResolvedValueOnce(jsonResponse({ a: { status: 'running' } }))
      .mockResolvedValueOnce(jsonResponse({ b: { status: 'exited' } }));

    const first = await fetchStackStatusesShared(1);
    const second = await fetchStackStatusesShared(1);
    expect(apiFetchSpy).toHaveBeenCalledTimes(2);
    expect(first.coalesced).toBe(false);
    expect(second.coalesced).toBe(false);
    expect(first.body).not.toEqual(second.body);
  });

  it('does not share across different nodeIds', async () => {
    apiFetchSpy
      .mockResolvedValueOnce(jsonResponse({ local: { status: 'running' } }))
      .mockResolvedValueOnce(jsonResponse({ remote: { status: 'running' } }));

    const [a, b] = await Promise.all([
      fetchStackStatusesShared(1),
      fetchStackStatusesShared(2),
    ]);
    expect(apiFetchSpy).toHaveBeenCalledTimes(2);
    expect(a.coalesced).toBe(false);
    expect(b.coalesced).toBe(false);
  });

  it('forwards explicit null as the local key and apiFetch nodeId', async () => {
    apiFetchSpy.mockResolvedValueOnce(jsonResponse({}));
    await fetchStackStatusesShared(null);
    expect(apiFetchSpy).toHaveBeenCalledWith('/stacks/statuses', { nodeId: null });
  });

  it('ignores localStorage divergence when an explicit nodeId is passed', async () => {
    localStorage.setItem('sencho-active-node', '99');
    let release!: (res: Response) => void;
    const gate = new Promise<Response>((resolve) => { release = resolve; });
    apiFetchSpy.mockReturnValueOnce(gate);

    const a = fetchStackStatusesShared(3);
    const b = fetchStackStatusesShared(3);
    expect(apiFetchSpy).toHaveBeenCalledTimes(1);
    expect(apiFetchSpy).toHaveBeenCalledWith('/stacks/statuses', { nodeId: 3 });
    release(jsonResponse({}));
    await Promise.all([a, b]);
    localStorage.removeItem('sencho-active-node');
  });

  it('clears on sencho-unauthorized so the next caller issues a fresh fetch', async () => {
    let release!: (res: Response) => void;
    const gate = new Promise<Response>((resolve) => { release = resolve; });
    apiFetchSpy
      .mockReturnValueOnce(gate)
      .mockResolvedValueOnce(jsonResponse({ after: { status: 'exited' } }));

    const pending = fetchStackStatusesShared(1);
    window.dispatchEvent(new Event('sencho-unauthorized'));
    release(jsonResponse({ before: { status: 'running' } }));
    await pending.catch(() => undefined);

    const next = await fetchStackStatusesShared(1);
    expect(apiFetchSpy).toHaveBeenCalledTimes(2);
    expect(next.coalesced).toBe(false);
    expect((next.body as Record<string, unknown>).after).toBeTruthy();
  });

  it('clearStackStatusesFetch clears without requiring the window event', async () => {
    let release!: (res: Response) => void;
    const gate = new Promise<Response>((resolve) => { release = resolve; });
    apiFetchSpy
      .mockReturnValueOnce(gate)
      .mockResolvedValueOnce(jsonResponse({}));

    const pending = fetchStackStatusesShared(1);
    clearStackStatusesFetch();
    release(jsonResponse({ stale: true }));
    await pending;

    await fetchStackStatusesShared(1);
    expect(apiFetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does not retain a rejected promise for later callers', async () => {
    apiFetchSpy
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(jsonResponse({ ok: { status: 'running' } }));

    await expect(fetchStackStatusesShared(1)).rejects.toThrow('network down');
    const recovered = await fetchStackStatusesShared(1);
    expect(apiFetchSpy).toHaveBeenCalledTimes(2);
    expect(recovered.ok).toBe(true);
  });

  it('propagates JSON decode failures to both waiters and clears the slot', async () => {
    const bad = new Response('not-json', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    apiFetchSpy
      .mockResolvedValueOnce(bad)
      .mockResolvedValueOnce(jsonResponse({}));

    const a = fetchStackStatusesShared(1);
    const b = fetchStackStatusesShared(1);
    await expect(a).rejects.toThrow();
    await expect(b).rejects.toThrow();
    const recovered = await fetchStackStatusesShared(1);
    expect(recovered.ok).toBe(true);
    expect(apiFetchSpy).toHaveBeenCalledTimes(2);
  });
});
