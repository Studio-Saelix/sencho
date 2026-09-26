export type ComposeDiffActionLabel = 'Save' | 'Save & deploy' | 'Save & reapply' | 'Save & pull images';

/** Maps diff preview mode + self-stack eligibility to the confirm CTA label. */
export function resolveComposeDiffActionLabel(
  mode: 'save' | 'save-and-deploy' | 'save-and-pull-images' | undefined,
  canSaveAndReapply: boolean,
): ComposeDiffActionLabel {
  // Image pull is never reapply: it acquires images and leaves the running
  // workload alone, so it has no self-stack variant to pick between.
  if (mode === 'save-and-pull-images') return 'Save & pull images';
  if (mode !== 'save-and-deploy') return 'Save';
  if (canSaveAndReapply) return 'Save & reapply';
  return 'Save & deploy';
}
