/** Tooltip / badge copy naming outdated services when the breakdown is known. */
export function updateAvailableLabel(outdatedServices?: string[]): string {
  const names = (outdatedServices ?? []).filter(Boolean);
  if (names.length === 0) return 'Update available';
  if (names.length === 1) return `Update available: ${names[0]}`;
  if (names.length <= 3) return `Update available: ${names.join(', ')}`;
  return `Update available: ${names.length} services`;
}
