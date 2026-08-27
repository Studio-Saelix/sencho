import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { absentRevision, missingApplicationLimitation, sourceRevision } from '@/__tests__/gitopsFixtures';
import { useGitOpsSourceStates } from './useGitOpsSourceStates';

const apiFetch = vi.hoisted(() => vi.fn());
const activeNode = vi.hoisted(() => ({ current: { id: 1, name: 'Local' } as { id: number; name: string } | null }));

vi.mock('@/lib/api', () => ({ apiFetch }));
vi.mock('@/context/NodeContext', () => ({ useNodes: () => ({ activeNode: activeNode.current }) }));

const ok = (rows: unknown) => ({ ok: true, status: 200, json: async () => rows });

/** Fire the invalidate the publisher's event turns into on the client. */
const announceGitOps = () => {
  window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'gitops' } }));
};

describe('useGitOpsSourceStates', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    apiFetch.mockReset();
    activeNode.current = { id: 1, name: 'Local' };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('maps each row with a live source facet by stack name', async () => {
    apiFetch.mockResolvedValue(ok([
      { stack_name: 'bookstack', gitopsRevision: sourceRevision('candidate_ready') },
      { stack_name: 'wiki', gitopsRevision: sourceRevision('source_review_pending') },
    ]));

    const { result } = renderHook(() => useGitOpsSourceStates());

    await waitFor(() => expect(result.current).toEqual({
      bookstack: 'candidate_ready',
      wiki: 'source_review_pending',
    }));
  });

  it('omits a row from a node that predates the revision model', async () => {
    // /git-sources is proxied, so a row without the field is an ordinary
    // answer from an older node, not an error.
    apiFetch.mockResolvedValue(ok([
      { stack_name: 'legacy' },
      { stack_name: 'bookstack', gitopsRevision: sourceRevision('candidate_ready') },
    ]));

    const { result } = renderHook(() => useGitOpsSourceStates());

    await waitFor(() => expect(result.current).toEqual({ bookstack: 'candidate_ready' }));
  });

  it('omits a projection that could not be read', async () => {
    // A fault means an application was expected and could not be reached.
    // Naming a source state for it would be a guess; the panels report the
    // fault properly and this badge stays away.
    apiFetch.mockResolvedValue(ok([
      { stack_name: 'broken', gitopsRevision: absentRevision([missingApplicationLimitation]) },
    ]));

    const { result } = renderHook(() => useGitOpsSourceStates());

    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(result.current).toEqual({});
  });

  it('refetches on a gitops announcement, coalescing a burst into one call', async () => {
    apiFetch.mockResolvedValue(ok([
      { stack_name: 'bookstack', gitopsRevision: sourceRevision('candidate_ready') },
    ]));
    const { result } = renderHook(() => useGitOpsSourceStates());
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));

    // `candidateGenerationId: null` because the deriver returns from the
    // candidate branch before it can reach an accepted status, so the pair
    // without it is a state no backend can emit.
    apiFetch.mockResolvedValue(ok([
      {
        stack_name: 'bookstack',
        gitopsRevision: sourceRevision('application_generation_accepted', { candidateGenerationId: null }),
      },
    ]));
    act(() => {
      announceGitOps();
      announceGitOps();
      announceGitOps();
    });
    // One operation commits several transitions in a row, so three events must
    // not become three fetches.
    expect(apiFetch).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    // The refetch's answer has to land, not just be requested.
    await waitFor(() => expect(result.current).toEqual({ bookstack: 'application_generation_accepted' }));
  });

  it('blanks the map on a node switch before the new node answers', async () => {
    apiFetch.mockResolvedValue(ok([
      { stack_name: 'bookstack', gitopsRevision: sourceRevision('candidate_ready') },
    ]));
    const { result, rerender } = renderHook(() => useGitOpsSourceStates());
    await waitFor(() => expect(result.current).toEqual({ bookstack: 'candidate_ready' }));

    // Never resolves, so the only thing that can clear the old node's map is
    // the blanking itself.
    apiFetch.mockImplementation(() => new Promise(() => {}));
    activeNode.current = { id: 2, name: 'Remote' };
    rerender();

    await waitFor(() => expect(result.current).toEqual({}));
  });

  it('skips a row it cannot read and keeps the rest', async () => {
    // A proxied node is free to answer with a shape this build does not
    // assume. One bad row must not abandon the loop and freeze every badge.
    apiFetch.mockResolvedValue(ok([
      { stack_name: 'broken', gitopsRevision: { targetMode: 'direct' } },
      { stack_name: 'bookstack', gitopsRevision: sourceRevision('candidate_ready') },
    ]));

    const { result } = renderHook(() => useGitOpsSourceStates());

    await waitFor(() => expect(result.current).toEqual({ bookstack: 'candidate_ready' }));
  });

  it('ignores an announcement from another scope', async () => {
    apiFetch.mockResolvedValue(ok([]));
    renderHook(() => useGitOpsSourceStates());
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));

    act(() => {
      window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'image-updates' } }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous map when a refetch fails', async () => {
    apiFetch.mockResolvedValue(ok([
      { stack_name: 'bookstack', gitopsRevision: sourceRevision('candidate_ready') },
    ]));
    const { result } = renderHook(() => useGitOpsSourceStates());
    await waitFor(() => expect(result.current).toEqual({ bookstack: 'candidate_ready' }));

    apiFetch.mockRejectedValue(new Error('offline'));
    act(() => { announceGitOps(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(300); });

    // Blanking every badge on one failed poll would report "no GitOps here"
    // for stacks GitOps is managing.
    expect(result.current).toEqual({ bookstack: 'candidate_ready' });
  });

  it('drops a slow answer for the node the operator has left', async () => {
    let releaseFirst: (() => void) | null = null;
    apiFetch.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return ok([{ stack_name: 'bookstack', gitopsRevision: sourceRevision('candidate_ready') }]);
    });
    apiFetch.mockResolvedValue(ok([
      { stack_name: 'other', gitopsRevision: sourceRevision('source_review_pending') },
    ]));

    const { result, rerender } = renderHook(() => useGitOpsSourceStates());
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));

    activeNode.current = { id: 2, name: 'Remote' };
    rerender();
    await waitFor(() => expect(result.current).toEqual({ other: 'source_review_pending' }));

    // Stack names repeat across nodes, so node one's answer landing now would
    // label node two's list with node one's state.
    await act(async () => { releaseFirst?.(); await Promise.resolve(); });
    expect(result.current).toEqual({ other: 'source_review_pending' });
  });
});
