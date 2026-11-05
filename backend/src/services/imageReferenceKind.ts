/**
 * How an authored image reference behaves: a moving tag, a digest pin, or
 * nothing at all.
 *
 * Its own leaf module because the two readers that need it sit on opposite sides
 * of the Compose project context: digest-snapshot capture imports the context
 * itself, while the deploy gate's candidate resolver must not pull that whole
 * graph in just to answer a regex question.
 */
export type ImageReferenceKind = 'moving_tag' | 'digest_pinned' | 'none';

const DIGEST_PIN_PATTERN = /@sha256:[a-f0-9]{64}$/i;

export function classifyReferenceKind(declaredImageRef: string | null): ImageReferenceKind {
  if (!declaredImageRef) return 'none';
  if (DIGEST_PIN_PATTERN.test(declaredImageRef)) return 'digest_pinned';
  return 'moving_tag';
}
