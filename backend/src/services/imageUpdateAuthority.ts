import type { ImageUpdateAuthority } from './imageUpdateFacts';
import type { ImageUpdateDetectResult } from './imageUpdateDetect';

/** Credential ownership takes precedence over result status and remote clocks. */
export function mergeImageUpdateAuthority(
    target: ImageUpdateAuthority,
    safeHubResult: ImageUpdateDetectResult | null,
): ImageUpdateDetectResult | null {
    if (target.source === 'target_credential') return target.result;
    if (safeHubResult?.checkStatus === 'ok') return safeHubResult;
    return target.result;
}
