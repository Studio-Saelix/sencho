/**
 * Map an overlay stack name (bare name or filename) to the key used in
 * `stackActionMap` / stack file lists. The map is filename-keyed (e.g. `web.yml`);
 * overlay state often holds the bare name (`web`).
 */
export function resolveStackFileKey(files: string[], name: string): string {
  return (
    files.find(
      (f) => f === name || f.replace(/\.(yml|yaml)$/, '') === name,
    ) ?? name
  );
}
