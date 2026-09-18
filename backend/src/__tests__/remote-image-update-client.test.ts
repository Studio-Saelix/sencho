import { beforeEach, expect, it, vi } from 'vitest';
import { Response } from 'undici';
import { fetchRemoteImageUpdateFacts, fetchRemoteImageUpdateRoster } from '../services/remoteImageUpdateClient';
import { safeRemoteFetch } from '../utils/outboundTarget';

vi.mock('../utils/outboundTarget', () => ({ safeRemoteFetch: vi.fn() }));
vi.mock('../services/NodeRegistry', () => ({
    NodeRegistry: { getInstance: () => ({ getProxyTarget: () => ({ apiUrl: 'https://node.example', apiToken: 'fixture', trustedLoopback: false }) }) },
}));
const nonce = 'a'.repeat(32);
vi.mock('crypto', () => ({ randomBytes: () => ({ toString: () => 'a'.repeat(32) }) }));

beforeEach(() => vi.resetAllMocks());

it('fetches the machine roster with a fresh nonce and validates the echoed binding', async () => {
    vi.mocked(safeRemoteFetch).mockResolvedValue(new Response(JSON.stringify({ contractVersion: 1, requestNonce: nonce, stacks: ['web'] })));
    const signal = new AbortController().signal;
    expect(await fetchRemoteImageUpdateRoster(2, signal)).toEqual(['web']);
    expect(safeRemoteFetch).toHaveBeenCalledWith('https://node.example/api/image-updates/inspect-facts', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture' },
        body: JSON.stringify({ contractVersion: 1, requestNonce: nonce, roster: true }), signal,
    }, false);
});

it('rejects a mismatched nonce instead of accepting stale facts', async () => {
    vi.mocked(safeRemoteFetch).mockResolvedValue(new Response(JSON.stringify({ contractVersion: 1, requestNonce: 'b'.repeat(32), stacks: [] })));
    await expect(fetchRemoteImageUpdateFacts(2, 'web', new AbortController().signal)).rejects.toThrow('Invalid remote image facts');
});

it('bounds received bytes even without a content-length header', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(600_000)); }, cancel,
    });
    vi.mocked(safeRemoteFetch).mockResolvedValue(new Response(stream));
    await expect(fetchRemoteImageUpdateRoster(2, new AbortController().signal)).rejects.toThrow('Remote image facts exceed response limit');
    expect(cancel).toHaveBeenCalledTimes(1);
});

it('rejects non-success responses without exposing their body', async () => {
    vi.mocked(safeRemoteFetch).mockResolvedValue(new Response('private diagnostic', { status: 503 }));
    await expect(fetchRemoteImageUpdateRoster(2, new AbortController().signal)).rejects.toThrow('Remote image facts request failed (503)');
});

it('does not contact a target after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(fetchRemoteImageUpdateRoster(2, controller.signal)).rejects.toThrow();
    expect(safeRemoteFetch).not.toHaveBeenCalled();
});
