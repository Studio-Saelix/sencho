import type { TriageJustification, TriageStatus } from '@/types/security';

export const TRIAGE_STATUS_OPTIONS: ReadonlyArray<{ value: TriageStatus; label: string }> = [
  { value: 'accepted', label: 'Accepted risk' },
  { value: 'not_affected', label: 'Not affected' },
  { value: 'false_positive', label: 'False positive' },
  { value: 'affected', label: 'Affected' },
  { value: 'needs_review', label: 'Needs review' },
  { value: 'fixed', label: 'Fixed' },
  { value: 'ignored', label: 'Ignored until expiry' },
];

export const TRIAGE_JUSTIFICATION_OPTIONS: ReadonlyArray<{ value: TriageJustification; label: string }> = [
  { value: 'vulnerable_code_not_present', label: 'Vulnerable code not present' },
  { value: 'vulnerable_code_not_in_execute_path', label: 'Vulnerable code not in execute path' },
  { value: 'component_not_present', label: 'Component not present' },
  { value: 'inline_mitigations_already_exist', label: 'Inline mitigations already exist' },
];

export const TRIAGE_STATUS_HINT =
  'How this finding was triaged. Decided states (accepted, not affected, false positive, fixed, ignored) stop driving the posture; needs review and affected stay counted but actionable.';

/** True when OpenVEX export needs a justification code for this triage status. */
export function openVexRequiresJustification(status: TriageStatus): boolean {
  return status === 'not_affected' || status === 'false_positive';
}

/** Keep the current justification only when the new status still requires one. */
export function justificationForStatus(status: TriageStatus, justification: string): string {
  return openVexRequiresJustification(status) ? justification : '';
}

export function triageStatusLabel(status: TriageStatus | undefined): string {
  if (!status) return 'Accepted risk';
  return TRIAGE_STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status;
}

export function triageJustificationLabel(
  justification: TriageJustification | null | undefined,
): string | null {
  if (!justification) return null;
  return TRIAGE_JUSTIFICATION_OPTIONS.find((o) => o.value === justification)?.label ?? justification;
}
