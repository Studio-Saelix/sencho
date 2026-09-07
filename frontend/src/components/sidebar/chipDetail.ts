import type { BuildInfo } from '@/context/BuildInfoProvider';

/** Detail shown under the DEV/PREVIEW chip, or the truthful Unknown / Restricted
 *  states when the running reference is unavailable or redacted for this user. */
export function chipDetail(buildInfo: BuildInfo | null | undefined): string {
  if (buildInfo?.restricted) return 'Restricted';
  if (buildInfo?.imageRef) {
    return buildInfo.revision ? `${buildInfo.imageRef} · ${buildInfo.revision}` : buildInfo.imageRef;
  }
  return 'Unknown';
}