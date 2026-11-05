/**
 * Map a registry resolver's free-text failure reason to the shared artifact
 * failure vocabulary.
 *
 * Its own module, beside the resolver rather than inside it, because the deploy
 * gate reads it and must not import the GitOps resolution graph (which reaches
 * the Compose project context) just to classify an error message.
 */
import type { ArtifactServiceFailureClass } from './json';

export function mapRegistryFailure(reason: string): ArtifactServiceFailureClass {
  const lower = reason.toLowerCase();
  if (lower.includes('unauthorized') || lower.includes('forbidden') || lower.includes('credentials')) {
    return 'credential_failure';
  }
  if (lower.includes('ambiguous') || lower.includes('multiple') || lower.includes('confirmed')) {
    return 'platform_ambiguity';
  }
  if (lower.includes('malformed') || lower.includes('no digest')) {
    return 'digest_unavailable';
  }
  return 'registry_unavailable';
}
