import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/ui/toast-store', () => ({
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn(), loading: vi.fn(), dismiss: vi.fn() },
}));

import { apiFetch } from '@/lib/api';
import { toast } from '@/components/ui/toast-store';
import { fetchNodeSettings } from '../fetchNodeSettings';

const mockedFetch = apiFetch as unknown as ReturnType<typeof vi.fn>;
const mockedToast = toast as unknown as { error: ReturnType<typeof vi.fn> };

beforeEach(() => {
    mockedFetch.mockReset();
    mockedToast.error.mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('fetchNodeSettings', () => {
    it('returns settings on success and passes nodeId', async () => {
        const settings = { host_cpu_limit: '80' };
        mockedFetch.mockResolvedValue({ ok: true, json: async () => settings });

        const result = await fetchNodeSettings(7);

        expect(result).toEqual({ ok: true, settings });
        expect(mockedFetch).toHaveBeenCalledWith('/settings', expect.objectContaining({ nodeId: 7 }));
        expect(mockedToast.error).not.toHaveBeenCalled();
    });

    it('treats a successful empty object as success', async () => {
        mockedFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
        const result = await fetchNodeSettings(1);
        expect(result).toEqual({ ok: true, settings: {} });
        expect(mockedToast.error).not.toHaveBeenCalled();
    });

    it('returns ok false without toasting on non-ok response', async () => {
        mockedFetch.mockResolvedValue({ ok: false, status: 502, json: async () => ({}) });
        const result = await fetchNodeSettings(2);
        expect(result).toEqual({ ok: false });
        expect(mockedToast.error).not.toHaveBeenCalled();
    });

    it('returns ok false without toasting when fetch rejects', async () => {
        mockedFetch.mockRejectedValue(new Error('network down'));
        const result = await fetchNodeSettings(null);
        expect(result).toEqual({ ok: false });
        expect(mockedToast.error).not.toHaveBeenCalled();
    });

    it('returns ok false without toasting when JSON parsing fails', async () => {
        mockedFetch.mockResolvedValue({
            ok: true,
            json: async () => {
                throw new SyntaxError('bad json');
            },
        });
        const result = await fetchNodeSettings(3);
        expect(result).toEqual({ ok: false });
        expect(mockedToast.error).not.toHaveBeenCalled();
    });

    it('returns ok false without toast when aborted', async () => {
        const controller = new AbortController();
        mockedFetch.mockImplementation((_url: string, opts?: { signal?: AbortSignal }) => {
            return new Promise((_resolve, reject) => {
                opts?.signal?.addEventListener('abort', () => {
                    reject(new DOMException('Aborted', 'AbortError'));
                });
            });
        });
        const pending = fetchNodeSettings(4, controller.signal);
        controller.abort();
        await expect(pending).resolves.toEqual({ ok: false });
        expect(mockedToast.error).not.toHaveBeenCalled();
    });
});
