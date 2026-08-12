import type { MastheadTone } from '@/components/ui/PageMasthead';
import type { SecurityOverview, SecurityPostureState } from '@/types/security';

export type SecurityPosture = SecurityPostureState;

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
 * decide the headline alone.
 *
 * Prefer backend `overview.posture` (Secure requires cleared residual Crit/High
 * and review conditions; accepting residual risk stays Monitoring). The local
 * bootstrap below is only for older remotes that omit posture: actionable is
 * approximated from fixable/secrets/misconfigs; Unknown covers a missing
 * scanner or never-scanned node.
 */
export function deriveMasthead(
  overview: SecurityOverview | null,
  error: boolean,
): { state: SecurityPosture; tone: MastheadTone } {
  const posture = resolvePosture(overview, error);
  return { state: posture, tone: POSTURE_TONE[posture] };
}

function resolvePosture(overview: SecurityOverview | null, error: boolean): SecurityPosture {
  if (error || !overview) return 'Unknown';
  if (overview.posture && overview.posture in POSTURE_TONE) return overview.posture;
  if (!overview.scanner.available || overview.lastSuccessfulScanAt === null) return 'Unknown';
  if (overview.fixable > 0 || overview.secrets > 0 || overview.misconfigs > 0) return 'Action needed';
  if (overview.critical > 0 || overview.high > 0) return 'Monitoring';
  return 'Secure';
}
