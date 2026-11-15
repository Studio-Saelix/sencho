/**
 * The client half of the reveal contract: a grant is minted for one key and
 * version, then exchanged exactly once. The component test mocks this seam, so
 * the two-step exchange is pinned here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api', () => ({ apiFetch: vi.fn() }));

import { apiFetch } from '../api';
import { revealValue, patchSecret, getSecret, replaceSecret } from '../secretsApi';

function jsonResponse(body: unknown, status = 200): Response {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
    } as Response;
}

beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
});

afterEach(() => {
    vi.clearAllMocks();
});

describe('revealValue', () => {
    it('mints a grant for the key and version, then exchanges that grant once', async () => {
        vi.mocked(apiFetch)
            .mockResolvedValueOnce(jsonResponse({ grantId: 'grant-abc', key: 'API_KEY', version: 4, expiresAt: 1_000 }))
            .mockResolvedValueOnce(jsonResponse({ key: 'API_KEY', version: 4, value: 'sk-live', expiresAt: 1_000 }));

        const revealed = await revealValue(7, 'API_KEY', 4);

        expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(2);
        const [grantPath, grantInit] = vi.mocked(apiFetch).mock.calls[0];
        expect(grantPath).toBe('/secrets/7/reveal-grant');
        expect(grantInit?.method).toBe('POST');
        expect(JSON.parse(String(grantInit?.body))).toEqual({ key: 'API_KEY', version: 4 });
        expect(grantInit?.localOnly).toBe(true);

        const [revealPath, revealInit] = vi.mocked(apiFetch).mock.calls[1];
        expect(revealPath).toBe('/secrets/7/reveal');
        expect(JSON.parse(String(revealInit?.body))).toEqual({ grantId: 'grant-abc' });
        expect(revealInit?.localOnly).toBe(true);

        expect(revealed).toEqual({ key: 'API_KEY', version: 4, value: 'sk-live', expiresAt: 1_000 });
    });

    it('asks for the current version when none is named', async () => {
        vi.mocked(apiFetch)
            .mockResolvedValueOnce(jsonResponse({ grantId: 'grant-abc', key: 'API_KEY', version: 2, expiresAt: 1_000 }))
            .mockResolvedValueOnce(jsonResponse({ key: 'API_KEY', version: 2, value: 'v', expiresAt: 1_000 }));

        await revealValue(7, 'API_KEY');
        const body = JSON.parse(String(vi.mocked(apiFetch).mock.calls[0][1]?.body));
        expect(body).toEqual({ key: 'API_KEY' });
    });

    it('does not exchange a grant when minting fails', async () => {
        vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse({ error: 'Key NOPE is not in version 4', code: 'REVEAL_TARGET_MISSING' }, 404));

        await expect(revealValue(7, 'NOPE', 4)).rejects.toMatchObject({
            message: 'Key NOPE is not in version 4',
            status: 404,
            code: 'REVEAL_TARGET_MISSING',
        });
        expect(vi.mocked(apiFetch)).toHaveBeenCalledTimes(1);
    });
});

describe('replaceSecret', () => {
    it('posts the complete recovery payload to the replace route', async () => {
        vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse({ version: 4 }));

        const result = await replaceSecret(7, { expectedVersion: 3, kv: { RECOVERED: 'value' }, note: 'recover' });

        const [path, init] = vi.mocked(apiFetch).mock.calls[0];
        expect(path).toBe('/secrets/7/replace');
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ expectedVersion: 3, kv: { RECOVERED: 'value' }, note: 'recover' });
        expect(init?.localOnly).toBe(true);
        expect(result).toEqual({ version: 4 });
    });
});

describe('error surface', () => {
    it('carries the machine code a route answered with', async () => {
        vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse(
            { error: 'This bundle changed since you opened it.', code: 'VERSION_CONFLICT', currentVersion: 5 },
            409,
        ));

        await expect(patchSecret(7, { expectedVersion: 4, ops: [{ op: 'set', key: 'A', value: 'b' }] }))
            .rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    });

    it('leaves the code undefined when the route sent none', async () => {
        vi.mocked(apiFetch).mockResolvedValueOnce(jsonResponse({ error: 'Failed to load secret' }, 500));

        let caught: unknown;
        try {
            await getSecret(7);
        } catch (e) {
            caught = e;
        }
        expect(caught).toMatchObject({ status: 500 });
        expect((caught as { code?: string }).code).toBeUndefined();
    });
});
