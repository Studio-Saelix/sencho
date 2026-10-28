/**
 * useImageScan triggers a scan and polls to completion. This covers the
 * start-failure path: a non-OK scan POST surfaces an error toast (with the HTTP
 * status, not a confusing JSON parse error) and clears the in-flight ref, rather
 * than spinning until the poll timeout.
 */
import { it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
  toast: { error: vi.fn(), success: vi.fn(), loading: vi.fn(() => 'id'), dismiss: vi.fn() },
}));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { useImageScan } from '../useImageScan';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedToast = toast as unknown as { error: ReturnType<typeof vi.fn> };

beforeEach(() => {
  mockedFetch.mockReset();
  mockedToast.error.mockReset();
});

it('toasts the HTTP status and clears the in-flight ref when the scan POST fails', async () => {
  mockedFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as unknown as Response);

  const onComplete = vi.fn();
  const onSummaries = vi.fn();
  const { result } = renderHook(() => useImageScan({ onComplete, onSummaries }));

  await act(async () => {
    await result.current.scanImage('nginx:1', ['vuln']);
  });

  await waitFor(() => expect(mockedToast.error).toHaveBeenCalledWith(expect.stringContaining('503')));
  expect(onComplete).not.toHaveBeenCalled();
  expect(result.current.scanningRef).toBeNull();
});

function scanPostBody(): { force: boolean; scanners: string[] } {
  const call = mockedFetch.mock.calls.find(([url]) => url === '/security/scan');
  return JSON.parse(String((call![1] as RequestInit).body));
}

it('forces a re-scan by default and lets a first scan opt out', async () => {
  mockedFetch.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as unknown as Response);
  const { result } = renderHook(() => useImageScan({ onComplete: vi.fn(), onSummaries: vi.fn() }));

  await act(async () => { await result.current.scanImage('nginx:1', ['vuln']); });
  expect(scanPostBody().force).toBe(true);

  mockedFetch.mockClear();
  await act(async () => { await result.current.scanImage('nginx:1', ['vuln', 'secret'], { force: false }); });
  expect(scanPostBody()).toEqual({ imageRef: 'nginx:1', force: false, scanners: ['vuln', 'secret'] });
});

it('stops following a scan on cancelScan without reporting an error or completion', async () => {
  let release: ((r: Response) => void) | undefined;
  mockedFetch.mockImplementation((url: string) => {
    if (url === '/security/scan') return new Promise<Response>((resolve) => { release = resolve; });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 'in_progress' }) } as unknown as Response);
  });
  const onComplete = vi.fn();
  const { result } = renderHook(() => useImageScan({ onComplete, onSummaries: vi.fn() }));

  let scanning!: Promise<void>;
  act(() => { scanning = result.current.scanImage('nginx:1', ['vuln']); });
  await waitFor(() => expect(release).toBeDefined());
  expect(result.current.scanningRef).toBe('nginx:1');

  act(() => { result.current.cancelScan(); });
  release!({ ok: true, status: 200, json: async () => ({ scanId: 9 }) } as unknown as Response);
  await act(async () => { await scanning; });

  expect(onComplete).not.toHaveBeenCalled();
  expect(mockedToast.error).not.toHaveBeenCalled();
  expect(result.current.scanningRef).toBeNull();
});
