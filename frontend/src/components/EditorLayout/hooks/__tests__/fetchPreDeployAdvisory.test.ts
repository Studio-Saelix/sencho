/**
 * fetchPreDeployAdvisory is the pre-deploy gate's data fetch. It returns the
 * image list only when the advisory is enabled and the backend answers cleanly;
 * every other case returns null ("deploy normally"). Failing open is the whole
 * point: the advisory is visibility and must never block a deploy when the
 * summary is unavailable (older node, timeout, network error).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  withDeploySession: (_id: string, o: object) => o,
}));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), loading: vi.fn(() => 'id'), dismiss: vi.fn() },
}));

import { apiFetch } from '@/lib/api';
import { fetchPreDeployAdvisory } from '../useStackActions';

const mockedFetch = vi.mocked(apiFetch);

function response(ok: boolean, body: unknown): Response {
  return { ok, json: async () => body } as unknown as Response;
}

beforeEach(() => mockedFetch.mockReset());

describe('fetchPreDeployAdvisory', () => {
  it('returns the image list when the advisory is enabled, bound to the captured node', async () => {
    mockedFetch.mockResolvedValue(response(true, { enabled: true, images: [{ imageRef: 'nginx:1.14', scan: null }] }));
    const result = await fetchPreDeployAdvisory('web', 7);
    expect(result).toEqual([{ imageRef: 'nginx:1.14', scan: null }]);
    expect(mockedFetch).toHaveBeenCalledWith(
      '/security/stacks/web/pre-deploy-summary',
      expect.objectContaining({ nodeId: 7 }),
    );
  });

  it('returns null when the advisory is disabled', async () => {
    mockedFetch.mockResolvedValue(response(true, { enabled: false }));
    expect(await fetchPreDeployAdvisory('web', 1)).toBeNull();
  });

  it('fails open on a non-ok response (older node without the route)', async () => {
    mockedFetch.mockResolvedValue(response(false, {}));
    expect(await fetchPreDeployAdvisory('web', null)).toBeNull();
  });

  it('fails open when the response cannot be read (timeout / abort / network)', async () => {
    // A read failure inside the request exercises the same fail-open catch a
    // network rejection would, without leaving a stray rejected promise that the
    // test runner would flag as unhandled.
    mockedFetch.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new Error('aborted');
      },
    } as unknown as Response);
    expect(await fetchPreDeployAdvisory('web', 1)).toBeNull();
  });

  it('fails open on a malformed body', async () => {
    mockedFetch.mockResolvedValue(response(true, { enabled: true, images: 'not-an-array' }));
    expect(await fetchPreDeployAdvisory('web', 1)).toBeNull();
  });
});
