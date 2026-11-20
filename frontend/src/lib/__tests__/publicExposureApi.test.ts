import { describe, it, expect, vi, beforeEach } from 'vitest';

const apiFetchMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api', () => ({ apiFetch: apiFetchMock }));

import { publicExposureApi } from '../publicExposureApi';

function answer(body: unknown, status = 200): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

describe('publicExposureApi.disconnect', () => {
  it('returns the record names the control instance left in Cloudflare', async () => {
    apiFetchMock.mockReturnValue(answer({ connected: false, leftInCloudflare: ['_sencho-check-a.example.com', '_sencho-check-a.example.net'] }));
    await expect(publicExposureApi.disconnect()).resolves.toEqual({
      connected: false,
      leftInCloudflare: ['_sencho-check-a.example.com', '_sencho-check-a.example.net'],
    });
    expect(apiFetchMock).toHaveBeenCalledWith('/public-exposure/account', expect.objectContaining({ method: 'DELETE', localOnly: true }));
  });

  it.each([
    ['a clean disconnect', { connected: false, leftInCloudflare: [] }, []],
    ['an answer without the list', { connected: false }, []],
    ['a list that is not an array', { connected: false, leftInCloudflare: 'x' }, []],
    ['a list with entries that are not names', { connected: false, leftInCloudflare: ['a', 1, null] }, ['a']],
  ])('reads %s', async (_label, body, expected) => {
    apiFetchMock.mockReturnValue(answer(body));
    await expect(publicExposureApi.disconnect()).resolves.toEqual({ connected: false, leftInCloudflare: expected });
  });

  it('throws the route sentence when the disconnect is refused', async () => {
    apiFetchMock.mockReturnValue(answer({ error: 'Nodes still use this Cloudflare account.', code: 'ENDPOINTS_EXIST' }, 409));
    await expect(publicExposureApi.disconnect()).rejects.toMatchObject({ code: 'ENDPOINTS_EXIST', status: 409 });
  });
});
