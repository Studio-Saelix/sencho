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
