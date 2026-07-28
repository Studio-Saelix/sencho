export type ComposeDiffActionLabel = 'Save' | 'Save & deploy' | 'Save & reapply';

/** Maps diff preview mode + self-stack eligibility to the confirm CTA label. */
export function resolveComposeDiffActionLabel(
  mode: 'save' | 'save-and-deploy' | undefined,
  canSaveAndReapply: boolean,
): ComposeDiffActionLabel {
  if (mode !== 'save-and-deploy') return 'Save';
  if (canSaveAndReapply) return 'Save & reapply';
  return 'Save & deploy';
}
