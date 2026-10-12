import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
});
