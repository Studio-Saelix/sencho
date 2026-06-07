/**
 * Trigger a browser download of in-memory text as a file, using the standard
 * object-URL + anchor-click idiom (the same pattern used elsewhere for exports,
 * e.g. AuditLogView). Suited to client-side text such as a Markdown export.
 */
export function downloadTextFile(filename: string, text: string, mime = 'text/markdown'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
