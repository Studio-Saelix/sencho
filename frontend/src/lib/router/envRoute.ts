import type { EditorTab } from './routeTypes';

/** Leaf name of an env file path (handles Windows separators). */
export function envFileBasename(file: string): string {
  const normalized = file.replace(/\\/g, '/');
  const leaf = normalized.slice(normalized.lastIndexOf('/') + 1);
  return leaf || file;
}

/** Map a URL env token (basename or legacy absolute path) to a full env file path. */
export function resolveEnvFilePath(requested: string | null, envFiles: string[]): string | null {
  if (!requested || envFiles.length === 0) return null;
  if (envFiles.includes(requested)) return requested;
  const want = envFileBasename(requested);
  if (!want) return null;
  return envFiles.find((f) => envFileBasename(f) === want) ?? null;
}

/** Env query value for the URL: basename only, omitted when the default file is selected. */
export function envFileForRouteUrl(
  selectedEnvFile: string,
  envFiles: string[],
  activeTab: EditorTab,
): string | null {
  if (activeTab !== 'env' || !selectedEnvFile) return null;
  const first = envFiles[0];
  if (first && selectedEnvFile === first) return null;
  const basename = envFileBasename(selectedEnvFile);
  if (!basename || basename.includes('/')) return null;
  return basename;
}

/** Normalize a parsed env query to a basename (backward compat for bookmarked absolute paths). */
export function normalizeEnvFileQuery(raw: string | null): string | null {
  if (!raw) return null;
  const basename = envFileBasename(raw);
  if (!basename || basename.length > 256) return null;
  return basename;
}
