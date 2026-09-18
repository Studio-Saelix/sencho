import { RegistryService } from './RegistryService';
import { compareLocalToRemoteTag, listRegistryTagsResult, parseImageRef, type RegistryTransport } from './registry-api';
import { detectImageUpdate, type ImageUpdateDetectResult } from './imageUpdateDetect';
import type { ImageUpdateImageFacts } from './imageUpdateFacts';
import { parsePullReference } from '../helpers/registryPullReference';
import { isAuthorizedTokenDelegation, safeRegistryRequest } from '../helpers/registrySafeProbe';

const IMAGE_DEADLINE_MS = 30_000;
const SOCKET_TIMEOUT_MS = 10_000;

/** Request-scoped adapter: no unsafe transport fallback, including auth and index expansion. */
function probeTransport(registry: string, signal: AbortSignal) {
    let inconclusive = false;
    const registryOrigin = `https://${registry}`;
    const request = async (url: string, method: 'GET' | 'HEAD', headers: Record<string, string>, capBytes = 1024 * 1024) => {
        signal.throwIfAborted();
        try {
            const parsed = new URL(url);
            if (!isAuthorizedTokenDelegation(parsed.origin, registryOrigin)) {
                throw new Error('Registry token delegation is not allowed');
            }
            const result = await safeRegistryRequest(url, method, headers, SOCKET_TIMEOUT_MS, signal, capBytes);
            if (result.status !== 200 && result.status !== 401 && result.status !== 403
                && result.status !== 405 && result.status !== 501) inconclusive = true;
            return result;
        } catch {
            // Do not let shared auth fallback turn a refused or failed hop into
            // authoritative evidence, or include credential-bearing URLs in logs.
            inconclusive = true;
            throw new Error('Safe registry transport failed');
        }
    };
    const transport: RegistryTransport = {
        request: async (url, method, headers) => {
            const result = await request(url, method, headers);
            return { statusCode: result.status, headers: result.headers, body: result.bodyBytes.toString('utf8') };
        },
        getCapped: async (url, headers, capBytes) => {
            const result = await request(url, 'GET', headers, capBytes);
            return { statusCode: result.status, headers: result.headers, bodyBytes: result.bodyBytes, truncated: false };
        },
    };
    return { transport, isInconclusive: () => inconclusive };
}

/** Hub credential authority over target image facts; never consults a local Docker daemon. */
export async function probeRemoteImageUpdate(image: ImageUpdateImageFacts, signal: AbortSignal): Promise<ImageUpdateDetectResult | null> {
    signal.throwIfAborted();
    const pullRef = parsePullReference(image.ref);
    if (!pullRef || pullRef.kind === 'digest' || image.emptyReason === 'not_checkable'
        || image.authority.source === 'target_credential') return null;
    const parsed = parseImageRef(pullRef.value);
    if (!parsed) return null;

    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('Image registry probe deadline exceeded')), IMAGE_DEADLINE_MS);
    let rejectAbort: () => void = () => undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
    });
    const run = async () => {
        const credentials = await RegistryService.getInstance().resolveDockerConfigForHostDetailed(parsed.registry);
        controller.signal.throwIfAborted();
        if (credentials.state === 'unavailable' || (credentials.state === 'available' && !credentials.auth)) return null;
        const safe = probeTransport(parsed.registry, controller.signal);
        const result = await detectImageUpdate({
            ...parsed, localDigests: image.localDigests, platform: image.platform ?? { os: '', architecture: '' },
            credentials: credentials.auth ?? null,
            deps: {
                compareDigest: (digests, registry, repo, tag, platform, auth) =>
                    compareLocalToRemoteTag(digests, registry, repo, tag, platform, auth, safe.transport),
                listRegistryTagsResult: (registry, repo, auth, opts) =>
                    listRegistryTagsResult(registry, repo, auth, opts, safe.transport),
            },
        });
        controller.signal.throwIfAborted();
        return safe.isInconclusive() ? null : result;
    };
    try {
        return await Promise.race([run(), cancelled]);
    } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        console.warn('[RemoteImageUpdateProbe] Registry check failed:', error instanceof Error ? error.name : 'Unknown error');
        return null;
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        controller.signal.removeEventListener('abort', rejectAbort);
    }
}
