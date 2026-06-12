import type { MastheadTone } from '@/components/ui/PageMasthead';
import type { SecurityOverview } from '@/types/security';

/**
 * Derives the Security page masthead state word and tone from the overview.
 * Critical outranks High; an absent overview or a load error reads as Unknown.
 */
export function deriveMasthead(
  overview: SecurityOverview | null,
  error: boolean,
): { state: string; tone: MastheadTone } {
  if (error || !overview) return { state: 'Unknown', tone: 'idle' };
  if (overview.critical > 0) return { state: 'Critical', tone: 'error' };
  if (overview.high > 0) return { state: 'At risk', tone: 'warn' };
  return { state: 'Secure', tone: 'live' };
}
