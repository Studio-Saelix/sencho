// Tone palette shared by the Fleet Actions cards. The two cards live as
// siblings under `cards/`, so the lookup tables sit next to them rather than
// hoisting to a global tokens module.

export type AccentTone = 'rose' | 'purple';

export const TONE_RAIL: Record<AccentTone, string> = {
  rose: 'bg-[var(--label-rose)]',
  purple: 'bg-[var(--label-purple)]',
};

export const TONE_BG: Record<AccentTone, string> = {
  rose: 'bg-[var(--label-rose-bg)] text-[var(--label-rose)]',
  purple: 'bg-[var(--label-purple-bg)] text-[var(--label-purple)]',
};
