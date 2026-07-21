/**
 * Toast ownership and generation guards for useNodeSettingsLoad.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

const fetchNodeSettingsMock = vi.fn();
vi.mock('../fetchNodeSettings', () => ({
    fetchNodeSettings: (...args: unknown[]) => fetchNodeSettingsMock(...args),
}));

import { toast } from '@/components/ui/toast-store';
import { useNodeSettingsLoad } from '../useNodeSettingsLoad';

const mockedToast = toast as unknown as { error: ReturnType<typeof vi.fn> };

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

beforeEach(() => {
    fetchNodeSettingsMock.mockReset();
    mockedToast.error.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('useNodeSettingsLoad toast ownership', () => {
    it('toasts once on a current non-OK load failure', async () => {
        fetchNodeSettingsMock.mockResolvedValue({ ok: false });
        const { result } = renderHook(() => useNodeSettingsLoad(1));

        const settings = await act(() => result.current.load());

        expect(settings).toBeNull();
        expect(result.current.phase).toBe('error');
        expect(mockedToast.error).toHaveBeenCalledTimes(1);
        expect(mockedToast.error).toHaveBeenCalledWith('Failed to load settings.');
    });

    it('does not toast when a newer load supersedes a failing one', async () => {
        const first = deferred<unknown>();
        let call = 0;
        fetchNodeSettingsMock.mockImplementation(() => {
            call += 1;
            if (call === 1) return first.promise;
            return Promise.resolve({ ok: true, settings: { developer_mode: '0' } });
        });

        const { result } = renderHook(() => useNodeSettingsLoad(1));

        let firstPromise: Promise<Record<string, string> | null>;
        act(() => {
            firstPromise = result.current.load();
        });

        await act(async () => {
            await result.current.load();
        });

        mockedToast.error.mockClear();
        await act(async () => {
            first.resolve({ ok: false });
            await firstPromise!;
        });

        expect(mockedToast.error).not.toHaveBeenCalled();
        expect(result.current.phase).toBe('ready');
    });

    it('does not toast when the current load was aborted', async () => {
        fetchNodeSettingsMock.mockImplementation((_nodeId: number | null, signal: AbortSignal) => {
            return new Promise((resolve) => {
                const finish = () => resolve({ ok: false });
                if (signal.aborted) {
                    finish();
                    return;
                }
                signal.addEventListener('abort', finish, { once: true });
            });
        });

        const { result, unmount } = renderHook(() => useNodeSettingsLoad(1));

        let loadPromise: Promise<Record<string, string> | null>;
        act(() => {
            loadPromise = result.current.load();
        });

        unmount();
        await act(async () => {
            await loadPromise!;
        });

        expect(mockedToast.error).not.toHaveBeenCalled();
    });

    it('does not toast when a stale failure settles after a node switch', async () => {
        const loadA = deferred<unknown>();
        fetchNodeSettingsMock.mockImplementation((nodeId: number | null) => {
            if (nodeId === 1) return loadA.promise;
            return Promise.resolve({ ok: true, settings: {} });
        });

        const { result, rerender } = renderHook(
            ({ id }: { id: number | undefined }) => useNodeSettingsLoad(id),
            { initialProps: { id: 1 as number | undefined } },
        );

        let promiseA: Promise<Record<string, string> | null>;
        act(() => {
            promiseA = result.current.load();
        });

        rerender({ id: 2 });
        await act(async () => {
            await result.current.load();
        });

        mockedToast.error.mockClear();
        await act(async () => {
            loadA.resolve({ ok: false });
            await promiseA!;
        });

        expect(mockedToast.error).not.toHaveBeenCalled();
        await waitFor(() => expect(result.current.phase).toBe('ready'));
    });

    it('does not fetch or toast while the active node id is still undefined', async () => {
        const { result } = renderHook(() => useNodeSettingsLoad(undefined));

        const settings = await act(() => result.current.load());

        expect(settings).toBeNull();
        expect(result.current.phase).toBe('loading');
        expect(fetchNodeSettingsMock).not.toHaveBeenCalled();
        expect(mockedToast.error).not.toHaveBeenCalled();
    });

    it('toasts only once when bootstrap settles from undefined to a failing node', async () => {
        fetchNodeSettingsMock.mockResolvedValue({ ok: false });
        const { result, rerender } = renderHook(
            ({ id }: { id: number | undefined }) => useNodeSettingsLoad(id),
            { initialProps: { id: undefined as number | undefined } },
        );

        await act(async () => {
            await result.current.load();
        });
        expect(fetchNodeSettingsMock).not.toHaveBeenCalled();
        expect(mockedToast.error).not.toHaveBeenCalled();

        rerender({ id: 1 });
        await act(async () => {
            await result.current.load();
        });

        expect(fetchNodeSettingsMock).toHaveBeenCalledTimes(1);
        expect(mockedToast.error).toHaveBeenCalledTimes(1);
        expect(mockedToast.error).toHaveBeenCalledWith('Failed to load settings.');
        expect(result.current.phase).toBe('error');
    });
});
