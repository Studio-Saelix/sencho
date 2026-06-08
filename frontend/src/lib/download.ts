/**
 * Trigger a browser download of in-memory text as a file, using the standard
 * object-URL + anchor-click idiom (the same pattern used elsewhere for exports,
 * e.g. AuditLogView). Suited to client-side text such as a Markdown export.
 */
export function downloadTextFile(filename: string, text: string, mime = 'text/markdown'): void {
  downloadBlob(filename, new Blob([text], { type: `${mime};charset=utf-8` }));
}

/**
 * Trigger a browser download of an in-memory Blob (e.g. a zip archive built
 * client-side). Same object-URL + anchor-click idiom as {@link downloadTextFile}.
 */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
