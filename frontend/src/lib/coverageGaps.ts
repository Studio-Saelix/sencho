/**
 * Evidence coverage as the Compose Doctor tab shows it. The labels mirror
 * backend `REQUIREMENT_LABEL`, and the sentence is the backend
 * `describeCoverageGaps` clause plus a full stop (assurance/coverage.ts). A
 * backend test loads this module and fails when they drift, so the Doctor tab
 * and the update-readiness dialog name a missing evidence source the same way.
 *
 * Keep this file free of imports: the backend test loads it by path, where the
 * `@/` alias does not resolve.
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
  // A node on another build may send a shape this one does not expect, so an
  // entry that is not what the type says is skipped instead of thrown on.
  const skipped = (Array.isArray(coverage.skipped) ? coverage.skipped : [])
    .filter(entry => entry?.affectsVerdict === true);
  if (skipped.length === 0) return null;
  const reasons = [...new Set(skipped.flatMap(entry =>
    (Array.isArray(entry.missing) ? entry.missing : []).flatMap(requirement =>
      Object.hasOwn(REQUIREMENT_LABEL, requirement) ? [REQUIREMENT_LABEL[requirement]] : [])))];
  const count = `${skipped.length} check${skipped.length === 1 ? '' : 's'} could not run`;
  return reasons.length > 0 ? `${count}: ${reasons.join(', ')}.` : `${count}.`;
}
