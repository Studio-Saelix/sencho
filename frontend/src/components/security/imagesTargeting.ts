import type { PostureReasonKind, PostureTarget } from '@/types/security';

/** Parent-owned Images drill-down from a posture reason/action. */
export interface ImagesTargetingState {
  kind: PostureReasonKind;
  label: string;
  imageRefs: string[];
  /** Monotonic token so re-navigating the same reason re-applies after Clear. */
  token: number;
}

/** Payload passed into navigate before SecurityView assigns a token. */
export type ImagesTargetingInput = Omit<ImagesTargetingState, 'token'>;

/** Build Images targeting from a posture reason/action target list. */
export function targetingFromTargets(
  kind: PostureReasonKind,
  label: string,
  targets: PostureTarget[] | undefined,
): ImagesTargetingInput | undefined {
  if (!targets || targets.length === 0) return undefined;
  return {
    kind,
    label,
    imageRefs: targets.map((t) => t.imageRef),
  };
}
