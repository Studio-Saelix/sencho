import type { MastheadTone } from '@/components/ui/PageMasthead';
import type { SecurityOverview } from '@/types/security';

export type SecurityPosture = 'Action needed' | 'Monitoring' | 'Secure' | 'Unknown';

const POSTURE_TONE: Record<SecurityPosture, MastheadTone> = {
  'Action needed': 'error',
  Monitoring: 'warn',
  Secure: 'live',
  Unknown: 'idle',
};

/** Standing reframe shown near the masthead: raw counts are scanner detections,
 *  not the product posture. Kept short enough for a one-to-two-line caption. */
export const SCANNER_DETECTIONS_NOTE =
  'Scanner detections show vulnerable components present in images, not proven exploitable risk. Posture weighs fix availability, exposure, and exploit intelligence.';

/**
 * Derives the Security masthead from action posture, not raw severity. Raw
 * Critical/High counts are scanner detections shown separately; they no longer
 * decide the headline. "Secure" means nothing is actionable right now, never a
 * claim that no vulnerabilities exist.
 *
 * Phase-1 bootstrap: "actionable" is approximated from the overview facts that
 * already exist (fixable findings, secrets, misconfigs). Unknown covers a
 * missing scanner or a node that has never completed a scan. A later phase moves
 * this bucketing to the backend and prefers an authoritative `posture`.
 */
export function deriveMasthead(
  overview: SecurityOverview | null,
  error: boolean,
): { state: SecurityPosture; tone: MastheadTone } {
  const posture = derivePosture(overview, error);
  return { state: posture, tone: POSTURE_TONE[posture] };
}

function derivePosture(overview: SecurityOverview | null, error: boolean): SecurityPosture {
  if (error || !overview) return 'Unknown';
  if (!overview.scanner.available || overview.lastSuccessfulScanAt === null) return 'Unknown';
  if (overview.fixable > 0 || overview.secrets > 0 || overview.misconfigs > 0) return 'Action needed';
  if (overview.critical > 0 || overview.high > 0) return 'Monitoring';
  return 'Secure';
}
