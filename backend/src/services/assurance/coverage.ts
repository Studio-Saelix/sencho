/**
 * Evidence coverage: which checks actually ran, and why the others did not.
 *
 * Every registry entry declares the evidence it needs. The runner checks the
 * declarations before calling a rule and records each skip with the missing
 * evidence, so a run that could not read the node snapshot, the env files, or
 * the exposure intent reports partial coverage instead of a clean pass.
 *
 * Rules keep their own internal guards (defense in depth). A test drops each
 * evidence source from a maximal fixture and asserts that every rule which lost
 * findings declares that requirement, which keeps the declarations and the
 * guards from drifting apart.
 *
 * `state` is `complete` only when every active verdict-affecting rule either ran
 * or was not applicable. A skipped note rule is listed but does not flip it.
 * `unrecorded` means the run predates coverage (or came from an older node).
 */
import type { PreflightContext, RuleHit } from '../preflight/types';
import { PREFLIGHT_RULES } from '../preflight/rules';
import type {
  AssuranceCoverage, AssuranceCoverageSkip, AssuranceRule, EvidenceRequirement,
} from './types';
import { COMPOSE_DOCTOR_RULES } from './ruleRegistry';

export type { AssuranceCoverage, AssuranceCoverageSkip } from './types';

export interface AssuranceRun {
  findings: RuleHit[];
  coverage: AssuranceCoverage;
}

export function hasEvidence(ctx: PreflightContext, requirement: EvidenceRequirement): boolean {
  switch (requirement) {
    case 'source':
      return ctx.sourceReadable;
    case 'effective-model':
      return ctx.model !== null;
    case 'env-context':
      return ctx.envContextAvailable;
    case 'node-state':
      return ctx.nodeStateAvailable;
    case 'exposure-context':
      return ctx.exposureAvailable;
    case 'compose-version':
      return ctx.composeVersionSkew !== null;
  }
}

export function missingEvidence(rule: AssuranceRule, ctx: PreflightContext): EvidenceRequirement[] {
  return rule.requires.filter(requirement => !hasEvidence(ctx, requirement));
}

export function isNotApplicable(rule: AssuranceRule, ctx: PreflightContext): boolean {
  return rule.platforms === 'posix' && ctx.platform === 'win32';
}

const RUNNERS = new Map(PREFLIGHT_RULES.map(rule => [rule.id, rule]));

/**
 * Run every active rule whose declared evidence is present, and record what did
 * not run. The returned findings are identical to running every rule, because a
 * rule whose evidence is missing returns nothing on its own guard.
 */
export function runAssuranceRules(ctx: PreflightContext): AssuranceRun {
  const findings: RuleHit[] = [];
  const skipped: AssuranceCoverageSkip[] = [];
  let evaluated = 0;
  let notApplicable = 0;

  for (const rule of COMPOSE_DOCTOR_RULES) {
    const runner = RUNNERS.get(rule.id);
    if (!runner) continue;
    if (isNotApplicable(rule, ctx)) {
      notApplicable++;
      continue;
    }
    const missing = missingEvidence(rule, ctx);
    if (missing.length > 0) {
      skipped.push({ ruleId: rule.id, missing, affectsVerdict: rule.affectsVerdict });
      continue;
    }
    findings.push(...runner.run(ctx));
    evaluated++;
  }

  return {
    findings,
    coverage: {
      state: skipped.some(entry => entry.affectsVerdict) ? 'partial' : 'complete',
      evaluated,
      notApplicable,
      skipped,
    },
  };
}

/** Human-readable name for a missing evidence source, used in readiness detail. */
export const REQUIREMENT_LABEL: Record<EvidenceRequirement, string> = {
  source: 'compose file unreadable',
  'effective-model': 'rendered model unavailable',
  'env-context': 'env files unreadable',
  'node-state': 'node state unavailable',
  'exposure-context': 'exposure settings unreadable',
  'compose-version': 'Compose version unknown',
};

/** Said for a run that is not complete and whose list names no verdict-affecting check. */
const UNNAMED_GAP = '1 or more checks could not run';

/**
 * What did not run, in one clause, or null when every verdict-affecting check
 * ran (or the run recorded no coverage, which callers report on their own). Note
 * rules are excluded: they never change the verdict.
 *
 * The input is not trusted to match its type, because a caller can skip
 * `parseCoverage` and a node on another build can send another shape. A
 * `skipped` that is not a list, an entry that is not an object, a `missing` that
 * is not a list, and a requirement that is not a known name each degrade to
 * fewer reasons or a bare count instead of a throw or `undefined` in operator
 * copy. A run that is not `complete` and whose list names no verdict-affecting
 * skip still says that something did not run: unreadable detail, or a state this
 * build does not know, never turns into "all ran".
 * Frontend `coverageGapLine` applies the same rules and adds a full stop.
 */
export function describeCoverageGaps(coverage: AssuranceCoverage | null | undefined): string | null {
  if (!coverage || coverage.state === 'unrecorded') return null;
  const entries: readonly AssuranceCoverageSkip[] = Array.isArray(coverage.skipped) ? coverage.skipped : [];
  const skipped = entries.filter(entry => entry?.affectsVerdict === true);
  if (skipped.length === 0) return coverage.state === 'complete' ? null : UNNAMED_GAP;
  const reasons = [...new Set(skipped.flatMap(entry => {
    const missing: readonly unknown[] = Array.isArray(entry.missing) ? entry.missing : [];
    return missing.flatMap(requirement =>
      typeof requirement === 'string' && Object.hasOwn(REQUIREMENT_LABEL, requirement)
        ? [REQUIREMENT_LABEL[requirement as EvidenceRequirement]]
        : []);
  }))];
  const count = `${skipped.length} check${skipped.length === 1 ? '' : 's'} could not run`;
  return reasons.length > 0 ? `${count}: ${reasons.join(', ')}` : count;
}

/** Coverage for a run stored before coverage existed, or from an older node. */
export function unrecordedCoverage(): AssuranceCoverage {
  return { state: 'unrecorded', evaluated: 0, notApplicable: 0, skipped: [] };
}

const SKIP_STATES: ReadonlySet<string> = new Set(['complete', 'partial', 'unrecorded']);

/** Parse the stored coverage JSON, degrading to unrecorded on anything unexpected. */
export function parseCoverage(json: string | null | undefined): AssuranceCoverage {
  if (!json) return unrecordedCoverage();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return unrecordedCoverage();
  }
  if (typeof parsed !== 'object' || parsed === null) return unrecordedCoverage();
  const candidate = parsed as Partial<AssuranceCoverage>;
  if (typeof candidate.state !== 'string' || !SKIP_STATES.has(candidate.state)) return unrecordedCoverage();
  const skipped = Array.isArray(candidate.skipped)
    ? candidate.skipped
      .filter((entry): entry is AssuranceCoverageSkip =>
        typeof entry === 'object' && entry !== null
        && typeof (entry as AssuranceCoverageSkip).ruleId === 'string'
        && Array.isArray((entry as AssuranceCoverageSkip).missing)
        && typeof (entry as AssuranceCoverageSkip).affectsVerdict === 'boolean')
      .map(entry => ({
        ruleId: entry.ruleId,
        missing: entry.missing.filter((requirement): requirement is EvidenceRequirement => typeof requirement === 'string'),
        affectsVerdict: entry.affectsVerdict,
      }))
    : [];
  return {
    state: candidate.state,
    evaluated: typeof candidate.evaluated === 'number' ? candidate.evaluated : 0,
    notApplicable: typeof candidate.notApplicable === 'number' ? candidate.notApplicable : 0,
    skipped,
  };
}
