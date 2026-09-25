/**
 * The application view's data contract: the id is encoded into one hub-local
 * read, a failed refresh keeps the last state flagged stale, an application
 * that stops being readable leaves the view rather than lingering, and a
 * gitops invalidation refetches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/api';
import { useGitOpsApplication } from './useGitOpsApplication';
import { detailResponse } from './applicationFixtures';
import { liveArtifact, liveRevision } from '@/__tests__/gitopsFixtures';
import type { GitOpsPortfolioDetailResponse } from '@/types/gitopsPortfolio';
import type { ArtifactFacet } from '@/types/gitops';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function fail(status: number, error: string): Response {
  return { ok: false, status, json: async () => ({ error }) } as unknown as Response;
}

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useGitOpsApplication', () => {
  it('reads the encoded id from the hub, never through the node proxy', async () => {
    mockFetch.mockResolvedValueOnce(ok(detailResponse()));
    const { result } = renderHook(() => useGitOpsApplication('1:app-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockFetch).toHaveBeenCalledWith('/gitops/applications/1%3Aapp-1', { localOnly: true });
    expect(result.current.data?.application.name).toBe('bookstack');
    expect(result.current.error).toBeNull();
  });

  it.each([404, 403])('reports %i as not readable, without distinguishing absent from forbidden', async (status) => {
    mockFetch.mockResolvedValueOnce(fail(status, 'Application not found'));
    const { result } = renderHook(() => useGitOpsApplication('1:gone'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toEqual({ kind: 'not_readable' });
    expect(result.current.data).toBeNull();
  });

  it('reports a malformed id as an invalid link, not as a missing application', async () => {
    mockFetch.mockResolvedValueOnce(fail(400, 'Application id is not a portfolio id'));
    const { result } = renderHook(() => useGitOpsApplication('nonsense'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toEqual({ kind: 'invalid_link' });
  });

  it('tells a node too old to answer apart from a node that did not answer', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 502, json: async () => ({ error: 'Owning node cannot answer GitOps portfolio reads', code: 'node_unsupported' }),
    } as unknown as Response);
    const { result } = renderHook(() => useGitOpsApplication('2:app'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toEqual({ kind: 'unsupported', message: 'Owning node cannot answer GitOps portfolio reads' });
  });

  it('reports a 502 without the unsupported code as unreachable', async () => {
    mockFetch.mockResolvedValueOnce(fail(502, 'Bad Gateway'));
    const { result } = renderHook(() => useGitOpsApplication('2:app'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toEqual({ kind: 'unreachable', message: 'Bad Gateway' });
  });

  it('reports a matched application without usable evidence separately from an unreachable node', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 503, json: async () => ({ error: 'no usable evidence', code: 'evidence_unavailable' }),
    } as unknown as Response);
    const { result } = renderHook(() => useGitOpsApplication('2:app'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toEqual({ kind: 'evidence_unavailable', message: 'no usable evidence' });
    expect(result.current.data).toBeNull();
  });

  it.each([
    ['application targets', (body: GitOpsPortfolioDetailResponse) => ({ ...body, application: { ...body.application, targets: null } })],
    ['application attention', (body: GitOpsPortfolioDetailResponse) => ({ ...body, application: { ...body.application, attention: 'x' } })],
    ['application evidence', (body: GitOpsPortfolioDetailResponse) => ({ ...body, application: { ...body.application, evidence: null } })],
    ['generated timestamp', (body: GitOpsPortfolioDetailResponse) => ({ ...body, generatedAt: undefined })],
    ['projection schema version', (body: GitOpsPortfolioDetailResponse) => ({ ...body, projection: { ...body.projection, schemaVersion: 2 } })],
    ['projection limitations', (body: GitOpsPortfolioDetailResponse) => ({ ...body, projection: { ...body.projection, limitations: null } })],
    ['projection facets', (body: GitOpsPortfolioDetailResponse) => ({ ...body, projection: { ...body.projection, facets: null } })],
    ['projection source status', (body: GitOpsPortfolioDetailResponse) => {
      if (body.projection.targetMode === 'not_applicable') throw new Error('fixture must be live');
      return {
        ...body,
        projection: {
          ...body.projection,
          facets: {
            ...body.projection.facets,
            source: { ...body.projection.facets.source, status: 'source_failed' },
          },
        },
      };
    }],
    ['projection targets', (body: GitOpsPortfolioDetailResponse) => ({ ...body, projection: { ...body.projection, targets: null } })],
    ['projection drift', (body: GitOpsPortfolioDetailResponse) => ({ ...body, projection: { ...body.projection, drift: null } })],
    ['projection drift item', (body: GitOpsPortfolioDetailResponse) => ({
      ...body,
      projection: {
        ...body.projection,
        drift: [{
          class: 'runtime',
          observed: { kind: 'unknown' },
          freshnessAt: null,
          owner: 'operator',
          reason: 'missing expected identity',
          configuredPolicy: null,
          affectedTargets: [],
          action: 'none',
        }],
      },
    })],
    ['absent projection approvals', (body: GitOpsPortfolioDetailResponse) => ({
      ...body,
      projection: {
        ...body.projection,
        targetMode: 'not_applicable',
        applicationId: null,
        facets: null,
        targets: [],
        drift: [],
        limitations: [],
        availableActions: [],
        approvals: {},
      },
    })],
    ['target observed artifact identity', (body: GitOpsPortfolioDetailResponse) => ({
      ...body,
      projection: {
        ...body.projection,
        targets: body.projection.targets.map(target => ({
          ...target,
          observedArtifactIdentity: { kind: 'exact' },
        })),
      },
    })],
    ['rollback candidates', (body: GitOpsPortfolioDetailResponse) => ({ ...body, rollbackCandidates: {} })],
  ])('rejects a successful answer with malformed %s', async (_label, mutate) => {
    mockFetch.mockResolvedValueOnce(ok(mutate(detailResponse())));
    const { result } = renderHook(() => useGitOpsApplication('1:app-1'));
    await waitFor(() => expect(result.current.error?.kind).toBe('failed'));
    expect(result.current.data).toBeNull();
  });

  it('rejects a successful answer for another application', async () => {
    mockFetch.mockResolvedValueOnce(ok(detailResponse({ id: '1:other' })));
    const { result } = renderHook(() => useGitOpsApplication('1:app-1'));
    await waitFor(() => expect(result.current.error?.kind).toBe('failed'));
    expect(result.current.data).toBeNull();
  });

  it('keeps a future observed artifact kind readable for the renderer fallback', async () => {
    const base = detailResponse();
    const body = {
      ...base,
      projection: {
        ...base.projection,
        targets: base.projection.targets.map(target => ({
          ...target,
          observedArtifactIdentity: { kind: 'future_kind' },
        })),
      },
    };
    mockFetch.mockResolvedValueOnce(ok(body));
    const { result } = renderHook(() => useGitOpsApplication('1:app-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.data).not.toBeNull();
  });

  it('rejects an exact claim whose expected identity disagrees with the latest evidence', async () => {
    const base = liveRevision();
    const projection = liveRevision({
      facets: {
        ...base.facets,
        artifact: liveArtifact({
          expected: {
            artifactSetId: 'art-1',
            evidenceVersion: 1,
            qualification: 'exact',
            identity: 'sha256:something-else',
          },
        }),
      },
    });
    mockFetch.mockResolvedValueOnce(ok(detailResponse(undefined, projection)));
    const { result } = renderHook(() => useGitOpsApplication('1:app-1'));
    await waitFor(() => expect(result.current.error?.kind).toBe('failed'));
    expect(result.current.data).toBeNull();
  });

  it('accepts an artifact verdict and qualification this build does not know', async () => {
    const base = liveRevision();
    const future = {
      status: 'artifact_future_verdict',
      artifactSetId: 'art-1',
      generationId: 'gen-accepted',
      evidenceVersion: 1,
      qualification: 'future_qualification',
      freshnessAt: 1,
      expected: null,
      latestEvidence: {
        artifactSetId: 'art-1',
        evidenceVersion: 1,
        qualification: 'future_qualification',
        identity: 'sha256:future',
      },
    };
    const projection = liveRevision({
      facets: { ...base.facets, artifact: future as unknown as ArtifactFacet },
    });
    mockFetch.mockResolvedValueOnce(ok(detailResponse(undefined, projection)));
    const { result } = renderHook(() => useGitOpsApplication('1:app-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.data).not.toBeNull();
  });

  it('accepts a canonical rollout authorization binding', async () => {
    const base = liveRevision();
    const projection = liveRevision({
      targetMode: 'blueprint',
      applicationId: 'app-bp',
      blueprintId: 3,
      facets: {
        ...base.facets,
        placement: {
          status: 'rollout_authorization_pending',
          rolloutAuthorizationRef: null,
          binding: {
            rolloutCandidateId: 'candidate-1',
            acceptedGenerationId: 'generation-1',
            artifactSetId: 'artifact-1',
            intentRevisionId: 'intent-1',
            requiredNodeIds: [1],
            sourceAcceptanceRef: 'source-1',
            placementApprovalRef: 'placement-1',
            preflightFingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          },
        },
      },
    });
    const body = {
      ...detailResponse({ id: 'bp:3', targetMode: 'blueprint', blueprintId: 3, nodeId: null }, projection),
      blueprintEnabled: true,
    };
    mockFetch.mockResolvedValueOnce(ok(body));
    const { result } = renderHook(() => useGitOpsApplication('bp:3'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.data).not.toBeNull();
  });

  it('accepts an inline Blueprint identity without requiring a Git-managed enabled flag', async () => {
    const projection = liveRevision({ targetMode: 'inline_blueprint', applicationId: 'app-inline', blueprintId: 3, stackName: null });
    const body = detailResponse(
      { id: 'bp:3', targetMode: 'inline_blueprint', blueprintId: 3, nodeId: null, stackName: null },
      projection,
    );
    mockFetch.mockResolvedValueOnce(ok(body));
    const { result } = renderHook(() => useGitOpsApplication('bp:3'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.data).not.toBeNull();
  });

  it('accepts a node-scoped remote Blueprint identity', async () => {
    const projection = liveRevision({ targetMode: 'blueprint', applicationId: 'app-remote-bp', blueprintId: 3, stackName: null });
    const body = {
      ...detailResponse(
        { id: '2:app-remote-bp', targetMode: 'blueprint', blueprintId: 3, nodeId: 2, stackName: null },
        projection,
      ),
      blueprintEnabled: true,
    };
    mockFetch.mockResolvedValueOnce(ok(body));
    const { result } = renderHook(() => useGitOpsApplication('2:app-remote-bp'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.data).not.toBeNull();
  });

  it('reports a server failure and a thrown first load as failed, with no data', async () => {
    mockFetch.mockResolvedValueOnce(fail(500, 'boom'));
    const first = renderHook(() => useGitOpsApplication('1:a'));
    await waitFor(() => expect(first.result.current.error).toEqual({ kind: 'failed', message: 'boom' }));

    mockFetch.mockRejectedValueOnce(new Error('network down'));
    const second = renderHook(() => useGitOpsApplication('1:b'));
    await waitFor(() => expect(second.result.current.error).toEqual({ kind: 'failed', message: 'network down' }));
    expect(second.result.current.data).toBeNull();
  });

  it('rejects a successful answer it cannot read instead of rendering a blank view', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ schemaVersion: 2 }) } as unknown as Response);
    const { result } = renderHook(() => useGitOpsApplication('1:a'));
    await waitFor(() => expect(result.current.error?.kind).toBe('failed'));
    expect(result.current.data).toBeNull();
  });

  it('never lets a slow earlier answer overwrite a newer one', async () => {
    let resolveFirst: (r: Response) => void = () => {};
    mockFetch.mockReturnValueOnce(new Promise<Response>(resolve => { resolveFirst = resolve; }));
    const { result } = renderHook(() => useGitOpsApplication('1:app-1'));

    mockFetch.mockResolvedValueOnce(ok(detailResponse({ name: 'new' })));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.data?.application.name).toBe('new'));

    await act(async () => resolveFirst(ok(detailResponse({ name: 'old' }))));
    expect(result.current.data?.application.name).toBe('new');
  });

  it('reports an unreachable owning node as unreachable, with the server message', async () => {
    mockFetch.mockResolvedValueOnce(fail(503, 'Owning node is unreachable'));
    const { result } = renderHook(() => useGitOpsApplication('2:app'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toEqual({ kind: 'unreachable', message: 'Owning node is unreachable' });
  });

  it('keeps the last state and flags it stale when a refresh fails', async () => {
    mockFetch.mockResolvedValueOnce(ok(detailResponse()));
    const { result } = renderHook(() => useGitOpsApplication('1:app-1'));
    await waitFor(() => expect(result.current.data).not.toBeNull());

    mockFetch.mockRejectedValueOnce(new Error('network down'));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.staleSince).not.toBeNull());
    expect(result.current.data?.application.id).toBe('1:app-1');
    expect(result.current.error).toBeNull();
  });

  it('drops the state when a refresh says the application is no longer readable', async () => {
    mockFetch.mockResolvedValueOnce(ok(detailResponse()));
    const { result } = renderHook(() => useGitOpsApplication('1:app-1'));
    await waitFor(() => expect(result.current.data).not.toBeNull());

    mockFetch.mockResolvedValueOnce(fail(404, 'Application not found'));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.error).toEqual({ kind: 'not_readable' }));
    expect(result.current.data).toBeNull();
    expect(result.current.staleSince).toBeNull();
  });

  it('refetches on a gitops invalidation and ignores other scopes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetch.mockResolvedValue(ok(detailResponse()));
    const { result } = renderHook(() => useGitOpsApplication('1:app-1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'stacks' } }));
      vi.advanceTimersByTime(300);
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'gitops' } }));
      window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail: { scope: 'gitops' } }));
      vi.advanceTimersByTime(300);
    });
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2));
  });
});
