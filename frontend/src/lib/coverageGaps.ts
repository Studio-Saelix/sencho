/**
 * Evidence coverage as the Compose Doctor tab shows it. The labels and the
 * sentence mirror backend `REQUIREMENT_LABEL` and `describeCoverageGaps`
 * (assurance/coverage.ts); a backend test loads this module and fails when the
 * two drift, so the Doctor tab and the update-readiness dialog name a missing
 * evidence source the same way.
 */
export type EvidenceRequirement =
  | 'source'
  | 'effective-model'
  | 'env-context'
  | 'node-state'
  | 'exposure-context'
  | 'compose-version';

/** Which checks ran. A report from an older node omits it and reads as unrecorded. */
export interface AssuranceCoverage {
  state: 'complete' | 'partial' | 'unrecorded';
  evaluated: number;
  notApplicable: number;
  skipped: { ruleId: string; missing: EvidenceRequirement[]; affectsVerdict: boolean }[];
}

/** Human-readable name for a missing evidence source. */
export const REQUIREMENT_LABEL: Record<EvidenceRequirement, string> = {
  source: 'compose file unreadable',
  'effective-model': 'rendered model unavailable',
  'env-context': 'env files unreadable',
  'node-state': 'node state unavailable',
  'exposure-context': 'exposure settings unreadable',
  'compose-version': 'Compose version unknown',
};

/**
 * What did not run, in one clause, or null when every verdict-affecting check
 * ran. An older node omits `coverage` entirely, which reads as unrecorded.
 */
export function coverageGapLine(coverage: AssuranceCoverage | undefined): string | null {
  if (!coverage || coverage.state === 'unrecorded') return null;
  const skipped = (coverage.skipped ?? []).filter(entry => entry.affectsVerdict);
  if (skipped.length === 0) return null;
  const reasons = [...new Set(skipped.flatMap(entry =>
    (entry.missing ?? []).map(requirement => REQUIREMENT_LABEL[requirement]).filter(Boolean)))];
  if (reasons.length === 0) return `${skipped.length} check${skipped.length === 1 ? '' : 's'} could not run.`;
  return `${skipped.length} check${skipped.length === 1 ? '' : 's'} could not run: ${reasons.join(', ')}.`;
}
