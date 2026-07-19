/** Client mirror of backend validateStackPatternForRedos. */
export function validateStackPatternClient(pattern: string): string | null {
  if (pattern.length > 200) return 'Pattern is too long (max 200 characters)';
  const stars = (pattern.match(/\*/g) ?? []).length;
  if (stars > 8) return 'Pattern has too many wildcards (max 8)';
  if (/\*{4,}/.test(pattern)) return 'Pattern must not contain 4+ consecutive wildcards';
  return null;
}
