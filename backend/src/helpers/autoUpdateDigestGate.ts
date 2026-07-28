import type { ImageCheckResult } from '../services/ImageUpdateService';

/** Accumulator for auto-update image checks (digest vs tag-only vs error). */
export interface AutoUpdateDigestGateState {
  hasDigestUpdate: boolean;
  hasTagOnlyUpdate: boolean;
  updatedImages: string[];
  checkErrors: string[];
}

export function createAutoUpdateDigestGateState(): AutoUpdateDigestGateState {
  return {
    hasDigestUpdate: false,
    hasTagOnlyUpdate: false,
    updatedImages: [],
    checkErrors: [],
  };
}

/**
 * Record one image check into the digest gate. Only digest drift is Compose-
 * actionable for auto-update; tag bumps stay advisory.
 */
export function recordAutoUpdateImageCheck(
  state: AutoUpdateDigestGateState,
  imageRef: string,
  result: ImageCheckResult,
): void {
  if (result.digestUpdate) {
    state.hasDigestUpdate = true;
    state.updatedImages.push(imageRef);
    return;
  }
  if (result.tagUpdate) {
    state.hasTagOnlyUpdate = true;
    return;
  }
  if (result.error || result.checkStatus === 'failed' || result.checkStatus === 'partial') {
    state.checkErrors.push(result.error ?? 'Update check incomplete');
  }
}

/**
 * Operator message when a sibling image check failed and a full-stack Compose
 * update must not run (it would pull/recreate the unverified image as
 * collateral). Null when digest apply may proceed.
 */
export function messageWhenDigestApplyBlockedByCheckErrors(
  stackName: string,
  state: Pick<AutoUpdateDigestGateState, 'hasDigestUpdate' | 'checkErrors'>,
): string | null {
  if (!state.hasDigestUpdate || state.checkErrors.length === 0) return null;
  return `Stack "${stackName}": WARNING - digest update available but ${state.checkErrors.length} image check(s) failed; skipped auto-update (${state.checkErrors.join('; ')}).`;
}

/** Operator message when no digest-actionable update was found. */
export function messageWhenNoDigestUpdate(
  stackName: string,
  state: Pick<AutoUpdateDigestGateState, 'hasTagOnlyUpdate' | 'checkErrors'>,
  imageRefCount: number,
): string {
  if (state.hasTagOnlyUpdate) {
    const errNote = state.checkErrors.length > 0
      ? ` (${state.checkErrors.length} check(s) failed)`
      : '';
    return `Stack "${stackName}": newer tag available but Compose pin unchanged; skipped auto-update${errNote}.`;
  }
  if (state.checkErrors.length > 0 && state.checkErrors.length === imageRefCount) {
    return `Stack "${stackName}": WARNING - all image checks failed (${state.checkErrors.join('; ')}). Unable to determine update status.`;
  }
  if (state.checkErrors.length > 0) {
    return `Stack "${stackName}": all reachable images up to date (${state.checkErrors.length} check(s) failed).`;
  }
  return `Stack "${stackName}": all images up to date.`;
}
