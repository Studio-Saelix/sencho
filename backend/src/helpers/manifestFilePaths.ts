/**
 * Shared enumeration of stack-relative files owned by a managed-project
 * manifest. Used by Git promotion and by authored-project rollback capture so
 * the two cannot drift on which paths belong to a generation.
 */
import type { GitProjectManifest } from '../types/gitProjectManifest';

/** Exact file paths owned by one manifest, excluding directory-only inventory entries. */
export function collectManifestFilePaths(
  manifest: Pick<GitProjectManifest, 'inputs' | 'buildContexts'>,
): string[] {
  const paths = new Map<string, string>();
  for (const entry of manifest.inputs) {
    if (entry.ownership !== 'managed' || entry.state !== 'present' || entry.materializedPath === null) continue;
    if (entry.dependencyKind === 'build-context' || entry.dependencyKind === 'build-additional-context') continue;
    paths.set(entry.materializedPath.toLowerCase(), entry.materializedPath);
  }
  for (const context of manifest.buildContexts) {
    for (const file of context.files) {
      const rel = context.repoPath ? `${context.repoPath}/${file.path}` : file.path;
      paths.set(rel.toLowerCase(), rel);
    }
  }
  return [...paths.values()].sort((a, b) => a.localeCompare(b));
}
