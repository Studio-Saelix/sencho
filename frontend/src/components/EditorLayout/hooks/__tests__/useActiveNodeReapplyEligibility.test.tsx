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
});
