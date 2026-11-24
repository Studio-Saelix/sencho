import type { ImageUpdateAuthority, ImageUpdateDetectWireResult } from './imageUpdateFacts';
import type { ImageUpdateDetectResult } from './imageUpdateDetect';

/** A target's result as a full detection; a target that was not asked for the candidate digest has none. */
function fromWire(result: ImageUpdateDetectWireResult): ImageUpdateDetectResult {
    return { ...result, candidateDigest: result.candidateDigest ?? null };
}

/** Credential ownership takes precedence over result status and remote clocks. */
export function mergeImageUpdateAuthority(
    target: ImageUpdateAuthority,
    safeHubResult: ImageUpdateDetectResult | null,
): ImageUpdateDetectResult | null {
    if (target.source === 'target_credential') return fromWire(target.result);
    if (safeHubResult?.checkStatus === 'ok') return safeHubResult;
    return target.result ? fromWire(target.result) : null;
}
