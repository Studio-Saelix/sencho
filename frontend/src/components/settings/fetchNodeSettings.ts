import { apiFetch } from '@/lib/api';

export type FetchNodeSettingsResult =
    | { ok: true; settings: Record<string, string> }
    | { ok: false };

function isAbort(err: unknown, signal?: AbortSignal): boolean {
    return Boolean(signal?.aborted)
        || (err instanceof DOMException && err.name === 'AbortError');
}

/** Authoritative /settings bodies are plain objects; null and arrays must not seed defaults. */
export function isSettingsRecord(value: unknown): value is Record<string, string> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
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
        const body: unknown = await res.json();
        if (signal?.aborted) return { ok: false };
        if (!isSettingsRecord(body)) {
            console.error('Failed to load settings: malformed body');
            return { ok: false };
        }
        return { ok: true, settings: body };
    } catch (err) {
        if (isAbort(err, signal)) return { ok: false };
        console.error('Failed to load settings:', err);
        return { ok: false };
    }
}
