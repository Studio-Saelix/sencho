/**
 * Persist a service URL, then show the patched compose text in the editor.
 * The buffer changes only after the write is accepted, so a refused save
 * cannot leave an abandoned URL for a later Save to persist.
 */
export async function commitServiceUrlWrite<T extends { ok: boolean }>(
  patched: string,
  save: () => Promise<T>,
  applyContent: (content: string) => void,
): Promise<T> {
  const result = await save();
  if (result.ok) applyContent(patched);
  return result;
}
