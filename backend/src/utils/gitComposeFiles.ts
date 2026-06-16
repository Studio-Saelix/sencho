/**
 * The local filename Sencho always writes a Git source's primary compose file
 * to, at the stack root. Keeping the primary at this fixed root name preserves
 * stack discovery (FileSystemService.getStacks / hasComposeFile) and the editor's
 * compose tab, and matches single-file behavior where the fetched file is written
 * to compose.yaml regardless of its repo name.
 */
export const PRIMARY_COMPOSE_FILENAME = 'compose.yaml';

/**
 * Map an ordered list of repo-relative compose paths to the ordered local
 * relative filenames Sencho materializes for them under the stack directory:
 *   - index 0 (primary)      -> compose.yaml at the stack root
 *   - every additional file  -> its repo-relative path, preserved under the stack dir
 *
 * The result is the deploy-time `applied_deploy_spec.files` list, also used to
 * write the files to disk. Repo paths are already validated as POSIX relative
 * paths upstream (isValidGitSourcePath), so they are used as-is for additional
 * files; only a leading "./" is stripped for a clean on-disk layout.
 */
export function gitSourceLocalComposeFiles(composePaths: string[]): string[] {
  return composePaths.map((p, index) =>
    index === 0 ? PRIMARY_COMPOSE_FILENAME : p.replace(/^\.\//, ''),
  );
}
