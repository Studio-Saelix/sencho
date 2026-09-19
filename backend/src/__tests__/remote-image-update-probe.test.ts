import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import https from 'https';
import type { ClientRequest, IncomingMessage } from 'http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { probeRemoteImageUpdate } from '../services/remoteImageUpdateProbe';
import type { ImageUpdateImageFacts } from '../services/imageUpdateFacts';

const { resolveCredentials } = vi.hoisted(() => ({ resolveCredentials: vi.fn() }));
vi.mock('../services/RegistryService', () => ({
    RegistryService: { getInstance: () => ({ resolveDockerConfigForHostDetailed: resolveCredentials }) },
    normalizeImageHost: (host: string) => host,
}));

const digest = `sha256:${'a'.repeat(64)}`;
const image: ImageUpdateImageFacts = {
    ref: '127.0.0.1/acme/app:stable', localDigests: [digest],
    platform: { os: 'linux', architecture: 'amd64' }, emptyReason: 'none',
    authority: { source: 'unchecked', result: null, observedAt: 1 },
};
interface Reply { status?: number; headers?: Record<string, string>; chunks?: Buffer[]; hold?: boolean }
function transport(reply: (url: string, method: string) => Reply) {
    const calls: { url: string; method: string; headers: https.RequestOptions['headers'] }[] = [];
    const destroyed = vi.fn();
    vi.spyOn(https, 'request').mockImplementation(((raw: string | URL, opts: https.RequestOptions, cb: (res: IncomingMessage) => void) => {
        const url = String(raw);
        calls.push({ url, method: opts.method ?? 'GET', headers: opts.headers });
        const req = new EventEmitter() as ClientRequest;
        req.setTimeout = vi.fn(() => req);
        req.destroy = (error?: Error) => { destroyed(); if (error) req.emit('error', error); return req; };
        req.end = () => {
            const entry = reply(url, opts.method ?? 'GET');
            if (!entry.hold) queueMicrotask(() => {
                const res = new EventEmitter() as IncomingMessage;
                res.statusCode = entry.status ?? 200;
                res.headers = entry.headers ?? {};
                cb(res);
                for (const chunk of entry.chunks ?? []) res.emit('data', chunk);
                res.emit('end');
            });
            return req;
        };
        return req;
    }) as typeof https.request);
    return { calls, destroyed };
}
const ping = { status: 401, headers: { 'www-authenticate': 'Bearer realm="https://127.0.0.1/token",service="registry"' } };
const token = { chunks: [Buffer.from('{"token":"test-token"}')] };

beforeEach(() => {
    vi.stubEnv('SENCHO_E2E_ALLOW_LOOPBACK_OUTBOUND', 'true');
    resolveCredentials.mockReset().mockResolvedValue({ state: 'available', auth: { username: 'fixture', password: 'fixture-password' } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('hub remote image update probe', () => {
    it('reuses manifest comparison with hub credentials', async () => {
        const { calls } = transport(url => url.endsWith('/v2/') ? ping : url.includes('/token?') ? token : {
            headers: { 'docker-content-digest': digest },
        });
        expect(await probeRemoteImageUpdate(image, new AbortController().signal)).toMatchObject({ checkStatus: 'ok', hasUpdate: false });
        expect(resolveCredentials).toHaveBeenCalledWith('127.0.0.1');
        expect(calls.find(call => call.url.includes('/token?'))?.headers).toMatchObject({ Authorization: expect.stringMatching(/^Basic /) });
        expect(calls.find(call => call.method === 'HEAD')?.headers).toMatchObject({ Authorization: 'Bearer test-token' });
    });

    it('does not probe digest-pinned images or target-owned authority', async () => {
        const { calls } = transport(() => ({}));
        expect(await probeRemoteImageUpdate({ ...image, ref: `127.0.0.1/acme/app@${digest}` }, new AbortController().signal)).toBeNull();
        expect(calls).toHaveLength(0);
        expect(resolveCredentials).not.toHaveBeenCalled();
    });

    it('propagates parent cancellation and destroys an active request', async () => {
        const parent = new AbortController();
        const { destroyed, calls } = transport(() => ({ hold: true }));
        const pending = probeRemoteImageUpdate(image, parent.signal);
        const rejected = expect(pending).rejects.toThrow('cancelled');
        await vi.waitFor(() => expect(calls).toHaveLength(1));
        parent.abort(new Error('cancelled'));
        await rejected;
        expect(destroyed).toHaveBeenCalled();
    });

    it('bounds credential lookup by the 30 second per-image deadline', async () => {
        vi.useFakeTimers();
        resolveCredentials.mockReturnValue(new Promise(() => {}));
        const pending = probeRemoteImageUpdate(image, new AbortController().signal);
        const rejected = expect(pending).rejects.toThrow(/deadline/i);
        await vi.advanceTimersByTimeAsync(30_000);
        await rejected;
    });

    it('preserves raw manifest bytes for existing multi-architecture classification', async () => {
        const body = Buffer.from(JSON.stringify({ label: 'café', manifests: [{
            digest, mediaType: 'application/vnd.oci.image.manifest.v1+json', platform: image.platform,
        }] }));
        const index = `sha256:${createHash('sha256').update(body).digest('hex')}`;
        const split = body.indexOf(Buffer.from('é')) + 1;
        const { calls } = transport((url, method) => url.endsWith('/v2/') ? ping : url.includes('/token?') ? token : {
            headers: { 'docker-content-digest': index, 'content-type': 'application/vnd.oci.image.index.v1+json' },
            chunks: method === 'HEAD' ? [] : [body.subarray(0, split), body.subarray(split)],
        });
        expect(await probeRemoteImageUpdate(image, new AbortController().signal)).toMatchObject({ checkStatus: 'ok', digestUpdate: false });
        expect(calls.some(call => call.url.endsWith(`/manifests/${index}`))).toBe(true);
    });
});
