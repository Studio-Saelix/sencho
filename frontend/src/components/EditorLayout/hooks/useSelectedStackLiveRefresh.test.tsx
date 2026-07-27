import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const visibilityCleanups: Array<() => void> = [];
const visibilityFns: Array<() => void> = [];

vi.mock('@/lib/utils', async () => {
  const actual = await vi.importActual<typeof import('@/lib/utils')>('@/lib/utils');
  return {
    ...actual,
    visibilityInterval: (fn: () => void) => {
      visibilityFns.push(fn);
      const cleanup = () => {
        const idx = visibilityFns.indexOf(fn);
        if (idx >= 0) visibilityFns.splice(idx, 1);
      };
      visibilityCleanups.push(cleanup);
      return cleanup;
    },
  };
});

import {
  useSelectedStackLiveRefresh,
  shouldRefreshForInvalidate,
  parseComposeProjectName,
  containerIdMatches,
  INVALIDATE_DEBOUNCE_MS,
  STALE_FAILURE_THRESHOLD,
  type SoftRefreshOutcome,
} from './useSelectedStackLiveRefresh';
import type { ContainerInfo } from '../EditorView';

function fireInvalidate(detail: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent('sencho:state-invalidate', { detail }));
}

function container(id: string, overrides: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    Id: id,
    Names: [`/${id}`],
    State: 'running',
    healthStatus: 'healthy',
    ...overrides,
  };
}

describe('parseComposeProjectName', () => {
  it('reads top-level name', () => {
    expect(parseComposeProjectName('name: custom-proj\nservices:\n  web:\n    image: nginx\n')).toBe('custom-proj');
  });

  it('returns null when name is absent', () => {
    expect(parseComposeProjectName('services:\n  web:\n    image: nginx\n')).toBeNull();
  });
});

describe('containerIdMatches', () => {
  it('matches short list id against full event id', () => {
    const short = 'abcdef012345';
    const full = `${short}${'f'.repeat(52)}`;
    expect(containerIdMatches(new Set([short]), full)).toBe(true);
    expect(containerIdMatches(new Set([full]), short)).toBe(true);
  });

  it('rejects unrelated ids', () => {
    expect(containerIdMatches(new Set(['abcdef012345']), 'ffffffffffff')).toBe(false);
  });
});

describe('shouldRefreshForInvalidate', () => {
  const base = {
    activeNodeId: 1,
    selectedBasename: 'web',
    composeProjectName: null as string | null,
    learnedAliases: new Set<string>(),
    containerIds: new Set<string>(),
  };

  it('requires scope stack and matching nodeId', () => {
    expect(shouldRefreshForInvalidate({ scope: 'image-updates', nodeId: 1 }, base)).toBe(false);
    expect(shouldRefreshForInvalidate({ scope: 'stack', nodeId: 2 }, base)).toBe(false);
  });

  it('matches basename case-sensitively', () => {
    expect(shouldRefreshForInvalidate({ scope: 'stack', nodeId: 1, stackName: 'web' }, base)).toBe(true);
    expect(shouldRefreshForInvalidate({ scope: 'stack', nodeId: 1, stackName: 'Web' }, base)).toBe(false);
  });

  it('matches compose project name and container ids (including prefix)', () => {
    expect(shouldRefreshForInvalidate(
      { scope: 'stack', nodeId: 1, stackName: 'custom' },
      { ...base, composeProjectName: 'custom' },
    )).toBe(true);
    const short = 'abcdef012345';
    const full = `${short}${'0'.repeat(52)}`;
    expect(shouldRefreshForInvalidate(
      { scope: 'stack', nodeId: 1, stackName: 'other', containerId: full },
      { ...base, containerIds: new Set([short]) },
    )).toBe(true);
  });

  it('falls back when identity is unproven', () => {
    expect(shouldRefreshForInvalidate({ scope: 'stack', nodeId: 1, stackName: null }, base)).toBe(true);
    expect(shouldRefreshForInvalidate({ scope: 'stack', nodeId: 1 }, base)).toBe(true);
  });

  it('ignores other project names', () => {
    expect(shouldRefreshForInvalidate({ scope: 'stack', nodeId: 1, stackName: 'other' }, base)).toBe(false);
  });
});

describe('useSelectedStackLiveRefresh', () => {
  let refreshMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    refreshMock = vi.fn().mockResolvedValue('ok' satisfies SoftRefreshOutcome);
    visibilityFns.length = 0;
    visibilityCleanups.length = 0;
  });

  afterEach(() => {
    for (const c of [...visibilityCleanups]) c();
    visibilityCleanups.length = 0;
    visibilityFns.length = 0;
    vi.useRealTimers();
  });

  function renderLive(overrides: Partial<{
    selectedFile: string | null;
    activeNodeId: number | undefined;
    containers: ContainerInfo[];
    composeContent: string;
    containersLoadStatus: 'idle' | 'loading' | 'success' | 'error';
  }> = {}) {
    return renderHook(
      (props) => useSelectedStackLiveRefresh({
        selectedFile: props.selectedFile,
        activeNodeId: props.activeNodeId,
        containers: props.containers,
        composeContent: props.composeContent,
        containersLoadStatus: props.containersLoadStatus,
        refreshSelectedContainers: refreshMock as (
          n: string,
          f: string,
        ) => Promise<SoftRefreshOutcome>,
      }),
      {
        initialProps: {
          selectedFile: 'web.yml' as string | null,
          activeNodeId: 1 as number | undefined,
          containers: [container('c1')] as ContainerInfo[],
          composeContent: 'services:\n  web:\n    image: nginx\n',
          containersLoadStatus: 'success' as const,
          ...overrides,
        },
      },
    );
  }

  it('debounces a burst of matching invalidates into one soft refresh', async () => {
    renderLive();
    await act(async () => { await Promise.resolve(); });
    refreshMock.mockClear();

    act(() => {
      fireInvalidate({ scope: 'stack', nodeId: 1, stackName: 'web', action: 'health_status' });
      fireInvalidate({ scope: 'stack', nodeId: 1, stackName: 'web', action: 'start' });
      fireInvalidate({ scope: 'stack', nodeId: 1, stackName: 'web', action: 'die' });
    });

    expect(refreshMock).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
      await Promise.resolve();
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(refreshMock).toHaveBeenCalledWith('web', 'web.yml');
  });

  it('ignores event stackName that differs from basename only in case', async () => {
    renderLive();
    await act(async () => { await Promise.resolve(); });
    refreshMock.mockClear();

    act(() => {
      fireInvalidate({ scope: 'stack', nodeId: 1, stackName: 'Web' });
    });
    await act(async () => {
      vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
      await Promise.resolve();
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('queues at most one trailing refresh while in flight', async () => {
    let resolveRefresh: (v: SoftRefreshOutcome) => void = () => {};
    refreshMock.mockImplementation(() => new Promise<SoftRefreshOutcome>((resolve) => {
      resolveRefresh = resolve;
    }));

    renderLive();
    await act(async () => { await Promise.resolve(); });
    refreshMock.mockClear();

    act(() => {
      fireInvalidate({ scope: 'stack', nodeId: 1, stackName: 'web' });
    });
    await act(async () => {
      vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
      await Promise.resolve();
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);

    act(() => {
      fireInvalidate({ scope: 'stack', nodeId: 1, stackName: 'web' });
      fireInvalidate({ scope: 'stack', nodeId: 1, stackName: 'web' });
    });
    await act(async () => {
      vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
      await Promise.resolve();
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRefresh('ok');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(refreshMock).toHaveBeenCalledTimes(2);
  });

  it('poll on visible while debounced invalidate pending collapses via serialization', async () => {
    let resolveRefresh: (v: SoftRefreshOutcome) => void = () => {};
    refreshMock.mockImplementation(() => new Promise<SoftRefreshOutcome>((resolve) => {
      resolveRefresh = resolve;
    }));

    renderLive();
    await act(async () => { await Promise.resolve(); });
    refreshMock.mockClear();

    act(() => {
      fireInvalidate({ scope: 'stack', nodeId: 1, stackName: 'web' });
    });
    expect(visibilityFns.length).toBeGreaterThan(0);
    act(() => {
      visibilityFns[0]();
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
      await Promise.resolve();
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveRefresh('ok');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(refreshMock).toHaveBeenCalledTimes(2);
  });

  it('does not refresh after stack switch mid-flight', async () => {
    let resolveRefresh: (v: SoftRefreshOutcome) => void = () => {};
    refreshMock.mockImplementation(() => new Promise<SoftRefreshOutcome>((resolve) => {
      resolveRefresh = resolve;
    }));

    const { rerender } = renderLive();
    await act(async () => { await Promise.resolve(); });
    refreshMock.mockClear();

    act(() => {
      fireInvalidate({ scope: 'stack', nodeId: 1, stackName: 'web' });
    });
    await act(async () => {
      vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
      await Promise.resolve();
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);

    rerender({
      selectedFile: 'other.yml',
      activeNodeId: 1,
      containers: [],
      composeContent: '',
      containersLoadStatus: 'success',
    });

    await act(async () => {
      resolveRefresh('ok');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('sets syncStale after consecutive soft failures including confirmed-empty', async () => {
    refreshMock.mockResolvedValue('failed');
    const { result, rerender } = renderLive({ containers: [] });
    await act(async () => { await Promise.resolve(); });
    refreshMock.mockClear();

    for (let i = 0; i < STALE_FAILURE_THRESHOLD; i += 1) {
      act(() => {
        fireInvalidate({ scope: 'stack', nodeId: 1, stackName: 'web' });
      });
      await act(async () => {
        vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    expect(refreshMock).toHaveBeenCalledTimes(STALE_FAILURE_THRESHOLD);
    expect(result.current.syncStale).toBe(true);

    rerender({
      selectedFile: 'web.yml',
      activeNodeId: 1,
      containers: [],
      composeContent: '',
      containersLoadStatus: 'error',
    });
    expect(result.current.syncStale).toBe(true);
  });

  it('does not count skipped arbitration outcomes toward syncStale', async () => {
    refreshMock.mockResolvedValue('skipped');
    const { result } = renderLive();
    await act(async () => { await Promise.resolve(); });
    refreshMock.mockClear();

    for (let i = 0; i < STALE_FAILURE_THRESHOLD + 2; i += 1) {
      act(() => {
        fireInvalidate({ scope: 'stack', nodeId: 1, stackName: 'web' });
      });
      await act(async () => {
        vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    expect(result.current.syncStale).toBe(false);
  });

  it('clears syncStale when same-id health fingerprint changes', async () => {
    refreshMock.mockResolvedValue('failed');
    const { result, rerender } = renderLive({
      containers: [container('c1', { healthStatus: 'starting' })],
    });
    await act(async () => { await Promise.resolve(); });

    for (let i = 0; i < STALE_FAILURE_THRESHOLD; i += 1) {
      act(() => {
        fireInvalidate({ scope: 'stack', nodeId: 1, stackName: 'web' });
      });
      await act(async () => {
        vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    expect(result.current.syncStale).toBe(true);

    rerender({
      selectedFile: 'web.yml',
      activeNodeId: 1,
      containers: [container('c1', { healthStatus: 'healthy' })],
      composeContent: 'services:\n  web:\n    image: nginx\n',
      containersLoadStatus: 'success',
    });
    expect(result.current.syncStale).toBe(false);
  });

  it('matches custom compose name: alias', async () => {
    renderLive({
      composeContent: 'name: custom-proj\nservices:\n  web:\n    image: nginx\n',
    });
    await act(async () => { await Promise.resolve(); });
    refreshMock.mockClear();

    act(() => {
      fireInvalidate({ scope: 'stack', nodeId: 1, stackName: 'custom-proj', action: 'health_status' });
    });
    await act(async () => {
      vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
      await Promise.resolve();
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('retrySync clears stale and requests a refresh', async () => {
    refreshMock.mockResolvedValue('failed');
    const { result } = renderLive();
    await act(async () => { await Promise.resolve(); });

    for (let i = 0; i < STALE_FAILURE_THRESHOLD; i += 1) {
      act(() => {
        fireInvalidate({ scope: 'stack', nodeId: 1, stackName: 'web' });
      });
      await act(async () => {
        vi.advanceTimersByTime(INVALIDATE_DEBOUNCE_MS);
        await Promise.resolve();
        await Promise.resolve();
      });
    }
    expect(result.current.syncStale).toBe(true);
    refreshMock.mockClear();
    refreshMock.mockResolvedValue('ok');

    await act(async () => {
      result.current.retrySync();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(refreshMock).toHaveBeenCalledTimes(1);
    expect(result.current.syncStale).toBe(false);
  });
});
