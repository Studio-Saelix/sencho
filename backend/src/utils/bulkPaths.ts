/**
 * Normalization for bulk file-operation selections (delete / move / download).
 *
 * A client (or a direct API caller) can submit overlapping paths, e.g. both a
 * directory and a file inside it, or the same path twice. Acting on both would
 * double-process a file, duplicate an archive entry, or report spurious
 * per-item failures, so the route normalizes the selection before acting on it:
 * it dedupes and drops any path whose ancestor is also selected.
 *
 * Case-awareness is per root, not global. Filesystem roots on a case-insensitive
 * host (Windows/macOS) fold case so `Foo` and `foo` collapse; Linux filesystem
 * roots and helper-backed (named-volume) roots are case-sensitive, so `Foo` and
 * `foo` are distinct and both survive. The caller passes `caseSensitive` derived
 * from the root.
 */
export function normalizeBulkPaths(paths: string[], caseSensitive: boolean): string[] {
  const key = (p: string): string => (caseSensitive ? p : p.toLowerCase());

  // Dedupe by key, keeping the first spelling seen.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const p of paths) {
    const k = key(p);
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(p);
    }
  }

  // Drop any path that has a selected ancestor. The check is key-based so a
  // case-insensitive root treats `Foo` as the ancestor of `foo/bar`.
  const keys = new Set(unique.map(key));
  return unique.filter((p) => {
    const segments = key(p).split('/');
    for (let i = 1; i < segments.length; i++) {
      if (keys.has(segments.slice(0, i).join('/'))) return false;
    }
    return true;
  });
}

/**
 * True when `dir` (a normalized rel path, '' = root) is equal to or inside any
 * of the `sources` directories. Used to reject a bulk move whose destination is
 * one of the moved folders or a descendant of one.
 */
export function destWithinAnySource(dir: string, sources: string[], caseSensitive: boolean): boolean {
  const key = (p: string): string => (caseSensitive ? p : p.toLowerCase());
  const dirKey = key(dir);
  return sources.some((s) => {
    const sourceKey = key(s);
    return dirKey === sourceKey || dirKey.startsWith(`${sourceKey}/`);
  });
}
