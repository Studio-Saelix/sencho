import { apiFetch } from '@/lib/api';

export type FetchNodeSettingsResult =
    | { ok: true; settings: Record<string, string> }
    | { ok: false };

function isAbort(err: unknown, signal?: AbortSignal): boolean {
    return Boolean(signal?.aborted)
        || (err instanceof DOMException && err.name === 'AbortError');
}

/**
 * Load node-scoped settings for an explicitly captured node.
 * Does not toast: callers that own UI generation (useNodeSettingsLoad) decide
 * whether a failure is still current before notifying the operator.
 * Abort returns `{ ok: false }` without logging as a hard failure.
 */
export async function fetchNodeSettings(
    nodeId: number | null,
    signal?: AbortSignal,
): Promise<FetchNodeSettingsResult> {
    try {
        const res = await apiFetch('/settings', { nodeId, signal });
        if (signal?.aborted) return { ok: false };
        if (!res.ok) {
            console.error('Failed to load settings:', res.status);
            return { ok: false };
        }
        const settings = await res.json() as Record<string, string>;
        if (signal?.aborted) return { ok: false };
        return { ok: true, settings };
    } catch (err) {
        if (isAbort(err, signal)) return { ok: false };
        console.error('Failed to load settings:', err);
        return { ok: false };
    }
}
