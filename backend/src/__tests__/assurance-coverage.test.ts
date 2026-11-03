/**
 * Evidence coverage: every active rule fires on a maximal fixture, the
 * declarations match the rules' own guards, and the coverage state tells the
 * truth about what ran.
 */
import path from 'path';
import { describe, it, expect } from 'vitest';
import { runRules } from '../services/preflight/rules';
import {
  runAssuranceRules, describeCoverageGaps, parseCoverage, REQUIREMENT_LABEL,
} from '../services/assurance/coverage';
import { COMPOSE_DOCTOR_RULES, getAssuranceRule } from '../services/assurance/ruleRegistry';
import { EVIDENCE_REQUIREMENTS } from '../services/assurance/types';
import type { PreflightContext } from '../services/preflight/types';
import {
  maximalContext, degradedNodeStateContext, unrenderableContext, dossierContext, dropEvidence,
} from './helpers/assuranceFixture';

/** Rule ids that produced at least one finding, run without the coverage gate. */
function firedRuleIds(ctx: PreflightContext): Set<string> {
  return new Set(runRules(ctx).map(hit => hit.ruleId));
}

const fired = (ctx: PreflightContext, ruleId: string) => firedRuleIds(ctx).has(ruleId);

/** Rules that cannot coexist with the maximal fixture (see the helper docs). */
const VARIANT_ONLY = ['render-failed', 'node-state-unavailable', 'exposure-port-vs-dossier'];

describe('maximal fixture', () => {
  it('fires every active rule that can fire in one context', () => {
    const expected = COMPOSE_DOCTOR_RULES.filter(rule => !VARIANT_ONLY.includes(rule.id)).map(rule => rule.id);
    expect([...firedRuleIds(maximalContext())].sort()).toEqual(expected.sort());
  });

  it('fires render-failed in the unrenderable variant', () => {
    expect(fired(unrenderableContext(), 'render-failed')).toBe(true);
  });

  it('fires node-state-unavailable only when the snapshot is missing', () => {
    expect(fired(degradedNodeStateContext(), 'node-state-unavailable')).toBe(true);
    expect(fired(maximalContext(), 'node-state-unavailable')).toBe(false);
  });

  it('fires exposure-port-vs-dossier only when access URLs are documented', () => {
    expect(fired(dossierContext(), 'exposure-port-vs-dossier')).toBe(true);
    expect(fired(dossierContext(), 'reverse-proxy-undocumented')).toBe(false);
    expect(fired(maximalContext(), 'reverse-proxy-undocumented')).toBe(true);
  });
});

describe('evidence declarations match the guards', () => {
  it('every rule that lost findings from a dropped source declares that requirement', () => {
    for (const base of [maximalContext(), dossierContext()]) {
      const full = firedRuleIds(base);
      for (const requirement of EVIDENCE_REQUIREMENTS) {
        const dropped = firedRuleIds(dropEvidence(base, requirement));
        const lost = [...full].filter(ruleId => !dropped.has(ruleId));
        for (const ruleId of lost) {
          const rule = getAssuranceRule(ruleId);
          expect(rule, `${ruleId} is missing from the registry`).toBeDefined();
          expect(
            rule?.requires,
            `${ruleId} loses findings without ${requirement}, but does not declare it`,
          ).toContain(requirement);
        }
      }
    }
  });

  it('the runner gate changes no output', () => {
    for (const requirement of EVIDENCE_REQUIREMENTS) {
      const ctx = dropEvidence(maximalContext(), requirement);
      expect(runAssuranceRules(ctx).findings).toEqual(runRules(ctx));
    }
    expect(runAssuranceRules(maximalContext()).findings).toEqual(runRules(maximalContext()));
  });
});

describe('coverage state', () => {
  it('is complete when every verdict-affecting check ran', () => {
    const { coverage } = runAssuranceRules(maximalContext());
    expect(coverage.state).toBe('complete');
    expect(coverage.skipped).toEqual([]);
    expect(coverage.evaluated).toBe(COMPOSE_DOCTOR_RULES.length);
    expect(coverage.notApplicable).toBe(0);
  });

  it.each(['node-state', 'env-context', 'exposure-context', 'effective-model'] as const)(
    'is partial when %s is missing',
    requirement => {
      const { coverage } = runAssuranceRules(dropEvidence(maximalContext(), requirement));
      expect(coverage.state).toBe('partial');
      const missing = new Set(coverage.skipped.flatMap(entry => entry.missing));
      expect(missing.has(requirement)).toBe(true);
      expect(coverage.skipped.some(entry => entry.affectsVerdict)).toBe(true);
    },
  );

  it('is partial when the source could not be read', () => {
    const { coverage } = runAssuranceRules(dropEvidence(maximalContext(), 'source'));
    expect(coverage.state).toBe('partial');
    const skipped = coverage.skipped.find(entry => entry.ruleId === 'effective-model-expanded');
    expect(skipped?.missing).toEqual(['source']);
  });

  it('lists a skipped note rule without flipping the state', () => {
    const { coverage } = runAssuranceRules(dropEvidence(maximalContext(), 'compose-version'));
    // compose-version-mismatch is the only rule that needs the Compose version,
    // and it is a note, so nothing verdict-affecting was skipped.
    expect(coverage.skipped.map(entry => entry.ruleId)).toEqual(['compose-version-mismatch']);
    expect(coverage.skipped[0].affectsVerdict).toBe(false);
    expect(coverage.state).toBe('complete');
  });

  it('counts POSIX-only rules as not applicable on win32 instead of partial', () => {
    const { coverage } = runAssuranceRules(maximalContext({ platform: 'win32' }));
    expect(coverage.notApplicable).toBe(1);
    expect(coverage.skipped).toEqual([]);
    expect(coverage.state).toBe('complete');
    expect(coverage.evaluated).toBe(COMPOSE_DOCTOR_RULES.length - 1);
  });
});

describe('coverage gap copy', () => {
  it('names the missing evidence when it can', () => {
    const { coverage } = runAssuranceRules(dropEvidence(maximalContext(), 'node-state'));
    expect(describeCoverageGaps(coverage)).toContain('node state unavailable');
  });

  it('degrades to a count when a stored requirement name is unknown', () => {
    const coverage = parseCoverage(JSON.stringify({
      state: 'partial',
      evaluated: 10,
      notApplicable: 0,
      skipped: [{ ruleId: 'privileged', missing: ['a-requirement-from-a-newer-build'], affectsVerdict: true }],
    }));
    expect(describeCoverageGaps(coverage)).toBe('1 check could not run');
  });

  it('says nothing when only note rules were skipped', () => {
    const { coverage } = runAssuranceRules(dropEvidence(maximalContext(), 'compose-version'));
    expect(describeCoverageGaps(coverage)).toBeNull();
  });
});

describe('frontend coverage copy', () => {
  // The Doctor tab words the same gaps the readiness dialog does. The frontend
  // module is a pure TypeScript file, so it is loaded here and compared by value.
  const frontendModule = path.resolve(__dirname, '../../../frontend/src/lib/coverageGaps.ts');
  type FrontendCoverage = {
    REQUIREMENT_LABEL: Record<string, string>;
    coverageGapLine: (coverage: ReturnType<typeof parseCoverage> | undefined) => string | null;
  };
  // The module must stay import-free: the `@/` alias does not resolve here.
  const load = () => import(/* @vite-ignore */ frontendModule) as Promise<FrontendCoverage>;

  it('names every evidence source exactly as the backend does', async () => {
    const frontend = await load();
    expect(frontend.REQUIREMENT_LABEL).toEqual(REQUIREMENT_LABEL);
    expect(Object.keys(REQUIREMENT_LABEL).sort()).toEqual([...EVIDENCE_REQUIREMENTS].sort());
  });

  it('words a coverage gap as the backend clause plus a full stop', async () => {
    const frontend = await load();
    for (const requirement of EVIDENCE_REQUIREMENTS) {
      const { coverage } = runAssuranceRules(dropEvidence(maximalContext(), requirement));
      const clause = describeCoverageGaps(coverage);
      expect(frontend.coverageGapLine(coverage), requirement).toBe(clause === null ? null : `${clause}.`);
    }
    const everything = runAssuranceRules(dropEvidence(dropEvidence(maximalContext(), 'node-state'), 'env-context'));
    expect(frontend.coverageGapLine(everything.coverage)).toBe(`${describeCoverageGaps(everything.coverage)}.`);
  });

  it('words every coverage state like the backend', async () => {
    const frontend = await load();
    const skipped = [{ ruleId: 'privileged', missing: ['node-state'], affectsVerdict: true }];
    for (const state of ['complete', 'partial', 'unrecorded'] as const) {
      const coverage = parseCoverage(JSON.stringify({ state, evaluated: 10, notApplicable: 0, skipped }));
      const clause = state === 'unrecorded' ? null : describeCoverageGaps(coverage);
      expect(frontend.coverageGapLine(coverage), state).toBe(clause === null ? null : `${clause}.`);
    }
    expect(frontend.coverageGapLine(undefined)).toBeNull();
  });

  it('does not throw on a coverage shape from another build, and ignores inherited keys', async () => {
    const frontend = await load();
    const odd = (skipped: unknown) => ({ state: 'partial', evaluated: 1, notApplicable: 0, skipped }) as never;
    expect(frontend.coverageGapLine(odd('not-a-list'))).toBe('1 or more checks could not run.');
    expect(frontend.coverageGapLine(odd([null, { affectsVerdict: true, missing: 'node-state' }])))
      .toBe('1 check could not run.');
    const inherited = { ruleId: 'privileged', missing: ['constructor', 'toString'], affectsVerdict: true };
    expect(frontend.coverageGapLine(odd([inherited]))).toBe('1 check could not run.');
    expect(describeCoverageGaps(odd([inherited]))).toBe('1 check could not run');
  });

  it('words every malformed shape the same on both sides, and neither throws', async () => {
    const frontend = await load();
    const entry = (over: Record<string, unknown>) => ({ ruleId: 'privileged', missing: ['node-state'], affectsVerdict: true, ...over });
    // Each shape is stated as an absolute clause: a regression made on both
    // sides at once must still fail here.
    const NONE = '1 or more checks could not run';
    const shapes: Record<string, [skipped: unknown, clause: string]> = {
      'skipped is not a list': ['not-a-list', NONE],
      'skipped is missing': [undefined, NONE],
      'skipped is null': [null, NONE],
      'an entry is null': [[null], NONE],
      'an entry is a string': [['node-state'], NONE],
      'missing is a string': [[entry({ missing: 'node-state' })], '1 check could not run'],
      'missing is absent': [[entry({ missing: undefined })], '1 check could not run'],
      'missing holds a non-string': [[entry({ missing: [7, null, ['node-state'], 'node-state'] })], '1 check could not run: node state unavailable'],
      'affectsVerdict is truthy but not true': [[entry({ affectsVerdict: 'yes' }), entry({ affectsVerdict: 1 })], NONE],
      'one valid entry among bad ones': [[null, 'x', entry({})], '1 check could not run: node state unavailable'],
    };
    const shaped = (state: string, skipped: unknown) => ({ state, evaluated: 1, notApplicable: 0, skipped }) as never;
    for (const [name, [skipped, clause]] of Object.entries(shapes)) {
      expect(describeCoverageGaps(shaped('partial', skipped)), name).toBe(clause);
      expect(frontend.coverageGapLine(shaped('partial', skipped)), name).toBe(`${clause}.`);
      // A complete run keeps naming a verdict-affecting skip it can read, but
      // owes nothing when the list names none.
      const complete = clause === NONE ? null : clause;
      expect(describeCoverageGaps(shaped('complete', skipped)), `${name} (complete)`).toBe(complete);
      expect(frontend.coverageGapLine(shaped('complete', skipped)), `${name} (complete)`)
        .toBe(complete === null ? null : `${complete}.`);
    }
    // A skip that does not affect the verdict is not a gap on a complete run.
    const noteOnly = shaped('complete', [entry({ affectsVerdict: false })]);
    expect(describeCoverageGaps(noteOnly)).toBeNull();
    expect(frontend.coverageGapLine(noteOnly)).toBeNull();
  });

  it('says nothing for unrecorded or absent coverage on both sides, whatever its list holds', async () => {
    const frontend = await load();
    const listed = { state: 'unrecorded', evaluated: 0, notApplicable: 0, skipped: [{ ruleId: 'privileged', missing: ['node-state'], affectsVerdict: true }] } as never;
    for (const coverage of [listed, undefined, null] as never[]) {
      expect(describeCoverageGaps(coverage)).toBeNull();
      expect(frontend.coverageGapLine(coverage)).toBeNull();
    }
  });

  it('degrades an unknown requirement to a count like the backend', async () => {
    const frontend = await load();
    const coverage = parseCoverage(JSON.stringify({
      state: 'partial', evaluated: 10, notApplicable: 0,
      skipped: [{ ruleId: 'privileged', missing: ['a-requirement-from-a-newer-build'], affectsVerdict: true }],
    }));
    expect(frontend.coverageGapLine(coverage)).toBe(`${describeCoverageGaps(coverage)}.`);
  });
});
