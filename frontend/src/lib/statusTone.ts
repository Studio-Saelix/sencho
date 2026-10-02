/**
 * The five semantic slots every status surface speaks in, defined once.
 *
 * GitOps states, portfolio labels and the generic status primitive all use the
 * same set, so the union and the class maps live here and the domain modules
 * alias them. Fuchsia is reserved for image updates and never appears.
 */
export type StatusTone = 'brand' | 'success' | 'warning' | 'destructive' | 'neutral';

/** Tinted card classes per tone, identical to the drift status cards so the families read as one. */
export const STATUS_CARD_CLASS: Record<StatusTone, string> = {
  brand: 'border-brand/40 bg-brand/[0.06] text-brand',
  success: 'border-success/40 bg-success/[0.06] text-success',
  warning: 'border-warning/40 bg-warning/[0.06] text-warning',
  destructive: 'border-destructive/40 bg-destructive/[0.06] text-destructive',
  neutral: 'border-muted bg-card/40 text-stat-subtitle',
};

/** Solid dot per tone, for the quiet rows that carry a state without a tinted card. */
export const STATUS_DOT_CLASS: Record<StatusTone, string> = {
  brand: 'bg-brand',
  success: 'bg-success',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
  neutral: 'bg-stat-subtitle/50',
};
