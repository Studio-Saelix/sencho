/**
 * A short identity with the full value in the tooltip; the short form is enough
 * to compare at a glance. Shared by the GitOps identity rows and the rollout
 * preview so every surface truncates the same way.
 */
export function ShortId({ value, length = 8 }: { value: string | null; length?: number }) {
  if (value === null) return <span className="text-stat-icon">none</span>;
  return <span title={value}>{value.slice(0, length)}</span>;
}
