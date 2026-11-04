import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useActiveNodeReapplyEligibility } from '../useActiveNodeReapplyEligibility';

const apiFetchMock = vi.fn();

vi.mock('@/lib/api', () => ({
  apiFetch: (...args: unknown[]) => apiFetchMock(...args),
}));

function okJson(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('useActiveNodeReapplyEligibility', () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it('derives canReapply only when owned result matches active node and value is true', async () => {
    apiFetchMock.mockResolvedValue(okJson({
      nodes: [{ nodeId: 1, canReapplyCompose: true }],
    }));
    const { result } = renderHook(() => useActiveNodeReapplyEligibility(1));
    expect(result.current.canReapply).toBe(false);
    await waitFor(() => expect(result.current.canReapply).toBe(true));
  });

  it('ignores a late response for a previous node after switching', async () => {
    let resolveA!: (value: Response) => void;
    const pendingA = new Promise<Response>((resolve) => { resolveA = resolve; });
    apiFetchMock
      .mockImplementationOnce(() => pendingA)
      .mockResolvedValueOnce(okJson({
        nodes: [{ nodeId: 2, canReapplyCompose: false }],
      }));

    const { result, rerender } = renderHook(
      ({ id }: { id: number | null }) => useActiveNodeReapplyEligibility(id),
      { initialProps: { id: 1 as number | null } },
    );

    rerender({ id: 2 });
    await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(2));
    expect(result.current.canReapply).toBe(false);

    await act(async () => {
      resolveA(okJson({
        nodes: [{ nodeId: 1, canReapplyCompose: true }],
      }));
    });

    expect(result.current.canReapply).toBe(false);
    expect(result.current.owned?.nodeId === 2 || result.current.owned === null || result.current.owned.nodeId === 2).toBe(true);
  });

  it('stays ineligible when the row is missing canReapplyCompose', async () => {
    apiFetchMock.mockResolvedValue(okJson({
      nodes: [{ nodeId: 1 }],
    }));
    const { result } = renderHook(() => useActiveNodeReapplyEligibility(1));
    await waitFor(() => expect(result.current.owned).not.toBeNull());
    expect(result.current.canReapply).toBe(false);
  });

  it('exposes the reason the backend reported for an ineligible node', async () => {
    apiFetchMock.mockResolvedValue(okJson({
      nodes: [{ nodeId: 1, canReapplyCompose: false, reapplyUnavailableReason: 'docker_unreachable' }],
    }));
    const { result } = renderHook(() => useActiveNodeReapplyEligibility(1));
    await waitFor(() => expect(result.current.reason).toBe('docker_unreachable'));
    expect(result.current.canReapply).toBe(false);
  });

  it('refresh() applies a recovered answer and clears the reason', async () => {
    apiFetchMock
      .mockResolvedValueOnce(okJson({
        nodes: [{ nodeId: 1, canReapplyCompose: false, reapplyUnavailableReason: 'detecting' }],
      }))
      .mockResolvedValueOnce(okJson({
        nodes: [{ nodeId: 1, canReapplyCompose: true, reapplyUnavailableReason: null }],
      }));
    const { result } = renderHook(() => useActiveNodeReapplyEligibility(1));
    await waitFor(() => expect(result.current.reason).toBe('detecting'));

    let snapshot: Awaited<ReturnType<typeof result.current.refresh>> = null;
    await act(async () => {
      snapshot = await result.current.refresh();
    });

    expect(snapshot).toEqual({ canReapply: true, reason: null });
    expect(result.current.canReapply).toBe(true);
    expect(result.current.reason).toBeNull();
  });

  it('refresh() drops an answer that lands after the active node changed', async () => {
    // A fresh Response per call: a Response body can only be read once.
    apiFetchMock.mockImplementation(async () => okJson({
      nodes: [
        { nodeId: 1, canReapplyCompose: false, reapplyUnavailableReason: 'detecting' },
        { nodeId: 2, canReapplyCompose: false, reapplyUnavailableReason: 'not_compose_managed' },
      ],
    }));
    const { result, rerender } = renderHook(
      ({ id }: { id: number | null }) => useActiveNodeReapplyEligibility(id),
      { initialProps: { id: 1 as number | null } },
    );
    await waitFor(() => expect(result.current.reason).toBe('detecting'));

    let resolveRefresh!: (value: Response) => void;
    apiFetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveRefresh = resolve; }));

    let pending: Promise<unknown> = Promise.resolve(null);
    act(() => {
      pending = result.current.refresh();
    });

    // Switch nodes while the click-time re-read is still in flight.
    rerender({ id: 2 });
    await waitFor(() => expect(result.current.reason).toBe('not_compose_managed'));

    await act(async () => {
      resolveRefresh(okJson({ nodes: [{ nodeId: 1, canReapplyCompose: true }] }));
      await pending;
    });

    // Node 2 keeps its own answer; node 1's late eligibility never lands here.
    expect(result.current.canReapply).toBe(false);
    expect(result.current.reason).toBe('not_compose_managed');
  });
});
