import { randomBytes } from 'crypto';
import { NodeRegistry } from './NodeRegistry';
import { safeRemoteFetch } from '../utils/outboundTarget';
import { IMAGE_UPDATE_FACTS_BYTE_LIMIT, type ImageUpdateStackFacts } from './imageUpdateFacts';
import { parseRemoteImageUpdateFacts, parseRemoteImageUpdateRoster } from './remoteImageUpdateFacts';

async function readFactsBody(response: Awaited<ReturnType<typeof safeRemoteFetch>>): Promise<unknown> {
    if (!response.body) throw new Error('Remote image facts response is empty');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > IMAGE_UPDATE_FACTS_BYTE_LIMIT) {
                await reader.cancel();
                throw new Error('Remote image facts exceed response limit');
            }
            chunks.push(chunk.value);
        }
    } finally {
        reader.releaseLock();
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

async function requestFacts(nodeId: number, selection: { stack: string } | { roster: true }, signal: AbortSignal) {
    signal.throwIfAborted();
    const target = NodeRegistry.getInstance().getProxyTarget(nodeId);
    if (!target) throw new Error('Remote target is unavailable');
    const nonce = randomBytes(16).toString('hex');
    const response = await safeRemoteFetch(`${target.apiUrl.replace(/\/$/, '')}/api/image-updates/inspect-facts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.apiToken}` },
        body: JSON.stringify({ contractVersion: 1, requestNonce: nonce, ...selection }), signal,
    }, target.trustedLoopback);
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Remote image facts request failed (${response.status})`);
    }
    const value = await readFactsBody(response);
    signal.throwIfAborted();
    return { nonce, value };
}

export async function fetchRemoteImageUpdateFacts(nodeId: number, stack: string, signal: AbortSignal): Promise<ImageUpdateStackFacts> {
    const { nonce, value } = await requestFacts(nodeId, { stack }, signal);
    return parseRemoteImageUpdateFacts(value, nonce, stack).stacks[0];
}

export async function fetchRemoteImageUpdateRoster(nodeId: number, signal: AbortSignal): Promise<string[]> {
    const { nonce, value } = await requestFacts(nodeId, { roster: true }, signal);
    return parseRemoteImageUpdateRoster(value, nonce);
}
