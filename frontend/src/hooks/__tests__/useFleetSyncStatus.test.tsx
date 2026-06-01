import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const fetchStatusesMock = vi.fn();
let mockIsPaid = false;
let mockIsAdmin = false;

vi.mock('@/lib/fleetSyncApi', () => ({
  fetchFleetSyncStatuses: (...args: unknown[]) => fetchStatusesMock(...args),
}));
vi.mock('@/context/LicenseContext', () => ({
  useLicense: () => ({ isPaid: mockIsPaid }),
}));
vi.mock('@/context/AuthContext', () => ({
  useAuth: () => ({ isAdmin: mockIsAdmin }),
}));
// Run the interval callback synchronously so we can assert it is (not) armed
// without faking timers.
vi.mock('@/lib/utils', () => ({
  visibilityInterval: (fn: () => void) => { fn(); return () => undefined; },
}));

import { useFleetSyncStatus } from '../useFleetSyncStatus';

beforeEach(() => {
  fetchStatusesMock.mockReset().mockResolvedValue([{ node_id: 1, resource: 'scan_policies' }]);
  mockIsPaid = false;
  mockIsAdmin = false;
});
afterEach(() => vi.clearAllMocks());

describe('useFleetSyncStatus gate parity', () => {
  it('fetches for a paid admin (mirrors requireAdmin + requirePaid)', async () => {
    mockIsPaid = true;
    mockIsAdmin = true;
    const { result } = renderHook(() => useFleetSyncStatus());

    await waitFor(() => expect(result.current.statuses).toHaveLength(1));
    expect(fetchStatusesMock).toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
  });

  it('does not fetch for a paid non-admin (the 403-loop this fix prevents)', async () => {
    mockIsPaid = true;
    mockIsAdmin = false;
    const { result } = renderHook(() => useFleetSyncStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchStatusesMock).not.toHaveBeenCalled();
    expect(result.current.statuses).toEqual([]);
  });

  it('does not fetch for an admin on a community license', async () => {
    mockIsPaid = false;
    mockIsAdmin = true;
    const { result } = renderHook(() => useFleetSyncStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchStatusesMock).not.toHaveBeenCalled();
    expect(result.current.statuses).toEqual([]);
  });

  it('does not fetch when neither paid nor admin', async () => {
    const { result } = renderHook(() => useFleetSyncStatus());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchStatusesMock).not.toHaveBeenCalled();
  });

  it('ignores rows from a fetch that resolves after the gate flips ineligible', async () => {
    let resolveFetch!: (rows: Array<{ node_id: number; resource: string }>) => void;
    const pending = new Promise<Array<{ node_id: number; resource: string }>>((res) => { resolveFetch = res; });
    fetchStatusesMock.mockReturnValue(pending);
    mockIsPaid = true;
    mockIsAdmin = true;
    const { result, rerender } = renderHook(() => useFleetSyncStatus());
    expect(fetchStatusesMock).toHaveBeenCalled();
    expect(result.current.statuses).toEqual([]); // in-flight, not resolved yet

    // Lose admin before the in-flight fetch resolves.
    mockIsAdmin = false;
    act(() => { rerender(); });
    expect(result.current.statuses).toEqual([]);

    // The late resolve must not republish rows to the now-ineligible client.
    await act(async () => {
      resolveFetch([{ node_id: 9, resource: 'scan_policies' }]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.statuses).toEqual([]);
  });

  it('starts fetching once the user becomes a paid admin', async () => {
    const { result, rerender } = renderHook(() => useFleetSyncStatus());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(fetchStatusesMock).not.toHaveBeenCalled();

    mockIsPaid = true;
    mockIsAdmin = true;
    act(() => { rerender(); });

    await waitFor(() => expect(fetchStatusesMock).toHaveBeenCalled());
    await waitFor(() => expect(result.current.statuses).toHaveLength(1));
  });
});
